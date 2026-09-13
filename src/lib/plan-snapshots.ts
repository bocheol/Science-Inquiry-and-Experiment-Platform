import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createId } from "@/lib/id";
import { defaultClubConfigDefinition } from "@/lib/club-settings";
import { ensureActiveCycle } from "@/lib/inquiry-cycles";

type Queryable = Pick<Pool | PoolClient, "query">;

type SnapshotRow = {
  id: string;
  plan_id: string;
  cycle_id: string | null;
  cycle_definition: Record<string, unknown> | string;
  form_data: Record<string, unknown> | string;
  config_version_id: string | null;
  config_definition: Record<string, unknown> | string;
  document_updated_at: Date | string;
  content_hash: string;
  created_at: Date | string;
};

export type PlanDocumentSnapshot = {
  id: string;
  planId: string;
  cycleId: string | null;
  cycleDefinition: Record<string, unknown>;
  formData: Record<string, unknown>;
  configVersionId: string | null;
  configDefinition: Record<string, unknown>;
  documentUpdatedAt: string;
  contentHash: string;
  createdAt: string;
};

export type PlanSubmission = {
  id: string;
  planId: string;
  snapshotId: string;
  cycleId: string | null;
  submissionNumber: number;
  source: "submission" | "legacy_capture";
  reviewStatus: "pending" | "feedback" | "approved" | "withdrawn";
  teacherFeedback: string | null;
  submittedAt: string;
};

