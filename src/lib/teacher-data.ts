import { getDb } from "@/lib/db";

export type AttentionLevel = "teacher" | "student" | "none";

export type TeacherDashboardData = {
  students: Array<{
    id: string;
    name: string;
    loginId: string;
    classNumber: number;
    teamId: string | null;
    teamNumber: number | null;
    isLeader: boolean;
    mustChangePassword: boolean;
    journalCount: number;
    lastJournalDate: string | null;
  }>;
  inactiveStudents: Array<{
    id: string;
    name: string;
    loginId: string;
    classNumber: number;
  }>;
  teams: Array<{
    id: string;
    name: string;
    teamNumber: number;
    classNumber: number;
    leaderUserId: string | null;
    memberCount: number;
    sessionId: string | null;
    topic: string | null;
    stage: string | null;
    planStatus: string | null;
    reportStatus: string | null;
    messageCount: number;
    journalStudentCount: number;
    journalEntryCount: number;
    materialSyncStatus: string | null;
    materialBudgetStatus: string | null;
    lastActivityAt: string | null;
    attention: AttentionLevel;
    attentionReasons: string[];
  }>;
  archivedTeams: Array<{
    id: string;
    name: string;
    teamNumber: number;
    classNumber: number;
    memberCount: number;
    archivedAt: string | null;
    archivedByName: string | null;
  }>;
  counts: { students: number; teams: number; unassigned: number; pendingPlans: number };
};

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestDate(...values: Array<Date | string | null | undefined>) {
  const dates = values.map(toIso).filter((value): value is string => Boolean(value));
  return dates.sort().at(-1) ?? null;
}

function attentionFor(team: {
  sessionId: string | null;
  planStatus: string | null;
  reportStatus: string | null;
  materialSyncStatus: string | null;
  materialBudgetStatus: string | null;
  memberCount: number;
  journalStudentCount: number;
}) {
  const teacherReasons: string[] = [];
  const studentReasons: string[] = [];
  if (team.planStatus === "pending") teacherReasons.push("계획서 승인 대기");
  if (team.planStatus === "reapproval_required") teacherReasons.push("계획서 재승인 필요");
  if (team.reportStatus === "submitted") teacherReasons.push("보고서 검토 대기");
  if (team.materialSyncStatus === "failed") teacherReasons.push("준비물 시트 전송 실패");
  if (team.materialBudgetStatus === "over_budget") teacherReasons.push("준비물 예산 확인");

  if (!team.sessionId) studentReasons.push("탐구 시작 전");
  else if (!team.planStatus || team.planStatus === "draft") studentReasons.push("계획서 작성 필요");
  else if (team.planStatus === "feedback") studentReasons.push("계획서 수정 필요");
  if (team.planStatus === "approved" && team.journalStudentCount < team.memberCount) {
    studentReasons.push(`일지 미작성 ${team.memberCount - team.journalStudentCount}명`);
  }
  if (team.reportStatus === "feedback") studentReasons.push("보고서 수정 필요");

  if (teacherReasons.length) return { attention: "teacher" as const, attentionReasons: teacherReasons };
  if (studentReasons.length) return { attention: "student" as const, attentionReasons: studentReasons };
  return { attention: "none" as const, attentionReasons: [] };
}

