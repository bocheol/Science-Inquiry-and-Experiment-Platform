import { createHmac } from "node:crypto";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { getDb } from "@/lib/db";

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

function throttleSecret() {
  const configured = process.env.SESSION_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("운영 환경에는 SESSION_SECRET이 필요합니다.");
  }
  return configured ?? "local-development-only-science-inquiry-session";
}

export function clientNetworkIdentifier(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown-network";
}

export function loginAttemptBucketKey(loginId: string, networkIdentifier: string, academicYear = ACADEMIC_YEAR) {
  const normalizedLoginId = loginId.trim().toLowerCase();
  const normalizedNetwork = networkIdentifier.trim().toLowerCase();
  return createHmac("sha256", throttleSecret())
    .update(`${academicYear}\n${normalizedLoginId}\n${normalizedNetwork}`)
    .digest("hex");
}

export type LoginAttemptState = {
  blocked: boolean;
  retryAfterSeconds: number;
  failureCount: number;
};

function stateFromRow(row: { failure_count: number; blocked_until: Date | string | null } | undefined, now: Date): LoginAttemptState {
  const blockedUntil = row?.blocked_until ? new Date(row.blocked_until) : null;
  const remainingMs = blockedUntil ? blockedUntil.getTime() - now.getTime() : 0;
  return {
    blocked: remainingMs > 0,
    retryAfterSeconds: remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0,
    failureCount: row?.failure_count ?? 0,
  };
}

export async function getLoginAttemptState(bucketKey: string, now = new Date()): Promise<LoginAttemptState> {
  const db = await getDb();
  const result = await db.query<{ failure_count: number; blocked_until: Date | string | null }>(
    "SELECT failure_count, blocked_until FROM login_attempt_buckets WHERE bucket_key = $1",
    [bucketKey],
  );
  return stateFromRow(result.rows[0], now);
}

export async function recordFailedLogin(bucketKey: string, now = new Date()): Promise<LoginAttemptState> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO login_attempt_buckets
        (bucket_key, failure_count, window_started_at, blocked_until, updated_at)
       VALUES ($1, 0, $2, NULL, $2)
       ON CONFLICT (bucket_key) DO NOTHING`,
      [bucketKey, now],
    );
    const current = await client.query<{
      failure_count: number;
      window_started_at: Date | string;
      blocked_until: Date | string | null;
    }>(
      `SELECT failure_count, window_started_at, blocked_until
         FROM login_attempt_buckets
        WHERE bucket_key = $1
        FOR UPDATE`,
      [bucketKey],
    );
    const row = current.rows[0]!;
    const activeBlock = stateFromRow(row, now);
    if (activeBlock.blocked) {
      await client.query("COMMIT");
      return activeBlock;
    }

    const windowExpired = now.getTime() - new Date(row.window_started_at).getTime() >= ATTEMPT_WINDOW_MS;
    const failureCount = windowExpired ? 1 : row.failure_count + 1;
    const windowStartedAt = windowExpired ? now : new Date(row.window_started_at);
    const blockedUntil = failureCount >= MAX_FAILURES ? new Date(now.getTime() + BLOCK_DURATION_MS) : null;
    const updated = await client.query<{ failure_count: number; blocked_until: Date | string | null }>(
      `UPDATE login_attempt_buckets
          SET failure_count = $2,
              window_started_at = $3,
              blocked_until = $4,
              updated_at = $5
        WHERE bucket_key = $1
        RETURNING failure_count, blocked_until`,
      [bucketKey, failureCount, windowStartedAt, blockedUntil, now],
    );
    await client.query("COMMIT");
    return stateFromRow(updated.rows[0], now);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function clearLoginAttempts(bucketKey: string) {
  const db = await getDb();
  await db.query("DELETE FROM login_attempt_buckets WHERE bucket_key = $1", [bucketKey]);
}

export const LOGIN_ATTEMPT_POLICY = {
  attemptWindowMs: ATTEMPT_WINDOW_MS,
  blockDurationMs: BLOCK_DURATION_MS,
  maxFailures: MAX_FAILURES,
} as const;
