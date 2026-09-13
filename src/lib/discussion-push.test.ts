import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { saveDiscussionEntry, markDiscussionMessagesRead } from "@/lib/discussions";
import { deliverDiscussionPush } from "@/lib/discussion-push";
import * as push from "@/lib/push-notifications";
import { removeStudent, assignStudent } from "@/lib/teams";

const cases = ["normal", "retry", "removed", "rejoined", "read", "unsubscribed", "rebound", "demo_receiver", "demo_sender", "late_subscription", "changed_during_check", "expired", "unsafe", "dns_failure", "concurrent"];
it.each(cases)("delivers only the pinned eligible subscription: %s", async kind => {
  const db = await getDb(), key = `push_discussion_${kind}`, sender = `${key}_a`, reader = `${key}_b`;
  for (const id of [sender, reader]) await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,account_type) VALUES($1,'합성 비공개 이름',$1,2026,'student','unused',FALSE,$2)", [id, (id === sender && kind === "demo_sender") || (id === reader && kind === "demo_receiver") ? "demo" : "standard"]);
  for (const id of [sender, reader]) await db.query("UPDATE users SET class_id='class_2026_6' WHERE id=$1", [id]);
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_6',$2,'합성 알림팀')", [key, 120 + cases.indexOf(kind)]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  for (const id of [sender, reader]) await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
  const cycle = await ensureInitialCycle(db, key, "teacher_bootstrap");
  const subscribe = () => db.query("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,'synthetic-key','synthetic-auth')", [key, reader, kind === "unsafe" ? "http://127.0.0.1/push" : `https://push.example/${kind}`]);
  if (kind !== "late_subscription") await subscribe();
  const actor = { id: sender, role: "student" as const, mustChangePassword: false };
  const input = { id: key, sessionId: key, cycleId: cycle, kind: "peer" as const, content: "비공개 실험 메시지" };
  await saveDiscussionEntry(actor, input);
  if (kind === "late_subscription") await subscribe();
  await saveDiscussionEntry(actor, input);
  const queued = (await db.query("SELECT * FROM discussion_push_outbox WHERE entry_id=$1", [key])).rows;
  expect(queued).toHaveLength(["demo_receiver", "demo_sender", "late_subscription"].includes(kind) ? 0 : 1);
  if (kind === "removed" || kind === "rejoined") await removeStudent("teacher_bootstrap", reader, key);
  if (kind === "rejoined") await assignStudent("teacher_bootstrap", reader, key);
  if (kind === "read") await markDiscussionMessagesRead({ ...actor, id: reader }, key, cycle, [key]);
  if (kind === "unsubscribed") await db.query("DELETE FROM push_subscriptions WHERE id=$1", [key]);
  if (kind === "rebound") await db.query("UPDATE push_subscriptions SET user_id=$1 WHERE id=$2", [sender, key]);
  const snapshot = (await db.query("SELECT * FROM discussion_entries WHERE id=$1", [key])).rows;
  const calls: string[] = [];
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fake: push.PushSender = async (_subscription, payload, options) => {
    expect(options.agent?.options.lookup).toBeTypeOf("function");
    calls.push(payload);
    if (kind === "retry" && calls.length === 1) throw Object.assign(new Error("synthetic unavailable"), { statusCode: 503 });
    if (kind === "expired") throw Object.assign(new Error("synthetic expired"), { statusCode: 410 });
    if (kind === "concurrent") { entered(); await hold; }
  };
  const destinationCheck = kind === "dns_failure"
    ? vi.spyOn(push, "assertSafePushDestination").mockRejectedValueOnce(new Error("synthetic DNS unavailable"))
    : kind === "changed_during_check"
      ? vi.spyOn(push, "assertSafePushDestination").mockImplementationOnce(async () => {
          await db.query("UPDATE push_subscriptions SET auth='replacement-auth' WHERE id=$1", [key]);
        })
      : null;
  try {
    const first = deliverDiscussionPush(key, fake);
    if (kind === "concurrent") {
      await started;
      expect(await deliverDiscussionPush(key, fake)).toEqual({ attempted: 0, sent: 0 });
      release();
    }
    await first;
    if (kind === "retry" || kind === "dns_failure") {
      expect((await db.query("SELECT status FROM discussion_push_outbox WHERE entry_id=$1", [key])).rows[0].status).toBe("pending");
      expect((await db.query("SELECT id FROM push_subscriptions WHERE id=$1", [key])).rows).toHaveLength(1);
      const before = calls.length;
      expect(await deliverDiscussionPush(key, fake)).toEqual({ attempted: 0, sent: 0 });
      expect(calls).toHaveLength(before);
      await db.query("UPDATE discussion_push_outbox SET next_attempt_at=$2 WHERE entry_id=$1", [key, new Date(Date.now() - 1000)]);
      await deliverDiscussionPush(key, fake);
    }
  } finally { destinationCheck?.mockRestore(); release(); }
  const expectedCalls = kind === "retry" ? 2 : ["normal", "dns_failure", "expired", "concurrent"].includes(kind) ? 1 : 0;
  expect(calls).toHaveLength(expectedCalls);
  for (const payload of calls) {
    expect(JSON.parse(payload)).toEqual({ body: "팀에 새 메시지가 도착했습니다. 앱에서 확인하세요.", url: "/inquiry", tag: `discussion-${key}`, renotify: false });
    expect(payload).not.toContain(input.content); expect(payload).not.toContain("합성 비공개 이름");
  }
  if (kind === "unsafe" || kind === "expired") expect((await db.query("SELECT id FROM push_subscriptions WHERE id=$1", [key])).rows).toHaveLength(0);
  expect(await deliverDiscussionPush(key, fake)).toEqual({ attempted: 0, sent: 0 });
  expect((await db.query("SELECT * FROM discussion_entries WHERE id=$1", [key])).rows).toEqual(snapshot);
});
