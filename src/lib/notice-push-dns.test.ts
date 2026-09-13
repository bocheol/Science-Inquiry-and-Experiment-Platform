import { expect, it, vi } from "vitest";
import type { LookupFunction } from "node:net";
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
import { getDb } from "@/lib/db";
import { createAnnouncement } from "@/lib/notices";
import { sendPushForNotice, type PushSender } from "@/lib/push-notifications";
import type { SessionUser } from "@/lib/types";

it.each(["temporary", "empty", "private", "rebind"])("handles a %s DNS result without losing a recoverable subscription", async kind => {
  const db = await getDb(), id = `notice_dns_${kind}`;
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 알림 학생',$1,2026,'student','unused',FALSE)", [id]);
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_8',$2,'합성 알림팀')", [id, 170 + ["temporary", "empty", "private", "rebind"].indexOf(kind)]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$1)", [id]);
  await db.query("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$1,$2,'synthetic-key','synthetic-auth')", [id, `https://push-provider.example.com/${kind}`]);
  const notice = await createAnnouncement({ id: "teacher_bootstrap", role: "teacher", academicYear: 2026, mustChangePassword: false } as SessionUser, { title: "합성 공지", content: "합성 내용", audienceType: "team", teamId: id, priority: "normal" });
  const original = (await db.query("SELECT * FROM push_subscriptions WHERE id=$1", [id])).rows;
  dns.lookup.mockReset();
  if (kind === "temporary") dns.lookup.mockRejectedValueOnce(Object.assign(new Error("synthetic DNS failure"), { code: "EAI_AGAIN" }));
  else if (kind === "rebind") dns.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
  else dns.lookup.mockResolvedValueOnce(kind === "empty" ? [] : [{ address: "10.0.0.1", family: 4 }]);
  const sender = vi.fn<PushSender>(async (_subscription, _payload, options) => {
    expect(options.agent?.options.lookup).toBeTypeOf("function");
    if (kind === "rebind") await new Promise((resolve, reject) => (options.agent!.options.lookup as LookupFunction)("push-provider.example.com", {}, (error, address) => error ? reject(error) : resolve(address)));
  });
  expect(await sendPushForNotice(notice, sender)).toMatchObject({ targeted: 1, sent: 0, failed: 1 });
  expect(sender).toHaveBeenCalledTimes(kind === "rebind" ? 1 : 0);
  const after = (await db.query("SELECT * FROM push_subscriptions WHERE id=$1", [id])).rows;
  if (kind === "private" || kind === "rebind") { expect(after).toHaveLength(0); return; }
  expect(after).toEqual(original);
  dns.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
  expect(await sendPushForNotice(notice, sender)).toMatchObject({ targeted: 1, sent: 1, failed: 0 });
  expect(sender).toHaveBeenCalledOnce();
});
