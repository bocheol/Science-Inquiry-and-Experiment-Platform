import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import {
  changeEvaluationRoundStatus,
  createEvaluationRound,
  getEvaluationManagementData,
  publishEvaluationRound,
  saveEvaluationTeacherSummary,
} from "@/lib/evaluation-service";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { createId } from "@/lib/id";

const students = ["publication_student_a", "publication_student_b"];
const teamId = "publication_team";
const sessionId = "publication_session";
let roundId = "";

function expectOneConflict(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(FormWriteConflict);
}

beforeAll(async () => {
  const db = await getDb();
  for (const [index, studentId] of students.entries()) {
    await db.query(
      `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
       VALUES ($1, $2, $3, 2026, 'student', 'class_2026_6', 'unused', FALSE)`,
      [studentId, `공개검증학생${index + 1}`, `publication-${index + 1}`],
    );
  }
  await db.query("INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_6', 96, '공개검증팀', $2)", [teamId, students[0]]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'REPORTING')", [sessionId, teamId]);
  for (const studentId of students) {
    await db.query("INSERT INTO team_members (id, team_id, user_id, status) VALUES ($1, $2, $3, 'active')", [createId("member"), teamId, studentId]);
  }
  roundId = await createEvaluationRound("teacher_bootstrap", { classNumber: 6, title: "평가 공개 경합 검증", optionalItem: "none" });
  await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "open");
  await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "close");
});

describe("teacher summary and publication concurrency", () => {
  it("keeps the round unpublished when a required summary is missing", async () => {
    await expect(publishEvaluationRound("teacher_bootstrap", roundId)).rejects.toThrow("교사 종합 피드백");
    const db = await getDb();
    expect((await db.query("SELECT status FROM evaluation_rounds WHERE id = $1", [roundId])).rows[0].status).toBe("reviewing");
    expect((await db.query("SELECT COUNT(*)::int AS count FROM evaluation_publications WHERE round_id = $1 AND published_at IS NOT NULL", [roundId])).rows[0].count).toBe(0);
  });

  it("allows one first summary and one revision from each shared base", async () => {
    expectOneConflict(await Promise.allSettled([
      saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "첫 교사 의견 A", expectedVersion: null }),
      saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "첫 교사 의견 B", expectedVersion: null }),
    ]));
    let management = await getEvaluationManagementData(6, roundId);
    let target = management.selected!.progress.find((student) => student.studentId === students[0])!;
    expect(target.teacherSummaryVersion).toBe(1);
    expect(await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: target.teacherSummary, expectedVersion: null })).toEqual({ version: 1 });
    expectOneConflict(await Promise.allSettled([
      saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "수정 교사 의견 A", expectedVersion: 1 }),
      saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "수정 교사 의견 B", expectedVersion: 1 }),
    ]));
    management = await getEvaluationManagementData(6, roundId);
    target = management.selected!.progress.find((student) => student.studentId === students[0])!;
    expect(target.teacherSummaryVersion).toBe(2);
  });

  it("requires the explicit zero version for a legacy summary", async () => {
    const db = await getDb();
    await db.query("UPDATE evaluation_publications SET write_version = 0 WHERE round_id = $1 AND student_id = $2", [roundId, students[0]]);
    await expect(saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "잘못된 첫 저장", expectedVersion: null })).rejects.toBeInstanceOf(FormWriteConflict);
    await expect(saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "레거시 의견 수정", expectedVersion: 0 })).resolves.toEqual({ version: 1 });
  });

  it("publishes one immutable snapshot and makes a repeated publish harmless", async () => {
    await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[1]!, teacherSummary: "두 번째 학생 교사 의견", expectedVersion: null });
    await expect(publishEvaluationRound("teacher_bootstrap", roundId)).resolves.toEqual({ published: true, studentCount: 2 });
    const db = await getDb();
    const before = await db.query("SELECT student_id, teacher_summary, peer_averages, approved_comments, published_at FROM evaluation_publications WHERE round_id = $1 ORDER BY student_id", [roundId]);
    expect(before.rows).toHaveLength(2);
    expect(before.rows.every((row) => row.published_at)).toBe(true);
    await expect(publishEvaluationRound("teacher_bootstrap", roundId)).resolves.toEqual({ published: false, studentCount: 0 });
    const after = await db.query("SELECT student_id, teacher_summary, peer_averages, approved_comments, published_at FROM evaluation_publications WHERE round_id = $1 ORDER BY student_id", [roundId]);
    expect(after.rows).toEqual(before.rows);
    await expect(saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: students[0]!, teacherSummary: "공개 뒤 변경", expectedVersion: 1 })).rejects.toThrow("평가 상태가 변경");
    await expect(changeEvaluationRoundStatus("teacher_bootstrap", roundId, "reopen")).rejects.toThrow("현재 상태");
  });
});
