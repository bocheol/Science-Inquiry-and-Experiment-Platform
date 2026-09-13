import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type InquiryCycle = {
  id: string;
  sessionId: string;
  ordinal: number;
  title: string;
  status: "active" | "completed" | "archived";
  origin: "configured" | "legacy_unclassified";
};

function cycleId(sessionId: string, ordinal: number) {
  return `cycle_${sessionId}_${ordinal}`;
}

export async function ensureInitialCycle(
  db: Queryable,
  sessionId: string,
  createdBy: string | null = null,
  origin: InquiryCycle["origin"] = "configured",
) {
  const id = cycleId(sessionId, 1);
  await db.query(
    `INSERT INTO inquiry_cycles (id, session_id, ordinal, title, status, origin, created_by, started_at)
     VALUES ($1, $2, 1, $3, 'active', $4, $5, $6)
     ON CONFLICT (session_id, ordinal) DO NOTHING`,
    [id, sessionId, origin === "legacy_unclassified" ? "기존 탐구 자료" : "1차 탐구", origin, createdBy,
      origin === "legacy_unclassified" ? null : new Date()],
  );
  const stored = await db.query<{ id: string }>(
    "SELECT id FROM inquiry_cycles WHERE session_id = $1 AND ordinal = 1",
    [sessionId],
  );
  if (!stored.rows[0]) throw new Error("탐구 회차를 만들지 못했습니다.");
  return stored.rows[0].id;
}

export async function ensureActiveCycle(db: Queryable, sessionId: string, createdBy: string | null = null) {
  await db.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
  const current = await db.query<{ id: string; status: InquiryCycle["status"] }>(
    `SELECT id FROM inquiry_cycles
      WHERE session_id = $1 AND status = 'active'
      ORDER BY ordinal DESC LIMIT 1`,
    [sessionId],
  );
  if (current.rows[0]) return current.rows[0].id;
  const prior = await db.query<{ status: InquiryCycle["status"] }>(
    "SELECT status FROM inquiry_cycles WHERE session_id = $1 ORDER BY ordinal DESC LIMIT 1",
    [sessionId],
  );
  if (prior.rows[0]) throw new Error("종료된 탐구에는 새 자료를 만들 수 없습니다.");
  return ensureInitialCycle(db, sessionId, createdBy);
}
