import webpush, { type PushSubscription, type RequestOptions } from "web-push";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { SessionUser } from "@/lib/types";

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
type PushSender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

function assertStudent(actor: Pick<SessionUser, "role">) {
  if (actor.role !== "student") throw new Error("학생만 기기 알림을 설정할 수 있습니다.");
}

export function getPushPublicConfiguration() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  return { configured: Boolean(publicKey && privateKey && subject), publicKey };
}

function getVapidDetails() {
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
       JOIN users u ON u.role = 'student' AND u.status = 'active' AND u.academic_year = $2
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
      const subscription: StoredPushSubscription = {
        id: row.id,
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      const options: RequestOptions = {
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
        if (status === 404 || status === 410) {
          expired += 1;
          await db.query("DELETE FROM push_subscriptions WHERE id = $1", [row.id]);
        } else {
          failed += 1;
          await db.query(
            "UPDATE push_subscriptions SET failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [row.id],
          );
        }
      }
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
