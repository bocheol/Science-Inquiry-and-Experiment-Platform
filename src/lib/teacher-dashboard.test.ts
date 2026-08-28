import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { getDb } from "@/lib/db";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { buildTeacherProgressExport, teamProgressRows } from "@/lib/teacher-export";

const teamId = "dashboard_test_team";
const sessionId = "dashboard_test_session";
const activeWriterId = "dashboard_active_writer";
const activePeerId = "dashboard_active_peer";
const removedWriterId = "dashboard_removed_writer";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '진척 작성자', '10891', 2026, 'student', 'class_2026_8', 'unused', FALSE),
            ($2, '진척 팀원', '10892', 2026, 'student', 'class_2026_8', 'unused', FALSE),
            ($3, '이전 팀원', '10893', 2026, 'student', 'class_2026_8', 'unused', FALSE)`,
    [activeWriterId, activePeerId, removedWriterId],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_8', 98, '=진척시험조', $2)",
    [teamId, activeWriterId],
  );
  await db.query(
    `INSERT INTO team_members (id, team_id, user_id, status) VALUES
      ('dashboard_member_1', $1, $2, 'active'),
      ('dashboard_member_2', $1, $3, 'active'),
      ('dashboard_member_3', $1, $4, 'inactive')`,
    [teamId, activeWriterId, activePeerId, removedWriterId],
  );
  await db.query(
    `INSERT INTO inquiry_sessions (id, team_id, selected_topic, stage)
     VALUES ($1, $2, '+온도와 반응 속도', 'REPORTING')`,
    [sessionId, teamId],
  );
  await db.query(
    "INSERT INTO investigation_plans (id, session_id, review_status) VALUES ('dashboard_plan', $1, 'approved')",
    [sessionId],
  );
  await db.query(
    "INSERT INTO reports (id, session_id, status) VALUES ('dashboard_report', $1, 'submitted')",
    [sessionId],
  );
  await db.query(
    `INSERT INTO messages (id, session_id, role, content, sequence) VALUES
      ('dashboard_message_1', $1, 'user', '질문 1', 1),
      ('dashboard_message_2', $1, 'assistant', '답변 1', 2),
      ('dashboard_message_3', $1, 'user', '질문 2', 3)`,
    [sessionId],
  );
  await db.query(
    `INSERT INTO experiment_journals
      (id, session_id, student_id, session_number, journal_date, activities, observations, reflections)
     VALUES ('dashboard_journal_1', $1, $2, 1, '2026-10-01', '비공개 활동', '관찰', '성찰'),
            ('dashboard_journal_2', $1, $2, 2, '2026-10-02', '비공개 활동', '관찰', '성찰'),
            ('dashboard_journal_removed', $1, $3, 1, '2026-09-30', '제거 학생 기록', '관찰', '성찰')`,
    [sessionId, activeWriterId, removedWriterId],
  );
  await db.query(
    `INSERT INTO material_requests
      (id, submission_id, session_id, team_id, submitted_by, form_data, total_amount, budget_status, sync_status)
     VALUES ('dashboard_material', 'dashboard_submission', $1, $2, $3, '{}', 120000, 'over_budget', 'failed')`,
    [sessionId, teamId, activeWriterId],
  );
});

describe("teacher progress dashboard and export", () => {
  it("aggregates current-member progress and actionable states accurately", async () => {
    const data = await getTeacherDashboardData();
    const team = data.teams.find((item) => item.id === teamId);
    expect(team).toMatchObject({
      memberCount: 2,
      messageCount: 2,
      journalStudentCount: 1,
      journalEntryCount: 2,
      planStatus: "approved",
      reportStatus: "submitted",
      attention: "teacher",
    });
    expect(team?.attentionReasons).toEqual([
      "보고서 검토 대기",
      "준비물 시트 전송 실패",
      "준비물 예산 확인",
    ]);
    expect(data.students.find((student) => student.id === activeWriterId)?.journalCount).toBe(2);
    expect(data.students.find((student) => student.id === activePeerId)?.journalCount).toBe(0);
  });

  it("creates class-filtered CSV and Excel files without journal contents", async () => {
    const data = await getTeacherDashboardData();
    const rows = teamProgressRows(data, 8);
    const row = rows.find((item) => item.학급 === 8);
    expect(row?.팀).toBe("'=진척시험조");
    expect(row?.탐구주제).toBe("'+온도와 반응 속도");

    const csv = buildTeacherProgressExport(data, "csv", 8).toString("utf8");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("일지작성학생");
    expect(csv).not.toContain("비공개 활동");

    const workbook = XLSX.read(buildTeacherProgressExport(data, "xlsx", 8), { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["팀 진척", "학생 일지 현황"]);
    const teamRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["팀 진척"]!);
    const studentRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["학생 일지 현황"]!);
    expect(teamRows.some((item) => item.팀 === "'=진척시험조" && item.일지건수 === 2)).toBe(true);
    expect(studentRows.some((item) => item.학번 === "10891" && item.일지건수 === 2)).toBe(true);
    expect(JSON.stringify(workbook)).not.toContain("비공개 활동");
  });
});
