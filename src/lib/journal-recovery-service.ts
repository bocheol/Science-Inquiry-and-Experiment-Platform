import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { UserFacingError } from "@/lib/user-facing-error";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { lockStudentTeams } from "@/lib/team-mutation-locks";

type Db = Pick<Pool | PoolClient, "query">;
export class RecoveryAccessError extends UserFacingError {
  readonly status = 403;
  constructor() { super("본인의 복구 사본만 열 수 있습니다. 다시 로그인해 주세요."); }
}
export const RECOVERY_ASSET_BYTES = 5 * 1024 * 1024 + 28;
export const RECOVERY_TEXT_BYTES = 160 * 1024;
export const RECOVERY_OWNER_ASSET_BYTES = 100 * 1024 * 1024;
export type RecoveryRow = { id: string; owner_id: string; session_id: string; cycle_id: string; revision: number; encrypted_data: Buffer | null; asset_ids: string[]; deleted: boolean; updated_at: Date | string };
type StoredRecoveryRow = Omit<RecoveryRow, "encrypted_data"> & { encrypted_data: string | null };
// Base64 keeps opaque bytes identical across PostgreSQL and the development adapter.
const decodeRow = (row: StoredRecoveryRow): RecoveryRow => ({ ...row, encrypted_data: row.encrypted_data === null ? null : Buffer.from(row.encrypted_data, "base64") });

