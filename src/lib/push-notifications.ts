import webpush, { type PushSubscription, type RequestOptions } from "web-push";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "node:https";
import { lookup } from "node:dns/promises";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { SessionUser } from "@/lib/types";
import { UserFacingError } from "@/lib/user-facing-error";

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

export type PushDeliverySummary = {
  status: "sent" | "disabled" | "failed";
  targeted: number;
  sent: number;
  expired: number;
  failed: number;
};

type StoredPushSubscription = PushSubscription & { id: string };
export type PushSender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;
export class UnsafePushDestinationError extends UserFacingError {}

function assertStudent(actor: Pick<SessionUser, "role">) {
  if (actor.role !== "student") throw new UserFacingError("학생만 기기 알림을 설정할 수 있습니다.");
}

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224;
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89a-f]/.test(normalized) || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) return true;
  return false;
}

export function isSafePushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!hostname || hostname === "localhost") return false;
    if ([".localhost", ".local", ".internal", ".home", ".lan"].some((suffix) => hostname.endsWith(suffix))) return false;
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) return !isPrivateIpv4(hostname);
    if (ipVersion === 6) return !isPrivateIpv6(hostname);
    return hostname.includes(".");
  } catch {
    return false;
  }
}

export function assertSafePushEndpoint(endpoint: string) {
  if (!isSafePushEndpoint(endpoint)) throw new UnsafePushDestinationError("안전한 기기 알림 주소가 아닙니다.");
}

type AddressResolver = (hostname: string) => Promise<string[]>;

async function resolveAddresses(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address);
}

export async function assertSafePushDestination(endpoint: string, resolver: AddressResolver = resolveAddresses) {
  assertSafePushEndpoint(endpoint);
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(hostname)) return;
  // Reserved example domains are used only by isolated regression fixtures.
  if (resolver === resolveAddresses && process.env.NODE_ENV === "test" && (hostname === "example" || hostname.endsWith(".example"))) return;
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UserFacingError("기기 알림 주소를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!addresses.length) throw new UserFacingError("기기 알림 주소를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  if (addresses.some((address) => {
    const version = isIP(address);
    return version === 4 ? isPrivateIpv4(address) : version === 6 ? isPrivateIpv6(address) : true;
  })) {
    throw new UnsafePushDestinationError("안전한 기기 알림 주소가 아닙니다.");
  }
}

export function createSafePushAgent(endpoint: string, resolver: AddressResolver = resolveAddresses) {
  assertSafePushEndpoint(endpoint);
  const normalize = (host: string) => host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const expectedHost = normalize(new URL(endpoint).hostname);
  const guardedLookup: LookupFunction = (hostname, options, callback) => {
    void (async () => {
      if (normalize(hostname) !== expectedHost) throw new UnsafePushDestinationError("기기 알림 연결 대상이 변경되었습니다.");
      const addresses = await resolver(hostname);
      // Validate this exact DNS result and pass it directly to the socket. A
      // separate validation lookup would allow a second, unchecked DNS answer.
      await assertSafePushDestination(endpoint, async () => addresses);
      const family = Number(options.family) || 0;
      const candidates = addresses.map(address => ({ address, family: isIP(address) })).filter(row => !family || row.family === family);
      if (!candidates.length) throw new UserFacingError("기기 알림 연결 주소를 확인할 수 없습니다.");
      if (options.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    })().catch(error => callback(error instanceof Error ? error : new Error("기기 알림 연결 주소를 확인할 수 없습니다."), ""));
  };
  return new Agent({ keepAlive: false, maxSockets: 1, lookup: guardedLookup });
}

export function getPushPublicConfiguration() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  return { configured: Boolean(publicKey && privateKey && subject), publicKey };
}