export async function getTeacherDashboardData(): Promise<TeacherDashboardData> {
  const db = await getDb();
  const [studentResult, inactiveStudentResult, teamResult, archivedTeamResult, memberCounts, messageCounts, journalCounts, materialRows] = await Promise.all([
    db.query<{
      id: string; name: string; login_id: string; class_number: number; team_id: string | null;
      team_number: number | null; leader_user_id: string | null; must_change_password: boolean;
    }>(
      `SELECT u.id, u.name, u.login_id, c.class_number, t.id AS team_id, t.team_number,
              t.leader_user_id, u.must_change_password
         FROM users u
         JOIN classes c ON c.id = u.class_id
         LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.status = 'active'
           AND tm.team_id IN (SELECT id FROM teams WHERE club_id IS NULL)
         LEFT JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
        WHERE u.role = 'student' AND u.status = 'active'
        ORDER BY c.class_number, u.login_id`,
    ),
    db.query<{ id: string; name: string; login_id: string; class_number: number }>(
      `SELECT u.id, u.name, u.login_id, c.class_number
         FROM users u JOIN classes c ON c.id = u.class_id
        WHERE u.role = 'student' AND u.status = 'inactive'
        ORDER BY c.class_number, u.login_id`,
    ),
    db.query<{
      id: string; name: string; team_number: number; class_number: number; leader_user_id: string | null;
      session_id: string | null; selected_topic: string | null; stage: string | null;
      last_activity_at: Date | string | null; review_status: string | null; plan_updated_at: Date | string | null;
      report_status: string | null; report_updated_at: Date | string | null;
    }>(
      `SELECT t.id, t.name, t.team_number, c.class_number, t.leader_user_id,
              s.id AS session_id, s.selected_topic, s.stage, s.last_activity_at,
              p.review_status, p.updated_at AS plan_updated_at,
              r.status AS report_status, r.updated_at AS report_updated_at
         FROM teams t
         JOIN classes c ON c.id = t.class_id
         LEFT JOIN inquiry_sessions s ON s.team_id = t.id
         LEFT JOIN investigation_plans p ON p.session_id = s.id
         LEFT JOIN reports r ON r.session_id = s.id
        WHERE t.status = 'active'
        ORDER BY c.class_number, t.team_number`,
    ),
    db.query<{
      id: string; name: string; team_number: number; class_number: number;
      archived_at: Date | string | null; archived_by_name: string | null;
    }>(
      `SELECT t.id, t.name, t.team_number, c.class_number, t.archived_at,
              archiver.name AS archived_by_name
         FROM teams t
         JOIN classes c ON c.id = t.class_id
         LEFT JOIN users archiver ON archiver.id = t.archived_by
        WHERE t.status = 'archived'
        ORDER BY c.class_number, t.team_number`,
    ),
    db.query<{ team_id: string; count: string }>(
      "SELECT team_id, COUNT(*)::text AS count FROM team_members WHERE status = 'active' GROUP BY team_id",
    ),
    db.query<{ session_id: string; count: string }>(
      "SELECT session_id, COUNT(*)::text AS count FROM messages WHERE role = 'user' GROUP BY session_id",
    ),
    db.query<{ session_id: string; student_id: string; count: string; last_journal_at: Date | string }>(
      `SELECT session_id, student_id, COUNT(*)::text AS count, MAX(updated_at) AS last_journal_at
         FROM experiment_journals
        GROUP BY session_id, student_id`,
    ),
    db.query<{
      team_id: string; session_id: string; sync_status: string; budget_status: string; submitted_at: Date | string;
    }>(
      `SELECT team_id, session_id, sync_status, budget_status, submitted_at
         FROM material_requests
        ORDER BY submitted_at DESC`,
    ),
  ]);

  const memberCountMap = new Map(memberCounts.rows.map((row) => [row.team_id, Number(row.count)]));
  const messageCountMap = new Map(messageCounts.rows.map((row) => [row.session_id, Number(row.count)]));
  const journalMap = new Map(journalCounts.rows.map((row) => [
    `${row.session_id}:${row.student_id}`,
    { count: Number(row.count), lastJournalAt: toIso(row.last_journal_at) },
  ]));
  const materialMap = new Map<string, (typeof materialRows.rows)[number]>();
  for (const row of materialRows.rows) if (!materialMap.has(row.team_id)) materialMap.set(row.team_id, row);
  const sessionByTeam = new Map(teamResult.rows.map((row) => [row.id, row.session_id]));

  const students = studentResult.rows.map((row) => {
    const sessionId = row.team_id ? sessionByTeam.get(row.team_id) : null;
    const journal = sessionId ? journalMap.get(`${sessionId}:${row.id}`) : undefined;
    return {
      id: row.id,
      name: row.name,
      loginId: row.login_id,
      classNumber: row.class_number,
      teamId: row.team_id,
      teamNumber: row.team_number,
      isLeader: row.leader_user_id === row.id,
      mustChangePassword: row.must_change_password,
      journalCount: journal?.count ?? 0,
      lastJournalDate: journal?.lastJournalAt ?? null,
    };
  });
  const inactiveStudents = inactiveStudentResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    loginId: row.login_id,
    classNumber: row.class_number,
  }));

  const teams = teamResult.rows.map((row) => {
    const members = students.filter((student) => student.teamId === row.id);
    const memberJournals = members
      .map((student) => journalMap.get(`${row.session_id}:${student.id}`))
      .filter((journal): journal is { count: number; lastJournalAt: string | null } => Boolean(journal));
    const material = materialMap.get(row.id);
    const progress = {
      id: row.id,
      name: row.name,
      teamNumber: row.team_number,
      classNumber: row.class_number,
      leaderUserId: row.leader_user_id,
      memberCount: memberCountMap.get(row.id) ?? 0,
      sessionId: row.session_id,
      topic: row.selected_topic,
      stage: row.stage,
      planStatus: row.review_status,
      reportStatus: row.report_status,
      messageCount: row.session_id ? messageCountMap.get(row.session_id) ?? 0 : 0,
      journalStudentCount: memberJournals.length,
      journalEntryCount: memberJournals.reduce((sum, journal) => sum + journal.count, 0),
      materialSyncStatus: material?.sync_status ?? null,
      materialBudgetStatus: material?.budget_status ?? null,
      lastActivityAt: latestDate(
        row.last_activity_at,
        row.plan_updated_at,
        row.report_updated_at,
        ...memberJournals.map((journal) => journal.lastJournalAt),
        material?.submitted_at,
      ),
    };
    return { ...progress, ...attentionFor(progress) };
  });

  const archivedTeams = archivedTeamResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    teamNumber: row.team_number,
    classNumber: row.class_number,
    memberCount: memberCountMap.get(row.id) ?? 0,
    archivedAt: toIso(row.archived_at),
    archivedByName: row.archived_by_name,
  }));

  return {
    students,
    inactiveStudents,
    teams,
    archivedTeams,
    counts: {
      students: students.length,
      teams: teams.length,
      unassigned: students.filter((student) => !student.teamId).length,
      pendingPlans: teams.filter((team) => team.planStatus === "pending" || team.planStatus === "reapproval_required").length,
    },
  };
}
