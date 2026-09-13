import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { defaultClubConfigDefinition } from "@/lib/club-settings";
import { createId } from "@/lib/id";
import { createPlanDocumentSnapshot } from "@/lib/plan-snapshots";
import { seoulDate, type SummaryItem } from "@/lib/discussions";
import { PRACTICE_MATERIAL_SQL } from "@/lib/material-practice";

type Queryable = Pick<Pool | PoolClient, "query">;

export type CycleEvidencePayload = {
  cycle: {
    id: string;
    sessionId: string;
    ordinal: number;
    title: string;
    status: "active" | "completed" | "archived";
    origin: "configured" | "legacy_unclassified";
    startedAt: string | null;
    endedAt: string | null;
  };
  plan: {
    id: string;
    reviewStatus: string;
    formData: Record<string, unknown>;
    configVersionId: string | null;
    configDefinition: Record<string, unknown>;
    updatedAt: string;
  };
  report: {
    id: string;
    status: string;
    formData: Record<string, unknown>;
    memberRoles: Array<{ memberAlias: string; description: string }>;
    configVersionId: string | null;
    configDefinition: Record<string, unknown>;
    updatedAt: string;
  };
  materialRequests: Array<{ id: string; items: unknown[]; totalAmount: number; syncStatus: string; submittedAt: string; isPractice?: boolean }>;
  journals: Array<{
    evidenceId: string;
    sessionNumber: number;
    date: string;
    activities: string;
    observations: string;
    updatedAt: string;
  }>;
  messages: Array<{ evidenceId: string; role: string; content: string; createdAt: string }>;
  // Absent on older snapshots; never infer missing historical source records.
  discussionEntries?: Array<{
    evidenceId: string; kind: "peer" | "meeting" | "supplement"; date: string; content: string;
    authorId: string; participantIds: string[]; confirmedBy: string[]; parentEvidenceId: string | null; createdAt: string;
  }>;
  discussionSummaries: Array<{ evidenceId: string; date: string; content: unknown; sources: unknown }>;
  trajectoryContext: Array<{
    cycleId: string;
    ordinal: number;
    title: string;
    analysisId: string;
    analysisType: "intermediate" | "final";
    result: unknown;
    decisions: Array<{ suggestionId: string; decision: string; reason: string }>;
  }>;
};

export type CycleEvidenceSnapshot = CycleEvidencePayload & {
  id: string;
  planSnapshotId: string;
  contentHash: string;
  createdAt: string;
};

