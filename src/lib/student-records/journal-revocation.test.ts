import { beforeAll, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { setJournalTeacherClasses } from "@/lib/journal-teacher-settings";
import { GET as journalImage } from "@/app/api/records/journal-images/[imageId]/route";
import { assertRecordEvidenceAccess, assertRecordStudent, teacherRecordStudents, type RecordActor } from "./access";
import { collectRecordEvidence } from "./evidence";
import { getRecordWorkspace, recordHistory, saveRecordDraft } from "./service";

const auth = vi.hoisted(() => ({ user: null as RecordActor | null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => auth.user }));
// This suite exercises actual grant mutations, not the unused password helpers.
vi.mock("@/lib/master-accounts", () => ({ assertMasterActor: vi.fn() }));
const teacher: RecordActor = { id: "teacher_bootstrap", role: "teacher", mustChangePassword: false };
const owner: RecordActor = { id: "demo_student_1", role: "student", mustChangePassword: false };
const peer: RecordActor = { id: "demo_student_2", role: "student", mustChangePassword: false };
const outsider: RecordActor = { id: "records_scope_master", role: "teacher", mustChangePassword: false };
const c9 = "class_2026_9", c8 = "class_2026_8";

async function image(actor: RecordActor, id = "revocation_photo") {
  auth.user = actor;
  return journalImage(new Request("https://local.invalid/api/records/journal-images/" + id), { params: Promise.resolve({ imageId: id }) });
}

beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO record_teacher_classes(class_id,teacher_id) VALUES($1,$2)", [c9, teacher.id]);
  await db.query("INSERT INTO class_journal_teacher_assignments(class_id,teacher_id) VALUES($1,$2)", [c9, teacher.id]);
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 마스터','scope-master',2026,'teacher','unused',FALSE,TRUE)", [outsider.id]);
  await db.query("INSERT INTO class_journal_teacher_assignments(class_id,teacher_id) VALUES($1,$2)", [c9, outsider.id]);
  const cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1'")).rows[0].id;
  await db.query("INSERT INTO experiment_journals(id,session_id,cycle_id,student_id,session_number,journal_date,activities) VALUES('revocation_journal','demo_session_1',$1,$2,97,'2026-10-21','SYNTHETIC_PRIVATE_EVIDENCE')", [cycle, owner.id]);
  await db.query("INSERT INTO experiment_journal_images(id,journal_id,client_id,content_type,file_name,byte_size,image_data) VALUES('revocation_photo','revocation_journal','synthetic-image','image/png','synthetic.png',3,$1)", [Buffer.from([1, 2, 3])]);
  const workspace = await getRecordWorkspace(teacher, owner.id);
  await saveRecordDraft(teacher, owner.id, { expectedRevision: 0, expectedSubmissionRevision: workspace.submission.revision, expectedEvidenceHash: workspace.evidence!.hash, course1: '합성 관찰', course2: 'SYNTHETIC_PRIVATE_DERIVATIVE', notes: 'SYNTHETIC_PRIVATE_NOTE', checkedGroups: [], finalize: false });
});

it("revokes live evidence, image, stored prose and history without deleting any record", async () => {
  const db = await getDb();
  const before = {
    draft: (await db.query("SELECT * FROM record_drafts WHERE student_id=$1", [owner.id])).rows,
    versions: (await db.query("SELECT * FROM record_draft_versions WHERE student_id=$1", [owner.id])).rows,
    journal: (await db.query("SELECT * FROM experiment_journals WHERE id='revocation_journal'")).rows,
  };
  expect((await image(teacher)).status).toBe(200);
  await setJournalTeacherClasses(outsider.id, teacher.id, [], [c9]);
  try {
    for (const read of [() => collectRecordEvidence(db, teacher, owner.id), () => getRecordWorkspace(teacher, owner.id), () => recordHistory(teacher, owner.id)]) {
      await expect(read()).rejects.toMatchObject({ status: 403 });
    }
    expect((await image(teacher)).status).toBe(403);
    expect(await teacherRecordStudents(teacher)).toEqual([]);
    expect((await image(owner)).status).toBe(200);
    expect((await image(peer)).status).toBe(403);
    expect((await collectRecordEvidence(db, owner, owner.id)).sources.some(s => s.id === 'journal:revocation_journal')).toBe(true);
    expect((await db.query("SELECT * FROM record_drafts WHERE student_id=$1", [owner.id])).rows).toEqual(before.draft);
    expect((await db.query("SELECT * FROM record_draft_versions WHERE student_id=$1", [owner.id])).rows).toEqual(before.versions);
    expect((await db.query("SELECT * FROM experiment_journals WHERE id='revocation_journal'")).rows).toEqual(before.journal);
    expect((await db.query("SELECT teacher_id FROM record_teacher_classes WHERE class_id=$1", [c9])).rows[0].teacher_id).toBe(teacher.id);
  } finally { await setJournalTeacherClasses(outsider.id, teacher.id, [c9], []); }
  expect((await getRecordWorkspace(teacher, owner.id)).draft!.course2).toBe('SYNTHETIC_PRIVATE_DERIVATIVE');
});

it("never substitutes master/shared journal access for an assigned records class", async () => {
  await expect(assertRecordStudent(await getDb(), outsider, owner.id)).rejects.toMatchObject({ status: 403 });
  expect(await teacherRecordStudents(outsider)).toEqual([]);
  expect((await image(outsider)).status).toBe(403);
});

