import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { PRACTICE_MATERIAL_SQL } from "@/lib/material-practice";
import type { MaterialItem, PlanFormData, ReportFormData } from "@/lib/types";
import { getDocumentHistory } from "@/lib/document-history";
import type { FormFieldDefinition } from "@/lib/club-settings";
import { defaultClubConfigDefinition } from "@/lib/club-settings";
import { getLatestPlanSubmission, getPlanSnapshot, planCycleDefinition, planSnapshotContentHash, type PlanDocumentSnapshot, type PlanSubmission } from "@/lib/plan-snapshots";
import { getLatestPlanAiReviewForPlan, type PlanAiReviewView } from "@/lib/plan-ai-review";
import { getCycleJourney, type CycleJourneyItem } from "@/lib/cycle-analysis";

type DocumentHistoryItem = { id: string; action: string; actorName: string; createdAt: string };

export type MaterialRequestView = {
  id: string;
  items: MaterialItem[];
  totalAmount: number;
  budgetStatus: string;
  syncStatus: string;
  syncError: string | null;
  isPractice?: boolean;
  submittedAt?: string;
};

export type InquiryData = {
  team: { id: string; name: string; teamNumber: number; classNumber: number; leaderUserId: string | null; clubId?: string | null; activityName?: string };
  session: {
    id: string;
    stage: string;
    selectedTopic: string | null;
    interestInput: string | null;
    aiBusy: boolean;
    topicSuggestions: TopicSuggestion[];
    cycle: { id: string; ordinal: number; title: string; status: string; origin: "configured" | "legacy_unclassified"; startedAt: string | null; endedAt: string | null } | null;
    cycles: CycleJourneyItem[];
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
    configVersionId: string | null;
    description: string;
    fields: FormFieldDefinition[];
    latestSubmission: PlanSubmission | null;
    latestSubmissionSnapshot: PlanDocumentSnapshot | null;
    studentAiReview: (PlanAiReviewView & { isCurrent: boolean }) | null;
    teacherAiReview: PlanAiReviewView | null;
  };
  materials: MaterialRequestView | null;
  pendingMaterials?: MaterialRequestView[];
  report: {
    id: string;
    reviewVersion: number;
    formData: ReportFormData;
    status: string;
    teacherFeedback: string | null;
    updatedAt: string;
    roles: Array<{ userId: string; name: string; loginId: string; isLeader: boolean; isActive: boolean; description: string }>;
    locks: Array<{ fieldKey: string; userId: string; userName: string; expiresAt: string }>;
    history: DocumentHistoryItem[];
    configVersionId: string | null;
    description: string;
    fields: FormFieldDefinition[];
  };
  customTabs: Array<{
    id: string;
    title: string;
    definition: {
      description?: string;
      responseMode?: "team" | "individual";
      workflow?: "save" | "review";
      useForExam?: boolean;
      fields?: FormFieldDefinition[];
    };
  }>;
  clubFeatures: { materials: boolean; selfEvaluation: boolean; peerEvaluation: boolean; exam: boolean };
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
    club_id: string | null;
    activity_name: string;
    leader_user_id: string | null;
    session_id: string | null;
    stage: string | null;
    selected_topic: string | null;
    interest_input: string | null;
    ai_busy: boolean;
    ai_topic_suggestions: { directions?: TopicSuggestion[] } | string;
  }>(
    `SELECT t.id, t.name, t.team_number, c.class_number, t.club_id, COALESCE(c.name, cl.name) AS activity_name, t.leader_user_id,
            s.id AS session_id, s.stage, s.selected_topic, s.interest_input,
            FALSE AS ai_busy,
            s.ai_topic_suggestions
       FROM teams t
       LEFT JOIN classes c ON c.id = t.class_id
       LEFT JOIN clubs cl ON cl.id = t.club_id
       LEFT JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.id = $1`,
    [teamId],
  );
  const team = teamResult.rows[0];
  if (!team || !team.session_id) return null;
  const cycleResult = await db.query<{
    id: string; ordinal: number; title: string; status: string; origin: "configured" | "legacy_unclassified";
    started_at: Date | string | null; ended_at: Date | string | null;
  }>(`SELECT id, ordinal, title, status, origin, started_at, ended_at FROM inquiry_cycles
       WHERE session_id = $1
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, ordinal DESC LIMIT 1`, [team.session_id]);
  const cycleRow = cycleResult.rows[0];
  const cycle = cycleRow ? {
    id: cycleRow.id,
    ordinal: Number(cycleRow.ordinal),
    title: cycleRow.title,
    status: cycleRow.status,
    origin: cycleRow.origin,
    startedAt: cycleRow.started_at ? new Date(cycleRow.started_at).toISOString() : null,
    endedAt: cycleRow.ended_at ? new Date(cycleRow.ended_at).toISOString() : null,
  } : null;
  const activeAiJob = await db.query(
    `SELECT id FROM ai_generation_jobs
      WHERE resource_key = $1 AND status = 'processing' AND lease_until > $2
      LIMIT 1`,
    [`inquiry:${team.session_id}`, new Date()],
  );
  team.ai_busy = Boolean(activeAiJob.rows[0]);
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
      WHERE m.session_id = $1 AND m.cycle_id = $2 AND m.role <> 'system'
      ORDER BY m.sequence DESC LIMIT 100`,
    [team.session_id, cycle?.id ?? null],
  );
  const planResult = await db.query<{
    id: string;
    form_data: PlanFormData | string;
    review_status: string;
    teacher_feedback: string | null;
    updated_at: Date | string;
    config_version_id: string | null;
    config_definition: Record<string, unknown> | string | null;
  }>(`SELECT p.id, p.form_data, p.review_status, p.teacher_feedback, p.updated_at, p.config_version_id,
             v.definition AS config_definition
        FROM investigation_plans p LEFT JOIN club_config_versions v ON v.id = p.config_version_id
       WHERE p.session_id = $1`, [team.session_id]);
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
    is_practice: boolean;
    submitted_at: Date | string;
  }>(
    `SELECT m.id, m.form_data, m.total_amount, m.budget_status, m.sync_status, m.sync_error, m.submitted_at, ${PRACTICE_MATERIAL_SQL} AS is_practice
       FROM material_requests m LEFT JOIN users u ON u.id = m.submitted_by
       WHERE m.team_id = $1 AND m.cycle_id = $2 ORDER BY m.submitted_at DESC, m.id DESC LIMIT 1`,
    [teamId, cycle?.id ?? null],
  );
  const material = materialResult.rows[0];
  const pendingMaterials = await db.query<(typeof materialResult.rows)[number]>(
    `SELECT m.id, m.form_data, m.total_amount, m.budget_status, m.sync_status, m.sync_error, m.submitted_at, ${PRACTICE_MATERIAL_SQL} AS is_practice
       FROM material_requests m LEFT JOIN users u ON u.id = m.submitted_by
       WHERE m.team_id = $1 AND m.cycle_id = $2 AND m.sync_status <> 'synced' AND NOT ${PRACTICE_MATERIAL_SQL}
       ORDER BY m.submitted_at ASC, m.id ASC`, [teamId, cycle?.id ?? null],
  );
  const materialView = (row: (typeof materialResult.rows)[number]): MaterialRequestView => ({
    id: row.id, items: parseJson(row.form_data, []), totalAmount: Number(row.total_amount),
    budgetStatus: row.budget_status, syncStatus: row.sync_status, syncError: row.sync_error,
    isPractice: row.is_practice, submittedAt: new Date(row.submitted_at).toISOString(),
  });
  await db.query(
    `INSERT INTO reports (id, session_id, cycle_id) VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING`,
    [`report_${team.session_id}`, team.session_id, cycle?.id ?? null],
  );
  const reportResult = await db.query<{
    id: string;
    review_version: number;
    form_data: ReportFormData | string;
    status: string;
    teacher_feedback: string | null;
    updated_at: Date | string;
    config_version_id: string | null;
    config_definition: Record<string, unknown> | string | null;
  }>(`SELECT r.id, r.form_data, r.status, r.teacher_feedback, r.updated_at, r.write_version AS review_version, r.config_version_id,
             v.definition AS config_definition
        FROM reports r LEFT JOIN club_config_versions v ON v.id = r.config_version_id
       WHERE r.session_id = $1`, [team.session_id]);
  const report = reportResult.rows[0]!;
  const planDefinition = parseJson(plan.config_definition, defaultClubConfigDefinition("plan"));
  const reportDefinition = parseJson(report.config_definition, defaultClubConfigDefinition("report"));
  const reportFields = await db.query<{ field_key: string; value: string }>(
    "SELECT field_key, value FROM report_fields WHERE report_id = $1",
    [report.id],
  );
  const reportFormData = parseJson(report.form_data, {});
  for (const field of reportFields.rows) reportFormData[field.field_key] = field.value;
  for (const field of (Array.isArray(reportDefinition.fields) ? reportDefinition.fields as FormFieldDefinition[] : [])) {
    if ((field.kind === "table" || field.kind === "multiple_choice") && typeof reportFormData[field.id] === "string") {
      try { reportFormData[field.id] = JSON.parse(reportFormData[field.id] as string); } catch { reportFormData[field.id] = []; }
    }
    if (field.kind === "checkbox" && typeof reportFormData[field.id] === "string") reportFormData[field.id] = reportFormData[field.id] === "true";
  }
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
  const [planHistory, reportHistory, cycleJourney] = await Promise.all([
    getDocumentHistory("plan", plan.id, cycle?.id),
    getDocumentHistory("report", report.id, cycle?.id),
    getCycleJourney(team.session_id),
  ]);
  const customTabsResult = team.club_id ? await db.query<{
    id: string; title: string; definition: InquiryData["customTabs"][number]["definition"] | string;
  }>(`SELECT id, title, definition FROM club_config_versions
       WHERE club_id = $1 AND config_type = 'custom_tab' AND status = 'published'
       ORDER BY created_at, title`, [team.club_id]) : { rows: [] };
  const featureResult = team.club_id ? await db.query<{ config_type: string }>(`SELECT DISTINCT config_type FROM club_config_versions
    WHERE club_id = $1 AND config_key = 'default' AND status = 'published'`, [team.club_id]) : { rows: [] };
  const features = new Set(featureResult.rows.map((item) => item.config_type));
  const latestSubmission = await getLatestPlanSubmission(db, plan.id, cycle?.id);
  const latestSubmissionSnapshot = latestSubmission ? await getPlanSnapshot(db, latestSubmission.snapshotId) : null;
  const currentPlanContentHash = planSnapshotContentHash({
    planId: plan.id,
    cycleId: cycle?.id ?? null,
    cycleDefinition: cycle ? planCycleDefinition(cycle) : {},
    formData: parseJson(plan.form_data, {}),
    configVersionId: plan.config_version_id,
    configDefinition: planDefinition,
  });
  const [studentAiReview, teacherAiReview] = await Promise.all([
    getLatestPlanAiReviewForPlan(plan.id, "student", cycle?.id, currentPlanContentHash),
    getLatestPlanAiReviewForPlan(plan.id, "teacher", cycle?.id, latestSubmissionSnapshot?.contentHash),
  ]);
  return {
    team: {
      id: team.id,
      name: team.name,
      teamNumber: team.team_number,
      classNumber: team.class_number,
      clubId: team.club_id,
      activityName: team.activity_name,
      leaderUserId: team.leader_user_id,
    },
    session: {
      id: team.session_id,
      stage: team.stage ?? "STARTING",
      selectedTopic: team.selected_topic,
      interestInput: team.interest_input,
      aiBusy: team.ai_busy,
      topicSuggestions: parseJson(team.ai_topic_suggestions, {}).directions ?? [],
      cycle,
      cycles: cycleJourney,
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
      configVersionId: plan.config_version_id,
      description: String(planDefinition.description ?? ""),
      fields: Array.isArray(planDefinition.fields) ? planDefinition.fields as FormFieldDefinition[] : [],
      latestSubmission,
      latestSubmissionSnapshot,
      studentAiReview: studentAiReview ? {
        ...studentAiReview,
        isCurrent: studentAiReview.snapshotContentHash === currentPlanContentHash,
      } : null,
      teacherAiReview,
    },
    materials: material ? materialView(material) : null,
    pendingMaterials: pendingMaterials.rows.map(materialView),
    report: {
      id: report.id,
      reviewVersion: report.review_version,
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
      configVersionId: report.config_version_id,
      description: String(reportDefinition.description ?? ""),
      fields: Array.isArray(reportDefinition.fields) ? reportDefinition.fields as FormFieldDefinition[] : [],
    },
    customTabs: customTabsResult.rows.map((item) => ({
      id: item.id,
      title: item.title,
      definition: parseJson(item.definition, {}),
    })),
    clubFeatures: {
      materials: features.has("materials"),
      selfEvaluation: features.has("self_evaluation"),
      peerEvaluation: features.has("peer_evaluation"),
      exam: features.has("exam"),
    },
  };
}

export async function getInquiryDataForUser(userId: string, selectedTeamId?: string) {
  const db = await getDb();
  const membership = await db.query<{ team_id: string }>(
    `SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active'
        AND ($2::text IS NULL OR t.id = $2)
        AND u.academic_year = $3 AND COALESCE(c.academic_year, cl.academic_year) = $3
      ORDER BY t.created_at, t.id LIMIT 1`,
    [userId, selectedTeamId ?? null, ACADEMIC_YEAR],
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
       JOIN teams t ON t.id = tm.team_id
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE tm.user_id = $1 AND s.id = $2 AND tm.status = 'active' AND t.status = 'active'
        AND u.academic_year = $3 AND COALESCE(c.academic_year, cl.academic_year) = $3`,
    [userId, sessionId, ACADEMIC_YEAR],
  );
  if (!result.rows[0]) throw new Error("현재 팀 자료에 접근할 수 없습니다.");
  return result.rows[0].team_id;
}