function jsonObject(value: Record<string, unknown> | string | null | undefined) {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function jsonValue<T>(value: T | string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function cycleEvidenceHash(payload: CycleEvidencePayload) {
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

export async function buildCycleEvidencePayload(db: Queryable, cycleId: string, includeCurrentIntermediate = false): Promise<CycleEvidencePayload> {
  const cycleResult = await db.query<{
    id: string; session_id: string; ordinal: number; title: string;
    status: CycleEvidencePayload["cycle"]["status"]; origin: CycleEvidencePayload["cycle"]["origin"];
    started_at: Date | string | null; ended_at: Date | string | null;
  }>(`SELECT id, session_id, ordinal, title, status, origin, started_at, ended_at
        FROM inquiry_cycles WHERE id = $1`, [cycleId]);
  const cycle = cycleResult.rows[0];
  if (!cycle) throw new Error("탐구 회차를 찾을 수 없습니다.");

  const planResult = await db.query<{
    id: string; form_data: Record<string, unknown> | string; review_status: string;
    config_version_id: string | null; definition: Record<string, unknown> | string | null;
    updated_at: Date | string;
  }>(`SELECT p.id, p.form_data, p.review_status, p.config_version_id, v.definition, p.updated_at
        FROM investigation_plans p
        LEFT JOIN club_config_versions v ON v.id = p.config_version_id
       WHERE p.session_id = $1 AND p.cycle_id = $2`, [cycle.session_id, cycleId]);
  const plan = planResult.rows[0];
  if (!plan) throw new Error("현재 회차 계획서를 찾을 수 없습니다.");

  const reportResult = await db.query<{
    id: string; form_data: Record<string, unknown> | string; status: string;
    config_version_id: string | null; definition: Record<string, unknown> | string | null;
    updated_at: Date | string;
  }>(`SELECT r.id, r.form_data, r.status, r.config_version_id, v.definition, r.updated_at
        FROM reports r
        LEFT JOIN club_config_versions v ON v.id = r.config_version_id
       WHERE r.session_id = $1 AND r.cycle_id = $2`, [cycle.session_id, cycleId]);
  const report = reportResult.rows[0];
  if (!report) throw new Error("현재 회차 보고서를 찾을 수 없습니다.");

  const reportFields = await db.query<{ field_key: string; value: string }>(
    "SELECT field_key, value FROM report_fields WHERE report_id = $1 ORDER BY field_key", [report.id],
  );
  const reportFormData = jsonObject(report.form_data);
  for (const field of reportFields.rows) reportFormData[field.field_key] = field.value;

  const roleRows = await db.query<{ role_description: string }>(
    `SELECT rmr.role_description FROM report_member_roles rmr
      WHERE rmr.report_id = $1 ORDER BY rmr.user_id`, [report.id],
  );
  const materialRows = await db.query<{
    id: string; form_data: unknown[] | string; total_amount: number; sync_status: string; submitted_at: Date | string; is_practice: boolean;
  }>(`SELECT m.id, m.form_data, m.total_amount, m.sync_status, m.submitted_at, ${PRACTICE_MATERIAL_SQL} AS is_practice
        FROM material_requests m LEFT JOIN users u ON u.id = m.submitted_by WHERE m.cycle_id = $1 ORDER BY m.submitted_at, m.id`, [cycleId]);
  const journalRows = await db.query<{
    id: string; session_number: number; journal_date: Date | string; activities: string;
    observations: string; updated_at: Date | string;
  }>(`SELECT id, session_number, journal_date, activities, observations, updated_at
        FROM experiment_journals WHERE cycle_id = $1 ORDER BY journal_date, session_number, id`, [cycleId]);
  const messageRows = await db.query<{
    id: string; role: string; content: string; created_at: Date | string;
  }>(`SELECT id, role, content, created_at FROM messages
        WHERE cycle_id = $1 AND role IN ('user', 'assistant') ORDER BY sequence, id`, [cycleId]);

  const entryRows = await db.query<{
    id: string; kind: "peer" | "meeting" | "supplement"; activity_date: string; content: string; author_id: string;
    participants: Array<{ id: string }> | string; parent_id: string | null; created_at: Date | string;
  }>(`SELECT id, kind, activity_date, content, author_id, participants, parent_id, created_at
        FROM discussion_entries WHERE session_id = $1 AND cycle_id = $2 ORDER BY activity_date, created_at, id`, [cycle.session_id, cycleId]);
  const confirmations = await db.query<{ entry_id: string; user_id: string }>(
    `SELECT c.entry_id, c.user_id FROM discussion_confirmations c JOIN discussion_entries e ON e.id = c.entry_id
      WHERE e.session_id = $1 AND e.cycle_id = $2 ORDER BY c.entry_id, c.user_id`, [cycle.session_id, cycleId],
  );
  const currentSources = new Map<string, { content: string; kind: string; date: string }>([
    ...messageRows.rows.map(item => [item.id, { content: item.content, kind: item.role === "assistant" ? "ai_answer" : "ai_question", date: seoulDate(item.created_at) }] as const),
    ...entryRows.rows.map(item => [item.id, { content: item.content, kind: item.kind, date: item.activity_date }] as const),
  ]);
  const summaryRows = await db.query<{
    id: string; activity_date: Date | string; content: unknown | string; sources: unknown | string;
  }>(`SELECT s.id, s.activity_date, s.content, s.sources
        FROM discussion_summaries s
        JOIN discussion_days d ON d.session_id = s.session_id
                              AND d.activity_date = s.activity_date
                              AND d.generated_version = s.version
       WHERE s.session_id = $1
       ORDER BY s.activity_date, s.id`, [cycle.session_id]);
  // A calendar date cannot establish cycle ownership, including same-day rollover.
  // Keep mixed/unknown legacy summaries in their original table but do not treat
  // any part of their generated prose as evidence for one particular cycle.
  const scopedSummaryRows = await db.query<typeof summaryRows.rows[number]>(
    `SELECT s.id, s.activity_date, s.content, s.sources FROM cycle_discussion_summaries s
      JOIN cycle_discussion_days d ON d.session_id=s.session_id AND d.cycle_id=s.cycle_id AND d.activity_date=s.activity_date AND d.generated_version=s.version
      WHERE s.session_id=$1 AND s.cycle_id=$2 ORDER BY s.activity_date, s.id`, [cycle.session_id, cycleId],
  );
  const scopedDates = new Set(scopedSummaryRows.rows.map(row => String(row.activity_date)));
  const verifiedSummaries = [...scopedSummaryRows.rows, ...summaryRows.rows.filter(row => !scopedDates.has(String(row.activity_date)))].filter(item => {
    const sources = jsonValue<unknown>(item.sources, []);
    const content = jsonValue<unknown>(item.content, []);
    if (!Array.isArray(sources) || !sources.length || !Array.isArray(content)) return false;
    const sourceIds = new Set<string>();
    for (const source of sources) {
      if (!source || typeof source !== "object" || typeof source.id !== "string") return false;
      const original = currentSources.get(source.id);
      if (!original || sourceIds.has(source.id) || source.content !== original.content || source.kind !== original.kind || source.activityDate !== original.date || original.date !== String(item.activity_date).slice(0, 10)) return false;
      sourceIds.add(source.id);
    }
    return content.every((claim: SummaryItem) => claim && typeof claim.text === "string" && Array.isArray(claim.sourceIds) && claim.sourceIds.length > 0 && claim.sourceIds.every(id => sourceIds.has(id)));
  });

  const priorAnalysisRows = await db.query<{
    cycle_id: string; ordinal: number; title: string; analysis_id: string;
    analysis_type: "intermediate" | "final"; result_json: unknown | string;
  }>(`SELECT c.id AS cycle_id, c.ordinal, c.title, a.id AS analysis_id, a.analysis_type, a.result_json
        FROM inquiry_cycles c
        JOIN cycle_ai_analyses a ON a.cycle_id = c.id
       WHERE c.session_id = $1 AND (c.ordinal < $2 OR ($3 = TRUE AND c.ordinal = $2 AND a.analysis_type = 'intermediate'))
       ORDER BY c.ordinal, a.created_at DESC, a.id`, [cycle.session_id, cycle.ordinal, includeCurrentIntermediate]);
  const seenCycles = new Set<string>();
  const trajectoryContext: CycleEvidencePayload["trajectoryContext"] = [];
  for (const prior of priorAnalysisRows.rows) {
    if (prior.cycle_id !== cycleId && seenCycles.has(prior.cycle_id)) continue;
    seenCycles.add(prior.cycle_id);
    const decisions = await db.query<{ suggestion_id: string; decision: string; reason: string }>(
      `SELECT suggestion_id, decision, reason FROM cycle_ai_decisions
        WHERE analysis_id = $1 ORDER BY suggestion_id`, [prior.analysis_id],
    );
    trajectoryContext.push({
      cycleId: prior.cycle_id,
      ordinal: Number(prior.ordinal),
      title: prior.title,
      analysisId: prior.analysis_id,
      analysisType: prior.analysis_type,
      result: jsonValue(prior.result_json, {}),
      decisions: decisions.rows.map((item) => ({
        suggestionId: item.suggestion_id,
        decision: item.decision,
        reason: item.reason,
      })),
    });
  }

  return {
    cycle: {
      id: cycle.id,
      sessionId: cycle.session_id,
      ordinal: Number(cycle.ordinal),
      title: cycle.title,
      status: cycle.status,
      origin: cycle.origin,
      startedAt: iso(cycle.started_at),
      endedAt: iso(cycle.ended_at),
    },
    plan: {
      id: plan.id,
      reviewStatus: plan.review_status,
      formData: jsonObject(plan.form_data),
      configVersionId: plan.config_version_id,
      configDefinition: plan.definition ? jsonObject(plan.definition) : defaultClubConfigDefinition("plan") as Record<string, unknown>,
      updatedAt: new Date(plan.updated_at).toISOString(),
    },
    report: {
      id: report.id,
      status: report.status,
      formData: reportFormData,
      memberRoles: roleRows.rows.map((item, index) => ({ memberAlias: `팀원 ${String.fromCharCode(65 + index)}`, description: item.role_description })),
      configVersionId: report.config_version_id,
      configDefinition: report.definition ? jsonObject(report.definition) : defaultClubConfigDefinition("report") as Record<string, unknown>,
      updatedAt: new Date(report.updated_at).toISOString(),
    },
    materialRequests: materialRows.rows.filter((item) => !item.is_practice).map((item) => ({
      id: item.id,
      items: jsonValue(item.form_data, []).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const { link: _link, ...safe } = entry as Record<string, unknown>;
        return safe;
      }),
      totalAmount: Number(item.total_amount),
      syncStatus: item.sync_status,
      isPractice: item.is_practice,
      submittedAt: new Date(item.submitted_at).toISOString(),
    })),
    journals: journalRows.rows.map((item) => ({
      evidenceId: `journal:${item.id}`,
      sessionNumber: Number(item.session_number),
      date: String(item.journal_date).slice(0, 10),
      activities: item.activities,
      observations: item.observations,
      updatedAt: new Date(item.updated_at).toISOString(),
    })),
    messages: messageRows.rows.map((item) => ({
      evidenceId: `message:${item.id}`,
      role: item.role,
      content: item.content,
      createdAt: new Date(item.created_at).toISOString(),
    })),
    discussionEntries: entryRows.rows.map(item => ({
      evidenceId: `entry:${item.id}`, kind: item.kind, date: item.activity_date, content: item.content,
      authorId: item.author_id, participantIds: jsonValue<Array<{ id: string }>>(item.participants, []).map(p => p.id).sort(),
      confirmedBy: confirmations.rows.filter(c => c.entry_id === item.id).map(c => c.user_id),
      parentEvidenceId: item.parent_id ? `entry:${item.parent_id}` : null, createdAt: new Date(item.created_at).toISOString(),
    })),
    discussionSummaries: verifiedSummaries.map((item) => ({
      evidenceId: `discussion:${item.id}`,
      date: String(item.activity_date).slice(0, 10),
      content: jsonValue(item.content, []),
      sources: jsonValue(item.sources, []),
    })),
    trajectoryContext,
  };
}

export async function captureCycleEvidenceSnapshot(db: Queryable, cycleId: string, actorId: string, includeCurrentIntermediate = false) {
  const payload = await buildCycleEvidencePayload(db, cycleId, includeCurrentIntermediate);
  const planSnapshot = await createPlanDocumentSnapshot(db, payload.plan.id, actorId);
  const contentHash = cycleEvidenceHash(payload);
  const id = `cycle_snapshot_${contentHash.slice(0, 32)}`;
  await db.query(
    `INSERT INTO cycle_evidence_snapshots
      (id, cycle_id, session_id, cycle_definition, plan_snapshot_id, report_definition,
       report_form_data, report_member_roles, material_requests, journals, messages,
       discussion_summaries, trajectory_context, content_hash, created_by, discussion_entries)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (cycle_id, content_hash) DO NOTHING`,
    [id, cycleId, payload.cycle.sessionId, JSON.stringify(payload.cycle), planSnapshot.id,
      JSON.stringify(payload.report.configDefinition), JSON.stringify(payload.report.formData),
      JSON.stringify(payload.report.memberRoles), JSON.stringify(payload.materialRequests),
      JSON.stringify(payload.journals), JSON.stringify(payload.messages), JSON.stringify(payload.discussionSummaries),
      JSON.stringify(payload.trajectoryContext), contentHash, actorId, JSON.stringify(payload.discussionEntries)],
  );
  const stored = await db.query<{ id: string; created_at: Date | string }>(
    "SELECT id, created_at FROM cycle_evidence_snapshots WHERE cycle_id = $1 AND content_hash = $2",
    [cycleId, contentHash],
  );
  return { ...payload, id: stored.rows[0]!.id, planSnapshotId: planSnapshot.id, contentHash, createdAt: new Date(stored.rows[0]!.created_at).toISOString() };
}
