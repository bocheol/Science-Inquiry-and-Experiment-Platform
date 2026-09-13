import type { PoolClient } from "pg";
import { getDb } from "@/lib/db";

export async function withDocumentCycle<T>(kind: "plan" | "report", documentId: string, expectedCycleId: string | undefined, action: (db: PoolClient) => Promise<T>) {
  const db = await (await getDb()).connect();
  try {
    await db.query("BEGIN");
    await lockDocumentCycle(db, kind, documentId, expectedCycleId);
    const result = await action(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

// Call inside the write transaction. Cycle transitions lock the session first.
export async function lockDocumentCycle(db: Pick<PoolClient, "query">, kind: "plan" | "report", documentId: string, expectedCycleId?: string) {
  const table = kind === "plan" ? "investigation_plans" : "reports";
  await db.query(`SELECT id FROM inquiry_sessions WHERE id = (SELECT session_id FROM ${table} WHERE id = $1) FOR UPDATE`, [documentId]);
  const result = await db.query<{ cycle_id: string; status: string }>(
    `SELECT d.cycle_id, c.status FROM ${table} d JOIN inquiry_cycles c ON c.id = d.cycle_id WHERE d.id = $1`, [documentId],
  );
  const current = result.rows[0];
  if (!current || current.status !== "active") throw new Error("완료된 탐구 회차의 문서는 변경할 수 없습니다.");
  if (expectedCycleId !== undefined && expectedCycleId !== current.cycle_id) {
    throw new Error("탐구 회차가 변경되었습니다. 작성한 내용을 보관하고 현재 회차를 다시 확인해 주세요.");
  }
  await db.query("SELECT id FROM inquiry_cycles WHERE id = $1 FOR UPDATE", [current.cycle_id]);
  await db.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [documentId]);
  return current.cycle_id;
}
