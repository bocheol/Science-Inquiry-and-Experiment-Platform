import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { getExamDocumentSources } from "@/lib/exam-document-sources";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { reviewReport } from "@/lib/report-service";

it("uses reviewed snapshots across cycles, preserving original roles while excluding later drafts", async () => {
  const db = await getDb(), id = "fixed_exam_sources";
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ($1,'class_2026_6',1,'합성 고정본 팀')", [id]);
  await db.query("INSERT INTO inquiry_sessions (id,team_id) VALUES ($1,$1)", [id]);
  const cycle1 = await ensureInitialCycle(db, id, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id,session_id,cycle_id,form_data,review_status) VALUES ($1,$1,$2,$3,'approved')", [id, cycle1, JSON.stringify({ topic: "승인한 주제", method: "첫 회차 승인 원문" })]);
  await db.query("INSERT INTO reports (id,session_id,cycle_id,form_data,status) VALUES ($1,$1,$2,$3,'reviewed')", [id, cycle1, JSON.stringify({ analysis: "첫 회차 확인 원문" })]);
  await db.query("INSERT INTO report_member_roles (report_id,user_id,role_description) VALUES ($1,'demo_student_1','첫 회차 확인 역할')", [id]);
  const first = await getExamDocumentSources(id, "teacher_bootstrap");
  expect(first).toHaveLength(2);
  expect(first.find(source => source.kind === "plan")?.form.method).toBe("첫 회차 승인 원문");
  expect(first.find(source => source.kind === "report")?.roles).toEqual([{ userId: "demo_student_1", description: "첫 회차 확인 역할" }]);
  expect(first.every(source => source.legacy)).toBe(true);
  expect(await getExamDocumentSources(id, "teacher_bootstrap")).toEqual(first);

  await db.query("UPDATE investigation_plans SET form_data = $1, review_status = 'draft' WHERE id = $2", [JSON.stringify({ topic: "미승인 새 주제", method: "학생 수정 중인 초안" }), id]);
  await db.query("UPDATE reports SET form_data = $1, status = 'draft' WHERE id = $2", [JSON.stringify({ analysis: "미확인 보고서 초안" }), id]);
  await db.query("UPDATE report_member_roles SET role_description = '미확인 역할 변경' WHERE report_id = $1", [id]);
  expect(await getExamDocumentSources(id, "teacher_bootstrap")).toEqual(first);

  const cycle2 = id + "_cycle2";
  await db.query("UPDATE inquiry_cycles SET status = 'completed' WHERE id = $1", [cycle1]);
  await db.query("INSERT INTO inquiry_cycles (id,session_id,ordinal,title) VALUES ($1,$2,2,'두 번째 회차')", [cycle2, id]);
  await db.query("UPDATE investigation_plans SET cycle_id = $1, form_data = $2, review_status = 'approved' WHERE id = $3", [cycle2, JSON.stringify({ method: "두 번째 승인 원문" }), id]);
  await db.query("UPDATE reports SET cycle_id = $1, form_data = $2, status = 'submitted' WHERE id = $3", [cycle2, JSON.stringify({ analysis: "두 번째 제출 원문" }), id]);
  const pending = await getExamDocumentSources(id, "teacher_bootstrap");
  expect(pending.filter(source => source.kind === "plan")).toHaveLength(2);
  expect(pending.filter(source => source.kind === "report")).toHaveLength(1);
  expect(JSON.stringify(pending)).not.toContain("두 번째 제출 원문");
  await reviewReport(id, "teacher_bootstrap", "reviewed", "");
  await db.query("UPDATE reports SET status = 'draft', form_data = $1 WHERE id = $2", [JSON.stringify({ analysis: "확인 뒤 다시 수정 중" }), id]);
  await db.query("UPDATE report_member_roles SET role_description = '더 나중의 역할' WHERE report_id = $1", [id]);
  const after = await getExamDocumentSources(id, "teacher_bootstrap");
  expect(after).toHaveLength(4);
  expect(after.find(source => source.kind === "report" && source.cycleId === cycle2)).toMatchObject({ form: { analysis: "두 번째 제출 원문" }, roles: [{ userId: "demo_student_1", description: "미확인 역할 변경" }], legacy: false });
  expect(after.find(source => source.kind === "report" && source.cycleId === cycle1)?.roles[0]?.description).toBe("첫 회차 확인 역할");
  expect(JSON.stringify(after)).not.toContain("확인 뒤 다시 수정 중");
  expect(JSON.stringify(after)).not.toContain("더 나중의 역할");
});

it("does not turn an unapproved plan or unreviewed report into exam evidence", async () => {
  const db = await getDb(), id = "unreviewed_exam_sources";
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ($1,'class_2026_6',2,'합성 미승인 팀')", [id]);
  await db.query("INSERT INTO inquiry_sessions (id,team_id) VALUES ($1,$1)", [id]);
  const cycle = await ensureInitialCycle(db, id, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id,session_id,cycle_id,form_data,review_status) VALUES ($1,$1,$2,$3,'pending')", [id, cycle, JSON.stringify({ topic: "승인 전 주제" })]);
  await db.query("INSERT INTO reports (id,session_id,cycle_id,form_data,status) VALUES ($1,$1,$2,$3,'submitted')", [id, cycle, JSON.stringify({ analysis: "확인 전 결과" })]);
  expect(await getExamDocumentSources(id, "teacher_bootstrap")).toEqual([]);
  expect((await db.query("SELECT id FROM plan_submissions WHERE plan_id = $1", [id])).rows).toHaveLength(0);
  expect((await db.query("SELECT id FROM document_revisions WHERE document_id = $1", [id])).rows).toHaveLength(0);
});
