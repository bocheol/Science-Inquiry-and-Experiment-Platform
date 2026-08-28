import { getDb } from "@/lib/db";
import type { MaterialItem, PlanFormData, ReportFormData } from "@/lib/types";
import { getDocumentHistory } from "@/lib/document-history";

type DocumentHistoryItem = { id: string; action: string; actorName: string; createdAt: string };

export type InquiryData = {
  team: { id: string; name: string; teamNumber: number; classNumber: number; leaderUserId: string | null };
  session: {
    id: string;
    stage: string;
    selectedTopic: string | null;
    interestInput: string | null;
    aiBusy: boolean;
    topicSuggestions: TopicSuggestion[];
  };
  members: Array<{ id: string; name: string; loginId: string; isLeader: boolean; alias: string }>;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    senderId: string | null;
    senderName: string | null;
    sequence: number;
    citations: Array<{ title: string; url: string }>;
    createdAt: string;
  }>;
  plan: {
    id: string;
    formData: PlanFormData;
    reviewStatus: string;
    teacherFeedback: string | null;
    updatedAt: string;
    locks: Array<{ fieldKey: string; userId: string; userName: string; expiresAt: string }>;
    history: DocumentHistoryItem[];
  };
  materials: {
    id: string;
    items: MaterialItem[];
    totalAmount: number;
    budgetStatus: string;
    syncStatus: string;
    syncError: string | null;
  } | null;
  report: {
    id: string;
    formData: ReportFormData;
    status: string;
    teacherFeedback: string | null;
    updatedAt: string;
    roles: Array<{ userId: string; name: string; loginId: string; isLeader: boolean; isActive: boolean; description: string }>;
    locks: Array<{ fieldKey: string; userId: string; userName: string; expiresAt: string }>;
    history: DocumentHistoryItem[];
  };
};

export type TopicSuggestion = {
  title: string;
  reason: string;
  relation: string;
  candidateQuestion: string;
  variables: string[];
  feasibility: string;
  safetyNote: string;
};

function parseJson<T>(value: T | string | null, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value;
}