it("checks the original journal class in saved evidence and rejects unresolved provenance", async () => {
  const db = await getDb();
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES('revocation_old_team',$1,97,'합성 과거 팀')", [c8]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES('revocation_old_session','revocation_old_team')");
  await db.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status,origin) VALUES('revocation_old_cycle','revocation_old_session',1,'합성 회차','completed','configured')");
  await db.query("INSERT INTO experiment_journals(id,session_id,cycle_id,student_id,session_number,journal_date,activities) VALUES('revocation_old_journal','revocation_old_session','revocation_old_cycle',$1,1,'2026-09-01','SYNTHETIC_OLD_CLASS_SECRET')", [owner.id]);
  const hidden = { sources: [{ id: 'journal:revocation_old_journal', text: 'SYNTHETIC_OLD_CLASS_SECRET' }] };
  expect(JSON.stringify(await collectRecordEvidence(db, teacher, owner.id))).not.toContain('SYNTHETIC_OLD_CLASS_SECRET');
  await expect(assertRecordEvidenceAccess(db, teacher, owner.id, hidden)).rejects.toMatchObject({ status: 403 });
  await expect(assertRecordEvidenceAccess(db, teacher, owner.id, null)).rejects.toMatchObject({ status: 403 });
  await expect(assertRecordEvidenceAccess(db, teacher, owner.id, { sources: [{ id: 'journal:nonexistent' }] })).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE record_drafts SET evidence=$2, course2='SYNTHETIC_OLD_CLASS_DERIVATIVE', ai_result=$3 WHERE student_id=$1",
    [owner.id, JSON.stringify(hidden), JSON.stringify({ course1: "", course2: "SYNTHETIC_OLD_AI", claims: [], warnings: [] })]);
  await db.query("UPDATE record_draft_versions SET snapshot=$2 WHERE student_id=$1",
    [owner.id, JSON.stringify({ evidence: hidden, course2: "SYNTHETIC_OLD_CLASS_DERIVATIVE" })]);
  const preserved = (await db.query("SELECT * FROM record_drafts WHERE student_id=$1", [owner.id])).rows[0];
  const versions = (await db.query("SELECT * FROM record_draft_versions WHERE student_id=$1 ORDER BY revision", [owner.id])).rows;
  const fresh = await getRecordWorkspace(teacher, owner.id);
  expect(fresh.draft).toMatchObject({ previousDraftHidden: true, revision: preserved.revision, course1: "", course2: "", notes: "", checkedGroups: [], evidence: null, ai: null, status: "draft" });
  expect(JSON.stringify(fresh)).not.toContain("SYNTHETIC_OLD");
  expect((await recordHistory(teacher, owner.id)).drafts).toEqual([]);
  const input = { expectedRevision: fresh.draft!.revision, expectedSubmissionRevision: fresh.submission.revision, expectedEvidenceHash: fresh.evidence!.hash,
    course1: "현재 근거로 시작", course2: "새 작성본", notes: "", checkedGroups: [], finalize: false };
  await expect(saveRecordDraft(teacher, owner.id, input)).rejects.toMatchObject({ status: 409 });
  const saved = await saveRecordDraft(teacher, owner.id, { ...input, startNewDraft: true });
  expect(saved.revision).toBe(preserved.revision + 2);
  const after = (await db.query("SELECT * FROM record_draft_versions WHERE student_id=$1 ORDER BY revision", [owner.id])).rows;
  expect(after.slice(0, versions.length)).toEqual(versions);
  expect(after[versions.length].snapshot.preservedDraft).toEqual(JSON.parse(JSON.stringify(preserved)));
  expect((await getRecordWorkspace(teacher, owner.id)).draft).toMatchObject({ course2: "새 작성본", ai: null });
  expect((await recordHistory(teacher, owner.id)).drafts.map(d => d.revision)).toEqual([saved.revision]);
  // No regrant or repair is required; the hidden original journal remains intact.
  expect((await db.query("SELECT activities FROM experiment_journals WHERE id='revocation_old_journal'")).rows[0].activities).toBe("SYNTHETIC_OLD_CLASS_SECRET");
});

it("does not let a non-master change journal grants", async () => {
  await expect(setJournalTeacherClasses(teacher.id, teacher.id, [], [c9])).rejects.toThrow("활성 마스터");
  expect((await teacherRecordStudents(teacher)).length).toBeGreaterThan(0);
});

it("starts a fresh draft for unknown historical provenance without exposing or deleting the row", async () => {
  const db = await getDb();
  await db.query("UPDATE record_drafts SET evidence=NULL, notes='SYNTHETIC_UNSCOPED_NOTE' WHERE student_id=$1", [owner.id]);
  const preserved = (await db.query("SELECT * FROM record_drafts WHERE student_id=$1", [owner.id])).rows[0];
  const workspace = await getRecordWorkspace(teacher, owner.id);
  expect(workspace.draft?.previousDraftHidden).toBe(true);
  expect(JSON.stringify(workspace)).not.toContain("SYNTHETIC_UNSCOPED_NOTE");
  await saveRecordDraft(teacher, owner.id, { startNewDraft: true, expectedRevision: workspace.draft!.revision,
    expectedSubmissionRevision: workspace.submission.revision, expectedEvidenceHash: workspace.evidence!.hash,
    course1: "새 현재 작성본", course2: "", notes: "", checkedGroups: [], finalize: false });
  const archive = (await db.query("SELECT snapshot FROM record_draft_versions WHERE student_id=$1 AND revision=$2", [owner.id, preserved.revision + 1])).rows[0].snapshot;
  expect(archive.preservedDraft).toEqual(JSON.parse(JSON.stringify(preserved)));
  expect(JSON.stringify(await recordHistory(teacher, owner.id))).not.toContain("SYNTHETIC_UNSCOPED_NOTE");
});
