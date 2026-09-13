import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";

type Queryable = Pick<Pool | PoolClient, "query">;

export type AiJobLease = {
  kind: "acquired";
  jobId: string;
  leaseToken: string;
  requestKey: string;
};

export type AiJobResult<T> = AiJobLease | { kind: "cached"; jobId: string; result: T } | { kind: "busy" };

function jsonValue<T>(value: T | string | null): T | null {
  if (value == null) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value;
}

export function aiRequestKey(feature: string, value: unknown) {
  return createHash("sha256").update(`${feature}\n${JSON.stringify(value)}`).digest("hex");
}

export async function beginAiJob<T>(input: {
  resourceKey: string;
  requestKey: string;
  feature: string;
  actorId: string;
  leaseMs?: number;
  now?: Date;
}): Promise<AiJobResult<T>> {
  const db = await getDb();
  const client = await db.connect();
  const now = input.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 15 * 60_000));
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ai_generation_resources (resource_key, updated_at)
       VALUES ($1, $2)
       ON CONFLICT (resource_key) DO NOTHING`,
      [input.resourceKey, now],
    );
    await client.query("SELECT resource_key FROM ai_generation_resources WHERE resource_key = $1 FOR UPDATE", [input.resourceKey]);
    const existing = await client.query<{
      id: string;
      status: "processing" | "completed" | "failed";
      lease_until: Date | string | null;
      result_json: T | string | null;
    }>(
      `SELECT id, status, lease_until, result_json
         FROM ai_generation_jobs
        WHERE resource_key = $1 AND request_key = $2`,
      [input.resourceKey, input.requestKey],
    );
    const same = existing.rows[0];
    if (same?.status === "completed") {
      const result = jsonValue<T>(same.result_json);
      if (result == null) throw new Error("완료된 AI 작업 결과가 비어 있습니다.");
      await client.query("COMMIT");
      return { kind: "cached", jobId: same.id, result };
    }
    if (same?.status === "processing" && same.lease_until && new Date(same.lease_until).getTime() > now.getTime()) {
      await client.query("COMMIT");
      return { kind: "busy" };
    }
    const other = await client.query(
      `SELECT id FROM ai_generation_jobs
        WHERE resource_key = $1 AND request_key <> $2 AND status = 'processing' AND lease_until > $3
        LIMIT 1`,
      [input.resourceKey, input.requestKey, now],
    );
    if (other.rows[0]) {
      await client.query("COMMIT");
      return { kind: "busy" };
    }

    // The resource lock serializes takeover. Retire expired requests for the
    // same resource too, so a late response cannot still write under its old ID.
    await client.query(
      `UPDATE ai_generation_jobs
          SET status = 'failed', lease_token = NULL, lease_until = NULL, updated_at = $3
        WHERE resource_key = $1 AND request_key <> $2 AND status = 'processing'
          AND (lease_until <= $3 OR lease_until IS NULL)`,
      [input.resourceKey, input.requestKey, now],
    );
    const leaseToken = createId("lease");
    let jobId = same?.id;
    if (jobId) {
      await client.query(
        `UPDATE ai_generation_jobs
            SET status = 'processing', lease_token = $2, lease_until = $3,
                attempt_count = attempt_count + 1, updated_at = $4
          WHERE id = $1`,
        [jobId, leaseToken, leaseUntil, now],
      );
    } else {
      jobId = createId("ai_job");
      await client.query(
        `INSERT INTO ai_generation_jobs
          (id, resource_key, request_key, feature, status, lease_token, lease_until, created_by, updated_at)
         VALUES ($1, $2, $3, $4, 'processing', $5, $6, $7, $8)`,
        [jobId, input.resourceKey, input.requestKey, input.feature, leaseToken, leaseUntil, input.actorId, now],
      );
    }
    await client.query("UPDATE ai_generation_resources SET updated_at = $2 WHERE resource_key = $1", [input.resourceKey, now]);
    await client.query("COMMIT");
    return { kind: "acquired", jobId, leaseToken, requestKey: input.requestKey };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ownsAiJob(queryable: Queryable, jobId: string, leaseToken: string) {
  // Write callers use a transaction: keep the owner stable until their result
  // commits or rolls back. Generation itself must remain outside this lock.
  const result = await queryable.query(
    "SELECT id FROM ai_generation_jobs WHERE id = $1 AND status = 'processing' AND lease_token = $2 FOR UPDATE",
    [jobId, leaseToken],
  );
  return Boolean(result.rows[0]);
}

export async function completeAiJob<T>(queryable: Queryable, jobId: string, leaseToken: string, result: T) {
  const updated = await queryable.query(
    `UPDATE ai_generation_jobs
        SET status = 'completed', result_json = $3, lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'processing' AND lease_token = $2
      RETURNING id`,
    [jobId, leaseToken, JSON.stringify(result)],
  );
  return Boolean(updated.rows[0]);
}

export async function failAiJob(jobId: string, leaseToken: string) {
  const db = await getDb();
  await db.query(
    `UPDATE ai_generation_jobs
        SET status = 'failed', lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
    [jobId, leaseToken],
  );
}

export async function runAiJobStep<T>(lease: AiJobLease, stepKey: string, generate: () => Promise<T>) {
  const db = await getDb();
  const cached = await db.query<{ result_json: T | string }>(
    "SELECT result_json FROM ai_generation_job_steps WHERE job_id = $1 AND step_key = $2",
    [lease.jobId, stepKey],
  );
  if (cached.rows[0]) return jsonValue<T>(cached.rows[0].result_json)!;

  const generated = await generate();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!(await ownsAiJob(client, lease.jobId, lease.leaseToken))) {
      await client.query("ROLLBACK");
      throw new Error("AI 작업 소유권이 만료되었습니다. 다시 시도해 주세요.");
    }
    await client.query(
      `INSERT INTO ai_generation_job_steps (job_id, step_key, result_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (job_id, step_key) DO NOTHING`,
      [lease.jobId, stepKey, JSON.stringify(generated)],
    );
    await client.query("COMMIT");
    const stored = await db.query<{ result_json: T | string }>(
      "SELECT result_json FROM ai_generation_job_steps WHERE job_id = $1 AND step_key = $2",
      [lease.jobId, stepKey],
    );
    return jsonValue<T>(stored.rows[0]!.result_json)!;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