function parseObject(value: Record<string, unknown> | string | null | undefined) {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

// Use the same shape for persisted snapshots and the live editor's freshness check.
// The cycle ID is already hashed separately; keep existing snapshot hashes valid.
export function planCycleDefinition(cycle: {
  ordinal: number; title: string; status: string; origin: string;
  startedAt: string | null; endedAt: string | null;
}) {
  const { ordinal, title, status, origin, startedAt, endedAt } = cycle;
  return { ordinal, title, status, origin, startedAt, endedAt };
}

export function planSnapshotContentHash(input: {
  planId: string;
  cycleId: string | null;
  cycleDefinition: Record<string, unknown>;
  formData: Record<string, unknown>;
  configVersionId: string | null;
  configDefinition: Record<string, unknown>;
}) {
  return createHash("sha256").update(JSON.stringify(stableValue(input))).digest("hex");
}

function snapshotFromRow(row: SnapshotRow): PlanDocumentSnapshot {
  return {
    id: row.id,
    planId: row.plan_id,
    cycleId: row.cycle_id,
    cycleDefinition: parseObject(row.cycle_definition),
    formData: parseObject(row.form_data),
    configVersionId: row.config_version_id,
    configDefinition: parseObject(row.config_definition),
    documentUpdatedAt: new Date(row.document_updated_at).toISOString(),
    contentHash: row.content_hash,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createPlanDocumentSnapshot(db: Queryable, planId: string, actorId: string) {
  const result = await db.query<{
    session_id: string;
    cycle_id: string | null;
    form_data: Record<string, unknown> | string;
    config_version_id: string | null;
    updated_at: Date | string;
  }>(
    `SELECT session_id, cycle_id, form_data, config_version_id, updated_at
       FROM investigation_plans WHERE id = $1 FOR UPDATE`,
    [planId],
  );
  const plan = result.rows[0];
  if (!plan) throw new Error("계획서를 찾을 수 없습니다.");
  const cycleId = plan.cycle_id ?? await ensureActiveCycle(db, plan.session_id, actorId);
  if (!plan.cycle_id) await db.query("UPDATE investigation_plans SET cycle_id = $2 WHERE id = $1", [planId, cycleId]);
  const formData = parseObject(plan.form_data);
  const cycleResult = await db.query<{
    ordinal: number; title: string; status: string; origin: string;
    started_at: Date | string | null; ended_at: Date | string | null;
  }>("SELECT ordinal, title, status, origin, started_at, ended_at FROM inquiry_cycles WHERE id = $1", [cycleId]);
  const cycleRow = cycleResult.rows[0];
  if (!cycleRow) throw new Error("탐구 회차를 찾을 수 없습니다.");
  const cycleDefinition = planCycleDefinition({
    ordinal: Number(cycleRow.ordinal),
    title: cycleRow.title,
    status: cycleRow.status,
    origin: cycleRow.origin,
    startedAt: cycleRow.started_at ? new Date(cycleRow.started_at).toISOString() : null,
    endedAt: cycleRow.ended_at ? new Date(cycleRow.ended_at).toISOString() : null,
  });
  const configured = plan.config_version_id
    ? await db.query<{ definition: Record<string, unknown> | string }>("SELECT definition FROM club_config_versions WHERE id = $1", [plan.config_version_id])
    : null;
  const configDefinition = configured?.rows[0]
    ? parseObject(configured.rows[0].definition)
    : defaultClubConfigDefinition("plan") as Record<string, unknown>;
  const contentHash = planSnapshotContentHash({
    planId, cycleId, cycleDefinition, formData, configVersionId: plan.config_version_id, configDefinition,
  });
  const id = `plan_snapshot_${contentHash.slice(0, 32)}`;
  await db.query(
    `INSERT INTO plan_document_snapshots
      (id, plan_id, cycle_id, cycle_definition, form_data, config_version_id, config_definition, document_updated_at, content_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (plan_id, content_hash) DO NOTHING`,
    [id, planId, cycleId, JSON.stringify(cycleDefinition), JSON.stringify(formData), plan.config_version_id, JSON.stringify(configDefinition), plan.updated_at, contentHash, actorId],
  );
  const stored = await db.query<SnapshotRow>(
    "SELECT * FROM plan_document_snapshots WHERE plan_id = $1 AND content_hash = $2",
    [planId, contentHash],
  );
  return snapshotFromRow(stored.rows[0]!);
}

export async function createPlanSubmission(
  db: Queryable,
  planId: string,
  actorId: string,
  source: PlanSubmission["source"] = "submission",
) {
  const snapshot = await createPlanDocumentSnapshot(db, planId, actorId);
  const latest = await db.query<{ next_number: number | string }>(
    "SELECT COALESCE(MAX(submission_number), 0) + 1 AS next_number FROM plan_submissions WHERE plan_id = $1",
    [planId],
  );
  const submissionNumber = Number(latest.rows[0]?.next_number ?? 1);
  const id = createId("plan_submission");
  await db.query(
    `INSERT INTO plan_submissions
      (id, plan_id, snapshot_id, cycle_id, submission_number, source, submitted_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, planId, snapshot.id, snapshot.cycleId, submissionNumber, source, actorId],
  );
  return { id, snapshot, submissionNumber, source };
}

export async function getLatestPlanSubmission(db: Queryable, planId: string, cycleId?: string | null): Promise<PlanSubmission | null> {
  const result = await db.query<{
    id: string; plan_id: string; snapshot_id: string; cycle_id: string | null; submission_number: number;
    source: PlanSubmission["source"]; review_status: PlanSubmission["reviewStatus"];
    teacher_feedback: string | null; submitted_at: Date | string;
  }>(
    `SELECT id, plan_id, snapshot_id, cycle_id, submission_number, source, review_status, teacher_feedback, submitted_at
       FROM plan_submissions
      WHERE plan_id = $1 AND ($2::text IS NULL OR cycle_id = $2)
      ORDER BY submission_number DESC LIMIT 1`,
    [planId, cycleId ?? null],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    planId: row.plan_id,
    snapshotId: row.snapshot_id,
    cycleId: row.cycle_id,
    submissionNumber: Number(row.submission_number),
    source: row.source,
    reviewStatus: row.review_status,
    teacherFeedback: row.teacher_feedback,
    submittedAt: new Date(row.submitted_at).toISOString(),
  } : null;
}

export async function getPlanSnapshot(db: Queryable, snapshotId: string) {
  const result = await db.query<SnapshotRow>("SELECT * FROM plan_document_snapshots WHERE id = $1", [snapshotId]);
  return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
}