async function buildInquiryData(teamId: string): Promise<InquiryData | null> {
  const db = await getDb();
  const teamResult = await db.query<{
    id: string;
    name: string;
    team_number: number;
    class_number: number;
    leader_user_id: string | null;
    session_id: string | null;
    stage: string | null;
    selected_topic: string | null;
    interest_input: string | null;
    ai_busy: boolean;
    ai_topic_suggestions: { directions?: TopicSuggestion[] } | string;
  }>(
    `SELECT t.id, t.name, t.team_number, c.class_number, t.leader_user_id,
            s.id AS session_id, s.stage, s.selected_topic, s.interest_input,
            s.ai_busy, s.ai_topic_suggestions
       FROM teams t
       JOIN classes c ON c.id = t.class_id
       LEFT JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.id = $1`,
    [teamId],
  );
  const team = teamResult.rows[0];
  if (!team || !team.session_id) return null;
  const membersResult = await db.query<{
    id: string;
    name: string;
    login_id: string;
  }>(
    `SELECT u.id, u.name, u.login_id
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.status = 'active'
      ORDER BY tm.joined_at, u.login_id`,
    [teamId],
  );
  const aliases = new Map(membersResult.rows.map((member, index) => [member.id, `팀원 ${String.fromCharCode(65 + index)}`]));
  const messagesResult = await db.query<{
    id: string;
    role: "user" | "assistant";
    content: string;
    sender_id: string | null;
    sender_name: string | null;
    sequence: number;
    citations: Array<{ title: string; url: string }> | string;
    created_at: Date | string;
  }>(
    `SELECT m.id, m.role, m.content, m.sender_id, u.name AS sender_name,
            m.sequence, m.citations, m.created_at
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.session_id = $1 AND m.role <> 'system'
      ORDER BY m.sequence DESC LIMIT 100`,
    [team.session_id],
  );
  const planResult = await db.query<{
    id: string;
    form_data: PlanFormData | string;
    review_status: string;
    teacher_feedback: string | null;
    updated_at: Date | string;
  }>("SELECT id, form_data, review_status, teacher_feedback, updated_at FROM investigation_plans WHERE session_id = $1", [team.session_id]);
  const plan = planResult.rows[0];
  if (!plan) return null;
  await db.query("DELETE FROM field_locks WHERE expires_at <= $1", [new Date()]);
  const locksResult = await db.query<{
    field_key: string;
    user_id: string;
    user_name: string;
    expires_at: Date | string;
  }>("SELECT field_key, user_id, user_name, expires_at FROM field_locks WHERE plan_id = $1", [plan.id]);
  const materialResult = await db.query<{
    id: string;
    form_data: MaterialItem[] | string;
    total_amount: number;
    budget_status: string;
    sync_status: string;
    sync_error: string | null;
  }>(
    `SELECT id, form_data, total_amount, budget_status, sync_status, sync_error
       FROM material_requests WHERE team_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [teamId],
  );
  const material = materialResult.rows[0];
  await db.query(
    `INSERT INTO reports (id, session_id) VALUES ($1, $2)
     ON CONFLICT (session_id) DO NOTHING`,
    [`report_${team.session_id}`, team.session_id],
  );
  const reportResult = await db.query<{
    id: string;
    form_data: ReportFormData | string;
    status: string;
    teacher_feedback: string | null;
    updated_at: Date | string;
  }>("SELECT id, form_data, status, teacher_feedback, updated_at FROM reports WHERE session_id = $1", [team.session_id]);
  const report = reportResult.rows[0]!;
  const reportFields = await db.query<{ field_key: string; value: string }>(
    "SELECT field_key, value FROM report_fields WHERE report_id = $1",
    [report.id],
  );
  const reportFormData = parseJson(report.form_data, {});
  for (const field of reportFields.rows) reportFormData[field.field_key] = field.value;
  await db.query("DELETE FROM report_field_locks WHERE expires_at <= $1", [new Date()]);
  const reportLocks = await db.query<{
    field_key: string;
    user_id: string;
    user_name: string;
    expires_at: Date | string;
  }>("SELECT field_key, user_id, user_name, expires_at FROM report_field_locks WHERE report_id = $1", [report.id]);
  const reportRoles = await db.query<{
    user_id: string;
    name: string;
    login_id: string;
    active_count: number | string;
    role_description: string | null;
  }>(
    `SELECT u.id AS user_id, u.name, u.login_id,
            MAX(CASE WHEN tm.status = 'active' THEN 1 ELSE 0 END) AS active_count,
            rmr.role_description
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN report_member_roles rmr ON rmr.report_id = $1 AND rmr.user_id = u.id
      WHERE tm.team_id = $2
      GROUP BY u.id, u.name, u.login_id, rmr.role_description
      ORDER BY u.login_id`,
    [report.id, teamId],
  );
  const [planHistory, reportHistory] = await Promise.all([
    getDocumentHistory("plan", plan.id),
    getDocumentHistory("report", report.id),
  ]);
  return {
    team: {
      id: team.id,
      name: team.name,
      teamNumber: team.team_number,
      classNumber: team.class_number,
      leaderUserId: team.leader_user_id,
    },
    session: {
      id: team.session_id,
      stage: team.stage ?? "STARTING",
      selectedTopic: team.selected_topic,
      interestInput: team.interest_input,
      aiBusy: team.ai_busy,
      topicSuggestions: parseJson(team.ai_topic_suggestions, {}).directions ?? [],
    },
    members: membersResult.rows.map((member) => ({
      id: member.id,
      name: member.name,
      loginId: member.login_id,
      isLeader: team.leader_user_id === member.id,
      alias: aliases.get(member.id)!,
    })),
    messages: messagesResult.rows.reverse().map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      senderId: message.sender_id,
      senderName: message.sender_name,
      sequence: message.sequence,
      citations: parseJson(message.citations, []),
      createdAt: new Date(message.created_at).toISOString(),
    })),
    plan: {
      id: plan.id,
      formData: parseJson(plan.form_data, {}),
      reviewStatus: plan.review_status,
      teacherFeedback: plan.teacher_feedback,
      updatedAt: new Date(plan.updated_at).toISOString(),
      locks: locksResult.rows.map((lock) => ({
        fieldKey: lock.field_key,
        userId: lock.user_id,
        userName: lock.user_name,
        expiresAt: new Date(lock.expires_at).toISOString(),
      })),
      history: planHistory,
    },
    materials: material ? {
      id: material.id,
      items: parseJson(material.form_data, []),
      totalAmount: material.total_amount,
      budgetStatus: material.budget_status,
      syncStatus: material.sync_status,
      syncError: material.sync_error,
    } : null,
    report: {
      id: report.id,
      formData: reportFormData,
      status: report.status,
      teacherFeedback: report.teacher_feedback,
      updatedAt: new Date(report.updated_at).toISOString(),
      roles: reportRoles.rows.map((role) => ({
        userId: role.user_id,
        name: role.name,
        loginId: role.login_id,
        isLeader: team.leader_user_id === role.user_id,
        isActive: Number(role.active_count) > 0,
        description: role.role_description ?? "",
      })),
      locks: reportLocks.rows.map((lock) => ({
        fieldKey: lock.field_key,
        userId: lock.user_id,
        userName: lock.user_name,
        expiresAt: new Date(lock.expires_at).toISOString(),
      })),
      history: reportHistory,
    },
  };
}

export async function getInquiryDataForUser(userId: string) {
  const db = await getDb();
  const membership = await db.query<{ team_id: string }>(
    "SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active' ORDER BY joined_at DESC LIMIT 1",
    [userId],
  );
  const teamId = membership.rows[0]?.team_id;
  return teamId ? buildInquiryData(teamId) : null;
}

export async function getInquiryDataForTeam(teamId: string) {
  return buildInquiryData(teamId);
}

export async function assertActiveTeamMember(userId: string, sessionId: string) {
  const db = await getDb();
  const result = await db.query<{ team_id: string }>(
    `SELECT tm.team_id
       FROM team_members tm JOIN inquiry_sessions s ON s.team_id = tm.team_id
      WHERE tm.user_id = $1 AND s.id = $2 AND tm.status = 'active'`,
    [userId, sessionId],
  );
  if (!result.rows[0]) throw new Error("현재 팀 자료에 접근할 수 없습니다.");
  return result.rows[0].team_id;
}
