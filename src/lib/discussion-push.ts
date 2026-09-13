import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import webpush from "web-push";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { assertSafePushDestination, createSafePushAgent, getVapidDetails, UnsafePushDestinationError, type PushSender } from "@/lib/push-notifications";

type Subscription = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };
const fingerprint = (row: Subscription) => createHash("sha256").update(JSON.stringify([row.user_id, row.endpoint, row.p256dh, row.auth])).digest("hex");

export async function enqueueDiscussionPush(client: Pick<PoolClient, "query">, entryId: string) {
  // Capture only subscriptions present at send time. No subscription FK: rebinding
  // and deleting a device must not delete history or reverse user/team lock order.
  const subscriptions = await client.query<Subscription>(
    `SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
      JOIN discussion_message_recipients r ON r.user_id = ps.user_id
      JOIN users recipient ON recipient.id = r.user_id
      JOIN discussion_entries e ON e.id = r.entry_id JOIN users sender ON sender.id = e.author_id
      WHERE r.entry_id = $1 AND sender.account_type = 'standard' AND recipient.account_type = 'standard'`, [entryId],
  );
  for (const row of subscriptions.rows) await client.query(
    "INSERT INTO discussion_push_outbox(entry_id,user_id,subscription_id,subscription_fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT(entry_id,subscription_id) DO NOTHING",
    [entryId, row.user_id, row.id, fingerprint(row)],
  );
}

export async function deliverDiscussionPush(entryId?: string, senderOverride?: PushSender) {
  const vapidDetails = getVapidDetails();
  if (!senderOverride && !vapidDetails) return { attempted: 0, sent: 0 };
  const db = await getDb(), now = new Date();
  const jobs = await db.query<{ entry_id: string; subscription_id: string; subscription_fingerprint: string; user_id: string }>(
    `SELECT entry_id, subscription_id, subscription_fingerprint, user_id FROM discussion_push_outbox
      WHERE (status = 'pending' OR (status = 'sending' AND lease_until < $1))
        AND next_attempt_at <= $1 ${entryId ? "AND entry_id = $2" : ""}
      ORDER BY created_at, entry_id, subscription_id LIMIT 50`, entryId ? [now, entryId] : [now],
  );
  let attempted = 0, sent = 0;
  for (const job of jobs.rows) {
    const token = randomUUID();
    const claimed = await db.query<{ attempts: number; created_at: Date }>(
      `UPDATE discussion_push_outbox SET status='sending',lease_token=$3,lease_until=$4,attempts=attempts+1
        WHERE entry_id=$1 AND subscription_id=$2 AND (status='pending' OR (status='sending' AND lease_until < $5))
          AND next_attempt_at <= $5 RETURNING attempts,created_at`,
      [job.entry_id, job.subscription_id, token, new Date(Date.now() + 60000), new Date()],
    );
    if (!claimed.rows.length) continue;
    attempted++;
    const finish = (status: string, retry = new Date()) => db.query(
      "UPDATE discussion_push_outbox SET status=$4,lease_token=NULL,lease_until=NULL,next_attempt_at=$5 WHERE entry_id=$1 AND subscription_id=$2 AND lease_token=$3",
      [job.entry_id, job.subscription_id, token, status, retry],
    );
    const eligible = async () => {
      const rows = await db.query<Subscription>(
        `SELECT ps.id,ps.user_id,ps.endpoint,ps.p256dh,ps.auth FROM push_subscriptions ps
          JOIN discussion_message_recipients r ON r.user_id=ps.user_id
          JOIN team_members tm ON tm.id=r.membership_id AND tm.user_id=r.user_id
          JOIN discussion_entries e ON e.id=r.entry_id JOIN inquiry_sessions s ON s.id=e.session_id
          JOIN teams t ON t.id=s.team_id AND t.id=tm.team_id
          LEFT JOIN classes c ON c.id=t.class_id LEFT JOIN clubs cl ON cl.id=t.club_id
          JOIN users u ON u.id=r.user_id JOIN users author ON author.id=e.author_id
          WHERE ps.id=$1 AND r.entry_id=$2 AND r.user_id=$3 AND r.read_at IS NULL
            AND tm.status='active' AND t.status='active' AND COALESCE(c.academic_year,cl.academic_year)=$4
            AND u.status='active' AND u.must_change_password=FALSE AND u.account_type='standard' AND u.academic_year=$4
            AND author.status='active' AND author.account_type='standard' AND author.academic_year=$4`,
        [job.subscription_id, job.entry_id, job.user_id, ACADEMIC_YEAR],
      );
      const row = rows.rows[0];
      return row && fingerprint(row) === job.subscription_fingerprint ? row : null;
    };
    let subscription: Subscription | null = null;
    let agent: ReturnType<typeof createSafePushAgent> | undefined;
    try {
      if (claimed.rows[0].attempts > 5 || Date.now() - new Date(claimed.rows[0].created_at).getTime() > 86400000) { await finish("skipped"); continue; }
      subscription = await eligible();
      if (!subscription) { await finish("skipped"); continue; }
      await assertSafePushDestination(subscription.endpoint);
      // Recheck ownership/membership after DNS, before contacting a push service.
      if (!await eligible()) { await finish("skipped"); continue; }
      const ownership = await db.query("SELECT entry_id FROM discussion_push_outbox WHERE entry_id=$1 AND subscription_id=$2 AND lease_token=$3 AND lease_until > $4", [job.entry_id, job.subscription_id, token, new Date()]);
      if (!ownership.rows.length) continue;
      const send: PushSender = senderOverride ?? ((target, payload, options) => webpush.sendNotification(target, payload, options));
      agent = createSafePushAgent(subscription.endpoint);
      await send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ body: "팀에 새 메시지가 도착했습니다. 앱에서 확인하세요.", url: "/inquiry", tag: `discussion-${job.entry_id}`, renotify: false }), { agent, TTL: 3600, urgency: "normal", timeout: 10000, ...(vapidDetails ? { vapidDetails } : {}) });
      sent++;
      await finish("sent");
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error ? error.statusCode : null;
      if (subscription && (error instanceof UnsafePushDestinationError || status === 404 || status === 410)) {
        await db.query("DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2 AND endpoint=$3 AND p256dh=$4 AND auth=$5", [subscription.id, subscription.user_id, subscription.endpoint, subscription.p256dh, subscription.auth]);
        await finish("skipped");
      } else await finish(claimed.rows[0].attempts >= 5 ? "skipped" : "pending", new Date(Date.now() + Math.min(1800000, 60000 * 2 ** (claimed.rows[0].attempts - 1))));
    } finally { agent?.destroy(); }
  }
  return { attempted, sent };
}
