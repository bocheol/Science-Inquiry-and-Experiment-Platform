import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { firstSentence, getPastRecordDay, listPastRecordDays } from "@/lib/past-records";
import type { SessionUser } from "@/lib/types";

const student = (id: string): SessionUser => ({
  id, name: "합성 학생", loginId: "10901", role: "student", academicYear: 2026,
  classId: "class_2026_9", classNumber: 9, mustChangePassword: false,
});
const teacher = (id: string, isMaster = false): SessionUser => ({
  id, name: "합성 교사", loginId: id, role: "teacher", academicYear: 2026,
  classId: null, classNumber: null, mustChangePassword: false, isMaster,
});

let cycleId = "";

beforeAll(async () => {
  const db = await getDb();
  cycleId = (await db.query<{ id: string }>("SELECT id FROM inquiry_cycles WHERE session_id = 'demo_session_1' LIMIT 1")).rows[0]!.id;
  await db.query(
    `INSERT INTO messages (id, session_id, cycle_id, sender_id, role, content, sequence, created_at)
     VALUES ('history_message_student', 'demo_session_1', $1, 'demo_student_1', 'user', '자정 경계 한글검색 질문입니다.', 901, '2026-09-08T15:30:00Z'),
            ('history_message_ai', 'demo_session_1', $1, NULL, 'assistant', '관찰값을 먼저 비교해 보세요.', 902, '2026-09-08T15:31:00Z')`,
    [cycleId],
  );
  await db.query(
    `INSERT INTO discussion_entries (id, session_id, cycle_id, author_id, kind, activity_date, content, participants, created_at)
     VALUES ('history_peer', 'demo_session_1', $1, 'demo_student_2', 'peer', '2026-09-09', '우리끼리 정한 실험 순서', '[]', '2026-09-09T01:00:00Z')`,
    [cycleId],
  );
  await db.query("INSERT INTO inquiry_cycles (id, session_id, ordinal, title, status, origin) VALUES ('history_old_class_cycle', 'demo_session_1', 91, '지난 탐구 회차', 'completed', 'configured')");
  await db.query("INSERT INTO messages (id, session_id, cycle_id, sender_id, role, content, sequence, created_at) VALUES ('history_old_class_message', 'demo_session_1', 'history_old_class_cycle', 'demo_student_1', 'user', '이전 회차에서 보존한 대화', 1, '2026-08-30T02:00:00Z')");
  await db.query(
    `INSERT INTO experiment_journals
       (id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations, reflections, write_version)
     VALUES ('history_journal_own', 'demo_session_1', $1, 'demo_student_1', 91, '2026-09-09', '한글검색 시약 준비', '색이 붉어졌다.', '다음에는 농도를 바꾼다.', 1),
            ('history_journal_other', 'demo_session_1', $1, 'demo_student_2', 92, '2026-09-09', '다른 학생 활동', '다른 학생 관찰', '다른 학생 생각', 1)`,
    [cycleId],
  );

  for (const [id, master] of [["history_assigned_teacher", false], ["history_unassigned_teacher", false], ["history_master_teacher", true]] as const) {
    await db.query(
      "INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password, is_master) VALUES ($1, '합성 교사', $1, 2026, 'teacher', 'unused', FALSE, $2)",
      [id, master],
    );
  }
  await db.query("INSERT INTO clubs (id, academic_year, name, created_by) VALUES ('history_club', 2026, '합성 동아리', 'history_assigned_teacher')");
  await db.query("INSERT INTO club_teacher_assignments (club_id, teacher_id, assigned_by) VALUES ('history_club', 'history_assigned_teacher', 'history_assigned_teacher')");
  await db.query("INSERT INTO teams (id, class_id, club_id, team_number, name, status) VALUES ('history_club_team', NULL, 'history_club', 19, '동아리 기록 팀', 'archived')");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('history_club_session', 'history_club_team')");
  await db.query("INSERT INTO inquiry_cycles (id, session_id, ordinal, title, status, origin) VALUES ('history_club_cycle', 'history_club_session', 1, '동아리 1차', 'completed', 'configured')");
  await db.query("INSERT INTO messages (id, session_id, cycle_id, role, content, sequence, created_at) VALUES ('history_club_message', 'history_club_session', 'history_club_cycle', 'assistant', '담당 교사만 찾을 동아리 기록', 1, '2026-09-07T02:00:00Z')");
});