async function assertOwner(db: Db, ownerId: string) {
  const result = await db.query("SELECT id FROM users WHERE id = $1 AND role = 'student' AND status = 'active' AND must_change_password = FALSE AND academic_year = $2", [ownerId, ACADEMIC_YEAR]);
  if (!result.rows.length) throw new RecoveryAccessError();
}
async function assertScope(db: Db, ownerId: string, sessionId: string, cycleId: string) {
  await assertOwner(db, ownerId);
  const found = await db.query(`SELECT c.id FROM inquiry_cycles c JOIN inquiry_sessions s ON s.id = c.session_id
    JOIN teams t ON t.id = s.team_id JOIN team_members tm ON tm.team_id = t.id
    LEFT JOIN classes cls ON cls.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
    WHERE c.id = $1 AND s.id = $2 AND tm.user_id = $3 AND tm.status = 'active'
      AND t.status = 'active' AND COALESCE(cls.academic_year, cl.academic_year) = $4`, [cycleId, sessionId, ownerId, ACADEMIC_YEAR]);
  if (!found.rows.length) throw new RecoveryAccessError();
}
export async function getJournalRecoveryKey(ownerId: string) {
  const db = await getDb();
  await assertOwner(db, ownerId);
  await db.query("INSERT INTO journal_recovery_keys (owner_id,key_data) VALUES ($1,$2) ON CONFLICT (owner_id) DO NOTHING", [ownerId, randomBytes(32).toString("base64")]);
  return Buffer.from((await db.query<{ key_data: string }>("SELECT key_data FROM journal_recovery_keys WHERE owner_id = $1", [ownerId])).rows[0]!.key_data, "base64");
}
export async function getLegacyRecoverySeal() {
  const db = await getDb();
  let row = (await db.query<{ public_key: string; private_key: string }>("SELECT public_key, private_key FROM journal_recovery_seal_key WHERE id = 'legacy-v1'")).rows[0];
  if (!row) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await db.query("INSERT INTO journal_recovery_seal_key (id,public_key,private_key) VALUES ('legacy-v1',$1,$2) ON CONFLICT (id) DO NOTHING", [pair.publicKey, pair.privateKey]);
    row = (await db.query<{ public_key: string; private_key: string }>("SELECT public_key, private_key FROM journal_recovery_seal_key WHERE id = 'legacy-v1'")).rows[0]!;
  }
  return row;
}
export async function unlockLegacyRecoveryKey(ownerId: string, sealedKey: string) {
  await assertOwner(await getDb(), ownerId);
  try {
    const seal = await getLegacyRecoverySeal();
    const payload = JSON.parse(privateDecrypt({ key: seal.private_key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(sealedKey, "base64")).toString("utf8"));
    if (payload.ownerId !== ownerId || typeof payload.key !== "string" || Buffer.from(payload.key, "base64").length !== 32) throw new Error("owner mismatch");
    return payload.key as string;
  } catch { throw new RecoveryAccessError(); }
}
export async function putRecoveryAsset(ownerId: string, assetId: string, data: Buffer) {
  if (data.length < 29 || data.length > RECOVERY_ASSET_BYTES) throw new UserFacingError("복구 사진 크기를 확인해 주세요.");
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ownerId]);
    await assertOwner(client, ownerId);
    const stored = (await client.query<{ encrypted_data: string }>("SELECT encrypted_data FROM journal_recovery_assets WHERE owner_id = $1 AND asset_id = $2", [ownerId, assetId])).rows[0];
    if (stored) {
      if (!Buffer.from(stored.encrypted_data, "base64").equals(data)) throw new FormWriteConflict("같은 복구 사진의 내용이 다릅니다. 새 사진으로 선택해 주세요.");
    } else {
      const usage = (await client.query<{ bytes: string; count: string }>("SELECT COALESCE(SUM(byte_size),0)::text AS bytes, COUNT(*)::text AS count FROM journal_recovery_assets WHERE owner_id = $1", [ownerId])).rows[0]!;
      if (Number(usage.bytes) + data.length > RECOVERY_OWNER_ASSET_BYTES || Number(usage.count) >= 256) throw new UserFacingError("복구 사진 보관 한도에 도달했습니다. 기존 복구 사본을 열어 일지에 임시 저장한 뒤 다시 시도해 주세요.");
      await client.query("INSERT INTO journal_recovery_assets (owner_id,asset_id,encrypted_data,byte_size) VALUES ($1,$2,$3,$4)", [ownerId, assetId, data.toString("base64"), data.length]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function getRecoveryAsset(ownerId: string, assetId: string) {
  const db = await getDb(); await assertOwner(db, ownerId);
  const row = (await db.query<{ encrypted_data: string }>("SELECT encrypted_data FROM journal_recovery_assets WHERE owner_id = $1 AND asset_id = $2", [ownerId, assetId])).rows[0];
  if (!row) throw new RecoveryAccessError();
  return Buffer.from(row.encrypted_data, "base64");
}
export async function listRecoveryDrafts(ownerId: string, sessionId: string, cycleId: string) {
  const db = await getDb(); await assertScope(db, ownerId, sessionId, cycleId);
  return (await db.query<StoredRecoveryRow>("SELECT * FROM journal_recovery_drafts WHERE owner_id = $1 AND session_id = $2 AND cycle_id = $3 AND deleted = FALSE ORDER BY updated_at DESC", [ownerId, sessionId, cycleId])).rows.map(decodeRow);
}
export async function saveRecoveryDraft(ownerId: string, input: { id: string; sessionId: string; cycleId: string; revision: number; data: Buffer; assetIds: string[] }) {
  if (input.data.length < 29 || input.data.length > RECOVERY_TEXT_BYTES || input.assetIds.length > 5 || new Set(input.assetIds).size !== input.assetIds.length) throw new UserFacingError("복구 사본의 크기나 사진 목록을 확인해 주세요.");
  const db = await getDb(); const client = await db.connect();
  try {
    await client.query("BEGIN");
    const target = (await client.query<{ team_id: string }>("SELECT team_id FROM inquiry_sessions WHERE id = $1", [input.sessionId])).rows[0];
    if (!target) throw new RecoveryAccessError();
    await lockStudentTeams(client, ownerId, [target.team_id]);
    await assertScope(client, ownerId, input.sessionId, input.cycleId);
    const stored = (await client.query<StoredRecoveryRow>("SELECT * FROM journal_recovery_drafts WHERE id = $1 FOR UPDATE", [input.id])).rows[0];
    const existing = stored ? decodeRow(stored) : undefined;
    if (existing && (existing.owner_id !== ownerId || existing.session_id !== input.sessionId || existing.cycle_id !== input.cycleId)) throw new RecoveryAccessError();
    if (existing?.deleted) throw new FormWriteConflict("이미 정리된 복구 사본입니다. 새 복구 사본을 사용해 주세요.");
    if (existing && existing.revision >= input.revision) {
      if (existing.revision === input.revision && existing.encrypted_data?.equals(input.data) && JSON.stringify(existing.asset_ids) === JSON.stringify(input.assetIds)) { await client.query("COMMIT"); return; }
      throw new FormWriteConflict("더 최신인 복구 사본을 보존했습니다.");
    }
    for (const id of input.assetIds) if (!(await client.query("SELECT asset_id FROM journal_recovery_assets WHERE owner_id = $1 AND asset_id = $2", [ownerId, id])).rows.length) throw new UserFacingError("복구 사진 전송이 끝나지 않았습니다. 연결 후 다시 시도합니다.");
    if (!existing) {
      const count = (await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM journal_recovery_drafts WHERE owner_id = $1 AND deleted = FALSE", [ownerId])).rows[0];
      if (Number(count?.count) >= 100) throw new UserFacingError("복구 사본이 100개입니다. 이전 사본을 확인하고 정리한 뒤 다시 시도해 주세요.");
      await client.query("INSERT INTO journal_recovery_drafts (id,owner_id,session_id,cycle_id,revision,encrypted_data,asset_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.id, ownerId, input.sessionId, input.cycleId, input.revision, input.data.toString("base64"), JSON.stringify(input.assetIds)]);
    } else await client.query("UPDATE journal_recovery_drafts SET revision = $1, encrypted_data = $2, asset_ids = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4", [input.revision, input.data.toString("base64"), JSON.stringify(input.assetIds), input.id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
export async function retireRecoveryDraft(ownerId: string, input: { id: string; sessionId: string; cycleId: string; revision: number; onlyIfRevision?: number }) {
  const db = await getDb(); const client = await db.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ownerId]);
    await assertOwner(client, ownerId);
    const old = (await client.query<RecoveryRow>("SELECT * FROM journal_recovery_drafts WHERE id = $1 FOR UPDATE", [input.id])).rows[0];
    if (old && (old.owner_id !== ownerId || old.session_id !== input.sessionId || old.cycle_id !== input.cycleId)) throw new RecoveryAccessError();
    if (old?.deleted) { await client.query("COMMIT"); return; }
    if (old && ((input.onlyIfRevision !== undefined && old.revision !== input.onlyIfRevision) || old.revision > input.revision)) throw new FormWriteConflict("다른 화면의 최신 복구 사본을 유지했습니다.");
    // A tombstone also rejects an older upload that arrives after this request.
    if (!old) {
      await assertScope(client, ownerId, input.sessionId, input.cycleId);
      await client.query("INSERT INTO journal_recovery_drafts (id,owner_id,session_id,cycle_id,revision,encrypted_data,asset_ids,deleted) VALUES ($1,$2,$3,$4,$5,NULL,'[]',TRUE)", [input.id, ownerId, input.sessionId, input.cycleId, input.revision]);
    } else await client.query("UPDATE journal_recovery_drafts SET deleted = TRUE, encrypted_data = NULL, asset_ids = '[]', revision = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [input.id, input.revision]);
    // Only release assets from this retired copy, after its successor or saved journal exists.
    const remaining = (await client.query<{ asset_ids: string[] }>("SELECT asset_ids FROM journal_recovery_drafts WHERE owner_id = $1 AND deleted = FALSE", [ownerId])).rows;
    for (const assetId of old?.asset_ids ?? []) {
      if (!remaining.some(row => row.asset_ids.includes(assetId))) await client.query("DELETE FROM journal_recovery_assets WHERE owner_id = $1 AND asset_id = $2", [ownerId, assetId]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
