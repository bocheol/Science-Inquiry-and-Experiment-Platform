import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import {
  getJournalImage,
  detectJournalImageType,
  JournalAccessError,
  listStudentJournals,
  listTeacherTeamJournals,
  saveStudentJournal,
} from "@/lib/journal-service";
import type { SessionUser } from "@/lib/types";

const teamId = "journal_test_team";
const sessionId = "journal_test_session";
const ownerId = "journal_test_owner";
const peerId = "journal_test_peer";

const owner: SessionUser = {
  id: ownerId, name: "작성 학생", loginId: "test-owner", role: "student", academicYear: 2026,
  classId: "class_2026_1", classNumber: 1, mustChangePassword: false,
};
const peer: SessionUser = {
  id: peerId, name: "새 팀원", loginId: "test-peer", role: "student", academicYear: 2026,
  classId: "class_2026_1", classNumber: 1, mustChangePassword: false,
};
const teacher: SessionUser = {
  id: "teacher_bootstrap", name: "교사", loginId: "teacher", role: "teacher", academicYear: 2026,
  classId: null, classNumber: null, mustChangePassword: false,
};

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '작성 학생', 'test-owner', 2026, 'student', 'class_2026_1', 'unused', FALSE),
            ($2, '새 팀원', 'test-peer', 2026, 'student', 'class_2026_1', 'unused', FALSE)`,
    [ownerId, peerId],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_1', 99, '권한시험조', $2)",
    [teamId, ownerId],
  );
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'EXPERIMENTING')", [sessionId, teamId]);
  await db.query("INSERT INTO investigation_plans (id, session_id, review_status) VALUES ('journal_test_plan', $1, 'approved')", [sessionId]);
  await db.query(
    `INSERT INTO team_members (id, team_id, user_id, status) VALUES
      ($1, $2, $3, 'active'), ($4, $2, $5, 'active')`,
    [createId("member"), teamId, ownerId, createId("member"), peerId],
  );
  await db.query(
    `INSERT INTO material_requests
      (id, submission_id, session_id, team_id, submitted_by, form_data, total_amount, budget_status, sync_status)
     VALUES ('journal_test_material', 'journal-test-submission', $1, $2, $3, '[]', 0, 'within_budget', 'pending')`,
    [sessionId, teamId, ownerId],
  );
});

describe("personal experiment journal access", () => {
  it("accepts only supported image signatures", () => {
    expect(detectJournalImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(detectJournalImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectJournalImageType(Buffer.from("not-an-image"))).toBeNull();
  });

  it("requires both plan approval and a saved material request", async () => {
    const db = await getDb();
    await db.query("DELETE FROM material_requests WHERE id = 'journal_test_material'");
    await expect(listStudentJournals(owner, sessionId)).rejects.toMatchObject({ status: 403 } satisfies Partial<JournalAccessError>);
    await db.query(
      `INSERT INTO material_requests
        (id, submission_id, session_id, team_id, submitted_by, form_data, total_amount, budget_status, sync_status)
       VALUES ('journal_test_material', 'journal-test-submission', $1, $2, $3, '[]', 0, 'within_budget', 'pending')`,
      [sessionId, teamId, ownerId],
    );
  });

  it("keeps journals private, retries photos idempotently, and preserves removed student records for teachers", async () => {
    const payload = {
      sessionId,
      sessionNumber: 1,
      date: "2026-10-15",
      activities: "용액의 색 변화를 측정했다.",
      observations: "세 번째 시료에서 색이 더 진했다.",
      reflections: "농도를 같은 간격으로 바꿔 보고 싶다.",
      existingImageIds: [],
      photos: [{ clientId: "photo-client-0001", contentType: "image/jpeg" as const, fileName: "observation.jpg", data: Buffer.from("test-image") }],
    };

    const firstSave = await saveStudentJournal(owner, payload);
    const retrySave = await saveStudentJournal(owner, payload);
    expect(retrySave.id).toBe(firstSave.id);
    expect(retrySave.images).toHaveLength(1);

    const ownerJournals = await listStudentJournals(owner, sessionId);
    const peerJournals = await listStudentJournals(peer, sessionId);
    expect(ownerJournals).toHaveLength(1);
    expect(peerJournals).toEqual([]);

    const imageId = ownerJournals[0]!.images[0]!.id;
    await expect(getJournalImage(peer, imageId)).rejects.toMatchObject({ status: 403 } satisfies Partial<JournalAccessError>);
    expect((await getJournalImage(owner, imageId)).data.toString()).toBe("test-image");
    expect((await getJournalImage(teacher, imageId)).data.toString()).toBe("test-image");

    const db = await getDb();
    await db.query(
      "UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE team_id = $1 AND user_id = $2",
      [teamId, ownerId],
    );
    await expect(listStudentJournals(owner, sessionId)).rejects.toMatchObject({ status: 403 } satisfies Partial<JournalAccessError>);

    const teacherData = await listTeacherTeamJournals(teacher, teamId);
    const preserved = teacherData.members.find((member) => member.id === ownerId);
    expect(preserved?.isActive).toBe(false);
    expect(preserved?.journals).toHaveLength(1);
    expect(teacherData.members.find((member) => member.id === peerId)?.journals).toEqual([]);
  });
});
