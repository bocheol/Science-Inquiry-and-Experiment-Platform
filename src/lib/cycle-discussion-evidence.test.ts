import { beforeAll, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { buildCycleEvidencePayload, captureCycleEvidenceSnapshot, cycleEvidenceHash } from "@/lib/cycle-evidence";
import { prepareCycleAnalysisInput } from "@/lib/cycle-analysis";

const session = "discussion_evidence_session", date = "2026-08-21";
let cycle: string;
const source = (id: string, content: string, activityDate = date) => ({ id, kind: "meeting", content, activityDate });
const current = source("current_meeting", "현재 회차 대면 메모");
const previous = source("previous_meeting", "이전 회차 대면 메모");
async function setSummary(sources: unknown[], sourceIds: string[] = [current.id], content = "대면 메모에 따르면 측정을 논의했다.") {
  const db = await getDb();
  await db.query("UPDATE discussion_summaries SET sources=$1,content=$2 WHERE id='cycle_evidence_summary'", [JSON.stringify(sources), JSON.stringify([{ category: "discussion", text: content, sourceIds }])]);
}
beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',290,'합성 회차 근거 팀')", [session]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [session]);
  const oldCycle = await ensureInitialCycle(db, session, "teacher_bootstrap");
  await db.query("UPDATE inquiry_cycles SET status='completed',started_at='2026-08-20T15:00:00Z',ended_at='2026-08-21T01:00:00Z' WHERE id=$1", [oldCycle]);
  cycle = "discussion_evidence_cycle_2";
  await db.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,started_at) VALUES($1,$2,2,'2차','2026-08-21T01:00:00Z')", [cycle, session]);
  await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [session, cycle, { topic: "측정" }]);
  await db.query("INSERT INTO reports(id,session_id,cycle_id,status) VALUES($1,$1,$2,'reviewed')", [session, cycle]);
  for (const [entry, entryCycle] of [[current, cycle], [previous, oldCycle]] as const) {
    await db.query("INSERT INTO discussion_entries(id,session_id,cycle_id,author_id,kind,activity_date,content,participants) VALUES($1,$2,$3,'demo_student_1','meeting',$4,$5,$6)", [entry.id, session, entryCycle, date, entry.content, JSON.stringify([{ id: "demo_student_1", name: "합성 팀원" }])]);
  }
  await db.query("INSERT INTO discussion_days(session_id,activity_date,generated_version,status) VALUES($1,$2,1,'ready')", [session, date]);
  await db.query("INSERT INTO discussion_summaries(id,session_id,activity_date,version,content,sources) VALUES('cycle_evidence_summary',$1,$2,1,'[]','[]')", [session, date]);
});

it("excludes mixed same-day summaries while retaining current-cycle raw evidence", async () => {
  const db = await getDb();
  await setSummary([current, previous], [current.id, previous.id]);
  const payload = await buildCycleEvidencePayload(db, cycle);
  expect(payload.discussionSummaries).toEqual([]);
  expect(payload.discussionEntries?.map(entry => entry.evidenceId)).toEqual([`entry:${current.id}`]);
  expect((await db.query("SELECT sources FROM discussion_summaries WHERE id='cycle_evidence_summary'")).rows[0].sources).toHaveLength(2);
});

it("accepts only source-verified summaries and rejects fabricated or changed source snapshots", async () => {
  const db = await getDb();
  await setSummary([current]);
  expect((await buildCycleEvidencePayload(db, cycle)).discussionSummaries).toHaveLength(1);
  for (const sources of [[{ ...current, id: "missing" }], [{ ...current, content: "수정된 원문" }], [{ ...current, kind: "ai_answer" }], [{ ...current, activityDate: "2026-08-20" }], []]) {
    await setSummary(sources);
    expect((await buildCycleEvidencePayload(db, cycle)).discussionSummaries).toEqual([]);
  }
  await setSummary([current], [previous.id]);
  expect((await buildCycleEvidencePayload(db, cycle)).discussionSummaries).toEqual([]);
});

it("uses source ownership for backdated notes rather than inferring it from cycle start dates", async () => {
  const db = await getDb();
  const backDate = "2026-08-19";
  await db.query("UPDATE discussion_entries SET activity_date=$1 WHERE id=$2", [backDate, current.id]);
  await db.query("UPDATE discussion_days SET activity_date=$1 WHERE session_id=$2", [backDate, session]);
  await db.query("UPDATE discussion_summaries SET activity_date=$1 WHERE id='cycle_evidence_summary'", [backDate]);
  await setSummary([{ ...current, activityDate: backDate }]);
  expect((await buildCycleEvidencePayload(db, cycle)).discussionSummaries).toHaveLength(1);
});

it("freezes raw records and confirmations and supplies distinct attributed evidence to AI", async () => {
  const db = await getDb();
  const snapshot = await captureCycleEvidenceSnapshot(db, cycle, "teacher_bootstrap");
  const stored = (await db.query("SELECT discussion_entries FROM cycle_evidence_snapshots WHERE id=$1", [snapshot.id])).rows[0].discussion_entries;
  expect(stored).toEqual(snapshot.discussionEntries);
  const prepared = prepareCycleAnalysisInput(snapshot, text => text);
  expect(prepared.sourceIds).toContain(`entry:${current.id}`);
  expect(prepared.text).toContain("작성자 대면 메모");
  expect(prepared.text).not.toContain("demo_student_1");
  await db.query("INSERT INTO discussion_confirmations(entry_id,user_id) VALUES($1,'demo_student_1')", [current.id]);
  expect(cycleEvidenceHash(await buildCycleEvidencePayload(db, cycle))).not.toBe(snapshot.contentHash);
  expect((await db.query("SELECT discussion_entries FROM cycle_evidence_snapshots WHERE id=$1", [snapshot.id])).rows[0].discussion_entries).toEqual(stored);
});