export function getVapidDetails() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export async function savePushSubscription(
  actor: SessionUser,
  subscription: PushSubscriptionInput,
  userAgent = "",
) {
  assertStudent(actor);
  await assertSafePushDestination(subscription.endpoint);
  const db = await getDb();
  const existing = await db.query<{ user_id: string }>(
    "SELECT user_id FROM push_subscriptions WHERE endpoint = $1",
    [subscription.endpoint],
  );
  await db.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           failure_count = 0,
           updated_at = CURRENT_TIMESTAMP`,
    [createId("push"), actor.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent.slice(0, 500)],
  );
  if (existing.rows[0]?.user_id !== actor.id) {
    await audit(actor.id, "push_subscription_enabled", "user", actor.id, { rebound: Boolean(existing.rows[0]) });
  }
}

export async function removePushSubscription(actor: SessionUser, endpoint: string) {
  assertStudent(actor);
  const db = await getDb();
  const removed = await db.query(
    "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id",
    [actor.id, endpoint],
  );
  if (removed.rowCount) await audit(actor.id, "push_subscription_disabled", "user", actor.id);
}

async function getNoticeSubscriptions(noticeId: string) {
  const db = await getDb();
  const result = await db.query<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    kind: "announcement" | "action_request";
    priority: "normal" | "important";
    action_path: string | null;
  }>(
    `SELECT DISTINCT ps.id, ps.endpoint, ps.p256dh, ps.auth,
            n.kind, n.priority, n.action_path
       FROM notices n
         JOIN users u ON u.role = 'student' AND u.status = 'active' AND u.academic_year = $2 AND u.account_type = 'standard'
       JOIN push_subscriptions ps ON ps.user_id = u.id
       LEFT JOIN team_members tm
         ON tm.user_id = u.id AND tm.team_id = n.team_id AND tm.status = 'active'
       LEFT JOIN teams t ON t.id = n.team_id
      WHERE n.id = $1 AND n.status = 'active'
        AND (
          n.audience_type = 'all'
          OR (n.audience_type = 'class' AND u.class_id = n.class_id)
          OR (n.audience_type = 'team' AND tm.user_id IS NOT NULL AND t.status = 'active')
        )
      ORDER BY ps.id`,
    [noticeId, ACADEMIC_YEAR],
  );
  return result.rows;
}

function errorStatus(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return null;
}

function pushPayload(notice: { kind: "announcement" | "action_request"; priority: "normal" | "important"; action_path: string | null }, noticeId: string) {
  const important = notice.priority === "important";
  const body = notice.kind === "action_request"
    ? "확인하고 처리할 요청이 도착했습니다. 앱에서 내용을 확인하세요."
    : important
      ? "중요 공지가 도착했습니다. 앱에서 내용을 확인하세요."
      : "새 공지가 도착했습니다. 앱에서 내용을 확인하세요.";
  return JSON.stringify({
    body,
    url: notice.action_path || `/notices?notice=${encodeURIComponent(noticeId)}`,
    tag: `notice-${noticeId}`,
    renotify: important,
  });
}

async function deliverPushForNotice(noticeId: string, senderOverride?: PushSender): Promise<PushDeliverySummary> {
  const rows = await getNoticeSubscriptions(noticeId);
  if (!rows.length) return { status: "sent", targeted: 0, sent: 0, expired: 0, failed: 0 };

  const vapidDetails = getVapidDetails();
  if (!senderOverride && !vapidDetails) {
    return { status: "disabled", targeted: rows.length, sent: 0, expired: 0, failed: 0 };
  }

  const sender: PushSender = senderOverride ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  const db = await getDb();
  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (let offset = 0; offset < rows.length; offset += 20) {
    const batch = rows.slice(offset, offset + 20);
    await Promise.all(batch.map(async (row) => {
      try {
        await assertSafePushDestination(row.endpoint);
      } catch (error) {
        failed += 1;
        if (error instanceof UnsafePushDestinationError) await db.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
        return;
      }
      const subscription: StoredPushSubscription = {
        id: row.id,
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      const options: RequestOptions = {
        agent: createSafePushAgent(row.endpoint),
        TTL: row.priority === "important" ? 7 * 24 * 60 * 60 : 24 * 60 * 60,
        urgency: row.priority === "important" ? "high" : "normal",
        topic: noticeId.replace(/[^A-Za-z0-9_-]/g, "").slice(-32) || "science-inquiry-notice",
        ...(vapidDetails ? { vapidDetails } : {}),
      };
      try {
        await sender(subscription, pushPayload(row, noticeId), options);
        sent += 1;
        await db.query(
          "UPDATE push_subscriptions SET last_success_at = CURRENT_TIMESTAMP, failure_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [row.id],
        );
      } catch (error) {
        const status = errorStatus(error);
        if (status === 404 || status === 410 || error instanceof UnsafePushDestinationError) {
          if (error instanceof UnsafePushDestinationError) failed += 1;
          else expired += 1;
          await db.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
        } else {
          failed += 1;
          await db.query(
            "UPDATE push_subscriptions SET failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [row.id],
          );
        }
      } finally { options.agent?.destroy(); }
    }));
  }

  console.info(JSON.stringify({ event: "push_delivery", noticeId, targeted: rows.length, sent, expired, failed }));
  return { status: "sent", targeted: rows.length, sent, expired, failed };
}

export async function sendPushForNotice(noticeId: string, senderOverride?: PushSender): Promise<PushDeliverySummary> {
  try {
    return await deliverPushForNotice(noticeId, senderOverride);
  } catch (error) {
    console.error(JSON.stringify({
      event: "push_delivery_failed",
      noticeId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
    return { status: "failed", targeted: 0, sent: 0, expired: 0, failed: 1 };
  }
}
