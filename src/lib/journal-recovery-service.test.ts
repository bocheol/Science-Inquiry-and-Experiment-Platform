import { beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getJournalRecoveryKey, getLegacyRecoverySeal, getRecoveryAsset, listRecoveryDrafts, putRecoveryAsset, retireRecoveryDraft, saveRecoveryDraft, unlockLegacyRecoveryKey, RECOVERY_OWNER_ASSET_BYTES } from "@/lib/journal-recovery-service";
import { sealLegacyKey, toBase64 } from "@/lib/journal-crypto";

const owner = "demo_student_1", peer = "demo_student_2", sessionId = "demo_session_1";
let cycleId: string;
beforeAll(async () => { const db = await getDb(); cycleId = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id=$1", [sessionId])).rows[0].id; });
it("returns a stable owner key and rejects teachers and inactive owners", async () => {
  const key = await getJournalRecoveryKey(owner);
  expect(key).toHaveLength(32); expect(await getJournalRecoveryKey(owner)).toEqual(key);
  expect(await getJournalRecoveryKey(peer)).not.toEqual(key);
  await expect(getJournalRecoveryKey("teacher_bootstrap")).rejects.toMatchObject({ status: 403 });
  const db = await getDb(); await db.query("UPDATE users SET status='inactive' WHERE id=$1", [peer]);
  await expect(getJournalRecoveryKey(peer)).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE users SET status='active' WHERE id=$1", [peer]);
});
it("isolates encrypted assets, accepts identical retries and rejects reused identifiers with different bytes", async () => {
  const id = randomUUID(), data = randomBytes(100);
  await putRecoveryAsset(owner, id, data); await putRecoveryAsset(owner, id, data);
  expect(await getRecoveryAsset(owner, id)).toEqual(data);
  await expect(getRecoveryAsset(peer, id)).rejects.toMatchObject({ status: 403 });
  await expect(putRecoveryAsset(owner, id, Buffer.alloc(100, 18))).rejects.toThrow("다릅니다");
});
it("limits asset growth, accepts retries at capacity and releases only assets no longer referenced", async () => {
  const db = await getDb(); const quotaId = randomUUID();
  await putRecoveryAsset(peer, quotaId, Buffer.alloc(100, 1));
  // Synthetic accounting fixture avoids allocating 100 MiB just to test the bound.
  await db.query("UPDATE journal_recovery_assets SET byte_size=$1 WHERE owner_id=$2 AND asset_id=$3", [RECOVERY_OWNER_ASSET_BYTES, peer, quotaId]);
  await putRecoveryAsset(peer, quotaId, Buffer.alloc(100, 1));
  await expect(putRecoveryAsset(peer, randomUUID(), Buffer.alloc(100, 2))).rejects.toThrow("한도");
  const one = { id: randomUUID(), sessionId, cycleId, revision: 1, data: randomBytes(100), assetIds: [quotaId] };
  const two = { ...one, id: randomUUID() };
  await saveRecoveryDraft(peer, one); await saveRecoveryDraft(peer, two);
  expect((await listRecoveryDrafts(peer, sessionId, cycleId)).find(r => r.id === one.id)?.encrypted_data).toEqual(one.data);
  await retireRecoveryDraft(peer, { ...one, revision: 2 }); expect(await getRecoveryAsset(peer, quotaId)).toHaveLength(100);
  await retireRecoveryDraft(peer, { ...two, revision: 2 }); await expect(getRecoveryAsset(peer, quotaId)).rejects.toMatchObject({ status: 403 });
});
it("preserves newer revisions and rejects cross-owner writes and post-retirement uploads", async () => {
  const assetId = randomUUID(); await putRecoveryAsset(owner, assetId, Buffer.alloc(100, 2));
  const input = { id: randomUUID(), sessionId, cycleId, revision: 1, data: Buffer.alloc(100, 3), assetIds: [assetId] };
  await saveRecoveryDraft(owner, input); await saveRecoveryDraft(owner, input);
  await expect(saveRecoveryDraft(peer, input)).rejects.toMatchObject({ status: 403 });
  expect(await listRecoveryDrafts(peer, sessionId, cycleId)).toEqual([]);
  await saveRecoveryDraft(owner, { ...input, revision: 3, data: Buffer.alloc(100, 4) });
  await expect(saveRecoveryDraft(owner, { ...input, revision: 2 })).rejects.toThrow("최신");
  await expect(retireRecoveryDraft(owner, { ...input, revision: 4, onlyIfRevision: 1 })).rejects.toThrow("최신");
  expect((await listRecoveryDrafts(owner, sessionId, cycleId)).find(row => row.id === input.id)?.revision).toBe(3);
  await retireRecoveryDraft(owner, { ...input, revision: 4 });
  await expect(saveRecoveryDraft(owner, { ...input, revision: 5 })).rejects.toThrow("정리");
});
it("uses tombstones when cleanup arrives before the first upload", async () => {
  const input = { id: randomUUID(), sessionId, cycleId, revision: 1, data: Buffer.alloc(100, 6), assetIds: [] };
  await retireRecoveryDraft(owner, { ...input, revision: 2 });
  await expect(saveRecoveryDraft(owner, input)).rejects.toThrow("정리");
});
it("will not publish a recoverable draft until all encrypted photos arrived", async () => {
  const input = { id: randomUUID(), sessionId, cycleId, revision: 1, data: Buffer.alloc(100, 5), assetIds: [randomUUID()] };
  await expect(saveRecoveryDraft(owner, input)).rejects.toThrow("사진 전송");
  expect((await listRecoveryDrafts(owner, sessionId, cycleId)).some(row => row.id === input.id)).toBe(false);
});
it("locks legacy drafts to the owner inside the sealed key, including when a peer migrates the device", async () => {
  const seal = await getLegacyRecoverySeal(), key = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await sealLegacyKey(seal.public_key, owner, key);
  expect(await unlockLegacyRecoveryKey(owner, sealed)).toBe(key);
  await expect(unlockLegacyRecoveryKey(peer, sealed)).rejects.toMatchObject({ status: 403 });
  await expect(unlockLegacyRecoveryKey(owner, sealed.slice(1))).rejects.toMatchObject({ status: 403 });
});
