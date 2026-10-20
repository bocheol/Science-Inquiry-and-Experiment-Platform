import { beforeAll, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { canReadTeamJournals, journalTeacherClasses } from "@/lib/journal-access";
import { getJournalImage, listTeacherTeamJournals } from "@/lib/journal-service";
import { setJournalTeacherClasses } from "@/lib/journal-teacher-settings";
import { buildCycleEvidencePayload, captureCycleEvidenceSnapshot, cycleEvidenceHash } from "@/lib/cycle-evidence";
import { getCycleJourney, prepareCycleAnalysisInput } from "@/lib/cycle-analysis";
import { TEAM_PUBLIC_EVIDENCE_POLICY } from "@/lib/journal-privacy-policy";
import type { SessionUser } from "@/lib/types";

const teacher = (id: string): SessionUser => ({ id, role: "teacher", name: "합성 교사", loginId: id, academicYear: 2026, classId: null, classNumber: null, mustChangePassword: false });
let cycleId: string;
beforeAll(async () => {
  const db = await getDb();
  cycleId = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1'")).rows[0].id;
  await db.query("UPDATE users SET is_master=TRUE WHERE id='teacher_bootstrap'");
  for (const id of ["assigned", "coadmin", "outsider"]) await db.query("INSERT INTO users (id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES ($1,$1,$1,2026,'teacher','synthetic-only',FALSE)", [id]);
  for (const id of ["assigned", "coadmin"]) await setJournalTeacherClasses("teacher_bootstrap", id, ["class_2026_9"], []);
  await db.query("INSERT INTO experiment_journals (id,session_id,cycle_id,student_id,session_number,journal_date,activities,observations,reflections) VALUES ('privacy-journal','demo_session_1',$1,'demo_student_1',1,'2026-10-20','비공개 합성 활동','비공개 합성 관찰','개인 고민')", [cycleId]);
  await db.query("INSERT INTO experiment_journal_images (id,journal_id,client_id,content_type,file_name,byte_size,image_data) VALUES ('privacy-photo','privacy-journal','privacy-client','image/jpeg','test.jpg',4,$1)", [Buffer.from("test")]);
});
it("requires live class grants for journals and photos, including coadmin, revoked and inactive teachers", async () => {
  const db = await getDb();
  for (const id of ["assigned", "coadmin", "teacher_bootstrap"]) {
    expect(await canReadTeamJournals(db, id, "demo_team_1")).toBe(true);
    expect((await listTeacherTeamJournals(teacher(id), "demo_team_1")).members.find(m => m.id === "demo_student_1")!.journals).toHaveLength(1);
    expect((await getJournalImage(teacher(id), "privacy-photo")).data.toString()).toBe("test");
  }
  for (const id of ["outsider", "demo_student_2"]) {
    expect(await canReadTeamJournals(db, id, "demo_team_1")).toBe(false);
    await expect(listTeacherTeamJournals(teacher(id), "demo_team_1")).rejects.toMatchObject({ status: 403 });
    await expect(getJournalImage(teacher(id), "privacy-photo")).rejects.toMatchObject({ status: 403 });
  }
  await setJournalTeacherClasses("teacher_bootstrap", "coadmin", [], ["class_2026_9"]);
  await expect(getJournalImage(teacher("coadmin"), "privacy-photo")).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE users SET status='inactive' WHERE id='assigned'");
  expect(await journalTeacherClasses(db, "assigned")).toEqual([]);
  await expect(listTeacherTeamJournals(teacher("assigned"), "demo_team_1")).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE users SET status='active' WHERE id='assigned'");
});
it("rejects stale grant updates and non-master grants", async () => {
  await expect(setJournalTeacherClasses("teacher_bootstrap", "assigned", [], [])).rejects.toThrow("다른 화면");
  await expect(setJournalTeacherClasses("outsider", "outsider", ["class_2026_9"], [])).rejects.toThrow("마스터");
});
it("excludes private journal changes from team analysis evidence, hashes, and legacy source catalogs", async () => {
  const db = await getDb();
  const first = await buildCycleEvidencePayload(db, cycleId);
  expect(first.privacyPolicy).toBe(TEAM_PUBLIC_EVIDENCE_POLICY); expect(first.journals).toEqual([]);
  expect(JSON.stringify(first)).not.toContain("비공개 합성");
  await db.query("UPDATE experiment_journals SET activities='다른 비공개 내용', updated_at=CURRENT_TIMESTAMP WHERE id='privacy-journal'");
  expect(cycleEvidenceHash(await buildCycleEvidencePayload(db, cycleId))).toBe(cycleEvidenceHash(first));
  const snapshot = await captureCycleEvidenceSnapshot(db, cycleId, "teacher_bootstrap");
  const prepared = prepareCycleAnalysisInput({ ...snapshot, privacyPolicy: undefined, journals: [{ evidenceId: "private", sessionNumber: 1, date: "2026-10-20", activities: "개인 원문", observations: "개인 관찰", updatedAt: "2026-10-20" }], trajectoryContext: [{ cycleId, ordinal: 1, title: "과거", analysisId: "old", analysisType: "intermediate", result: { summary: "개인 식별 요약" }, decisions: [] }] }, value => value);
  expect(prepared.text).not.toContain("개인 원문"); expect(prepared.text).not.toContain("개인 식별 요약");
});
it("hides unknown historical analyses from students and unassigned teachers while retaining the records", async () => {
  const db = await getDb(); const snapshot = await captureCycleEvidenceSnapshot(db, cycleId, "teacher_bootstrap");
  await db.query("INSERT INTO ai_generation_resources (resource_key) VALUES ('privacy-test')");
  await db.query("INSERT INTO ai_generation_jobs (id,resource_key,request_key,feature,status) VALUES ('privacy-job','privacy-test','synthetic','cycle-analysis','completed')");
  await db.query("INSERT INTO cycle_ai_analyses (id,cycle_id,snapshot_id,analysis_type,requested_by,ai_job_id,model,prompt_version,schema_version,result_json) VALUES ('legacy-analysis',$1,$2,'intermediate','teacher_bootstrap','privacy-job','fake','old','old',$3)", [cycleId, snapshot.id, JSON.stringify({ overview: "과거 비공개 근거 포함 가능", inquiryField: "합성 과학", researchType: "실험", strengths: [], findings: [], suggestions: [{ id: "synthetic-suggestion", title: "합성", rationale: "", evidenceIds: [], feasibleNextStep: "", safetyNote: "", questionForStudents: "" }], cycleComparison: [], limitations: [] })]);
  expect((await getCycleJourney("demo_session_1"))[0]!.analysis).toBeNull();
  expect((await getCycleJourney("demo_session_1", "outsider"))[0]!.analysis).toBeNull();
  expect((await getCycleJourney("demo_session_1", "assigned"))[0]!.analysis?.id).toBe("legacy-analysis");
  expect((await buildCycleEvidencePayload(db, cycleId, true)).trajectoryContext).toEqual([]);
  expect((await db.query("SELECT id FROM cycle_ai_analyses WHERE id='legacy-analysis'")).rows).toHaveLength(1);
  await db.query("UPDATE cycle_ai_analyses SET privacy_policy=$1 WHERE id='legacy-analysis'", [TEAM_PUBLIC_EVIDENCE_POLICY]);
  expect((await getCycleJourney("demo_session_1"))[0]!.analysis?.id).toBe("legacy-analysis");
});