afterAll(async () => {
  const db = await getDb();
  await db.query("UPDATE team_members SET status = 'active', left_at = NULL WHERE team_id = 'demo_team_1' AND user_id = 'demo_student_1'");
});

describe("지난 기록", () => {
  it("긴 한글 본문의 첫 문장을 짧게 만든다", () => {
    expect(firstSentence("첫 문장입니다. 둘째 문장입니다.")).toBe("첫 문장입니다.");
    expect(firstSentence("가".repeat(110))).toHaveLength(101);
  });

  it("한국 시간 날짜로 대화와 본인 일지를 묶고 다른 학생 일지는 숨긴다", async () => {
    const list = await listPastRecordDays(student("demo_student_1"), { teamId: "demo_team_1", limit: 20 });
    const day = list.days.find((item) => item.date === "2026-09-09");
    expect(day).toMatchObject({ conversationCount: 3, journalCount: 1 });
    const detail = await getPastRecordDay(student("demo_student_1"), { teamId: "demo_team_1", cycleId, date: "2026-09-09" });
    expect(detail.conversations.map((item) => item.id)).toEqual(expect.arrayContaining(["history_message_student", "history_message_ai", "history_peer"]));
    expect(detail.journals.map((item) => item.id)).toEqual(["history_journal_own"]);
    expect(detail.journals[0]!.studentName).toBeNull();
  });

  it("한글 제목·본문 검색과 대화/일지 필터를 서버 범위 안에서 적용한다", async () => {
    const journal = await listPastRecordDays(student("demo_student_1"), { teamId: "demo_team_1", query: "한글검색", filter: "journal" });
    expect(journal.days).toHaveLength(1);
    expect(journal.days[0]).toMatchObject({ date: "2026-09-09", conversationCount: 0, journalCount: 1 });
    const conversation = await listPastRecordDays(student("demo_student_1"), { teamId: "demo_team_1", query: "관찰값", filter: "conversation" });
    expect(conversation.days[0]).toMatchObject({ conversationCount: 1, journalCount: 0 });
    const completedCycle = await listPastRecordDays(student("demo_student_1"), { teamId: "demo_team_1", query: "이전 회차" });
    expect(completedCycle.days[0]).toMatchObject({ cycleId: "history_old_class_cycle", cycleStatus: "completed" });
  });

  it("학생이 팀에서 제거되면 목록과 직접 날짜 열람을 모두 차단한다", async () => {
    const db = await getDb();
    await db.query("UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE team_id = 'demo_team_1' AND user_id = 'demo_student_1'");
    try {
      expect((await listPastRecordDays(student("demo_student_1"), { teamId: "demo_team_1" })).days).toEqual([]);
      await expect(getPastRecordDay(student("demo_student_1"), { teamId: "demo_team_1", cycleId, date: "2026-09-09" })).rejects.toThrow(/권한/);
      expect((await listPastRecordDays(teacher("history_unassigned_teacher"), { teamId: "demo_team_1", query: "한글검색" })).days).toHaveLength(1);
    } finally {
      await db.query("UPDATE team_members SET status = 'active', left_at = NULL WHERE team_id = 'demo_team_1' AND user_id = 'demo_student_1'");
    }
  });

  it("교사는 수업 팀을 공동 조회하고 동아리는 담당 또는 마스터만 검색한다", async () => {
    const assigned = await listPastRecordDays(teacher("history_assigned_teacher"), { query: "동아리 기록" });
    const master = await listPastRecordDays(teacher("history_master_teacher", true), { query: "동아리 기록" });
    const unassigned = await listPastRecordDays(teacher("history_unassigned_teacher"), { query: "동아리 기록" });
    expect(assigned.days.map((item) => item.teamId)).toContain("history_club_team");
    expect(master.days.map((item) => item.teamId)).toContain("history_club_team");
    expect(unassigned.days.map((item) => item.teamId)).not.toContain("history_club_team");

    const classRecords = await listPastRecordDays(teacher("history_unassigned_teacher"), { teamId: "demo_team_1", query: "한글검색" });
    expect(classRecords.days[0]?.teamId).toBe("demo_team_1");
    const teacherDetail = await getPastRecordDay(teacher("history_unassigned_teacher"), { teamId: "demo_team_1", cycleId, date: "2026-09-09" });
    expect(teacherDetail.journals).toHaveLength(2);
    expect(teacherDetail.journals.map((item) => item.studentName)).toEqual(expect.arrayContaining(["김하늘", "이새봄"]));
  });
});
