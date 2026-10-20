import type { StoredJournalDraft, StoredJournalPhoto } from "@/lib/journal-drafts";
import { decryptRecovery, encryptRecovery, fromBase64, importRecoveryKey, sealLegacyKey, toBase64 } from "@/lib/journal-crypto";

const DATABASE_NAME = "science-inquiry-journal-drafts";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Scope = { ownerId: string; sessionId: string; cycleId: string };
export type RecoveryCandidate = { id: string; savedAt: string; revision: number; local: boolean };
type Envelope = { key: string; scopeKey: string; ownerId: string; id: string; revision: number; savedAt: string; box: Blob; assetIds: string[]; sealedKey?: string; deleted?: boolean; onlyIfRevision?: number };
type Asset = { key: string; box: Blob };
type Context = Scope & { scopeKey: string; id: string; revision: number; durableRevision: number; serverRevision: number; source?: Envelope; needsFork?: boolean; pending?: Envelope; timer?: ReturnType<typeof setTimeout>; tail: Promise<void>; candidates: Map<string, Envelope>; assets: Map<string, Asset>; uploaded: Set<string> };
export type RecoveryStatus = { local: "saved" | "failed" | "pending"; server: "saved" | "failed" | "pending"; message?: string; retryAsNew?: boolean };
const contexts = new Map<string, Context>();
const keyCache = new Map<string, Promise<CryptoKey>>();
const listeners = new Map<string, Set<(value: RecoveryStatus) => void>>();
let generation = 0;
let legacyMigration: Promise<void> | undefined;

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      for (const store of ["drafts", "assets"]) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: "key" });
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("기기 복구 저장소를 열지 못했습니다."));
    request.onblocked = () => reject(new Error("다른 탭을 닫고 복구 저장소를 다시 열어 주세요."));
  });
}
async function store<T>(name: "drafts" | "assets", mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  try { return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode); const request = action(tx.objectStore(name));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("기기 복구 저장에 실패했습니다."));
    request.onerror = () => reject(request.error ?? new Error("기기 복구 저장에 실패했습니다."));
  }); } finally { db.close(); }
}
async function responseJson(response: Response) {
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message ?? "복구 사본 전송에 실패했습니다."), { status: response.status });
  return data;
}
async function request(ownerId: string, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("x-expected-user-id", ownerId);
  return fetch(url, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(30_000) });
}
async function post(ownerId: string, body: unknown) {
  return responseJson(await request(ownerId, "/api/journal-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
async function ownerKey(ownerId: string) {
  let pending = keyCache.get(ownerId);
  if (!pending) {
    const started = generation;
    pending = (async () => {
      const data = await responseJson(await request(ownerId, "/api/journal-recovery?kind=key"));
      if (started !== generation) throw new Error("로그인 계정이 변경되었습니다.");
      return importRecoveryKey(data.key);
    })();
    keyCache.set(ownerId, pending);
    void pending.catch(() => { if (keyCache.get(ownerId) === pending) keyCache.delete(ownerId); });
  }
  return pending;
}
const textContext = (e: Pick<Envelope, "ownerId" | "scopeKey" | "id" | "revision">) => `journal-v1|${e.ownerId}|${e.scopeKey}|${e.id}|${e.revision}`;
const photoContext = (ownerId: string, id: string) => `journal-photo-v1|${ownerId}|${id}`;
function notify(key: string, status: RecoveryStatus) { for (const listener of listeners.get(key) ?? []) listener(status); }
export function watchJournalRecovery(key: string, listener: (value: RecoveryStatus) => void) {
  const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
  return () => { set.delete(listener); };
}
export function initializeJournalRecovery(key: string, scope: Scope) {
  if (!contexts.has(key)) contexts.set(key, { ...scope, scopeKey: key, id: crypto.randomUUID(), revision: 0, durableRevision: 0, serverRevision: 0, tail: Promise.resolve(), candidates: new Map(), assets: new Map(), uploaded: new Set() });
}
function contextFor(key: string) { const c = contexts.get(key); if (!c) throw new Error("복구 저장소가 잠겨 있습니다. 다시 로그인해 주세요."); return c; }

/** Convert ALL legacy plaintext records on this device without exposing another owner's key. */
export async function sealLegacyJournalDrafts(currentUserId: string) {
  legacyMigration ??= (async () => {
    const values = await store<Array<Envelope | StoredJournalDraft>>("drafts", "readonly", s => s.getAll());
    const legacy = values.filter((entry): entry is StoredJournalDraft => !("box" in entry));
    if (!legacy.length) return;
    const { publicKey } = await responseJson(await request(currentUserId, "/api/journal-recovery?kind=legacy-seal"));
    for (const draft of legacy) {
      const ownerId = draft.key.slice(draft.key.lastIndexOf(":") + 1);
      if (!ownerId || ownerId.length > 200) throw new Error("이전 초안의 소유자를 확인할 수 없습니다.");
      const rawKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      const encrypted: Envelope = { key: `${draft.key}:legacy`, scopeKey: draft.key, ownerId, id: crypto.randomUUID(), revision: 1, savedAt: draft.savedAt, box: new Blob(), assetIds: [], sealedKey: await sealLegacyKey(publicKey, ownerId, rawKey) };
      const photos = await Promise.all(draft.newPhotos.map(async p => ({ ...p, blob: undefined, bytes: toBase64(new Uint8Array(await p.blob.arrayBuffer())) })));
      encrypted.box = await encryptRecovery(await importRecoveryKey(rawKey), encoder.encode(JSON.stringify({ ...draft, newPhotos: photos })), textContext(encrypted));
      const db = await database();
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite"); const table = tx.objectStore("drafts");
        table.put(encrypted); table.delete(draft.key);
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      }); } finally { db.close(); }
    }
  })().catch(error => { legacyMigration = undefined; throw error; });
  return legacyMigration;
}

export async function listJournalRecoveryDrafts(key: string): Promise<RecoveryCandidate[]> {
  const c = contextFor(key);
  // Preload the owner key while online so later offline edits can still be encrypted.
  await ownerKey(c.ownerId);
  const [local, remote] = await Promise.allSettled([
    store<Envelope[]>("drafts", "readonly", s => s.getAll()),
    request(c.ownerId, `/api/journal-recovery?sessionId=${encodeURIComponent(c.sessionId)}&cycleId=${encodeURIComponent(c.cycleId)}`).then(responseJson),
  ]);
  const merged = new Map<string, Envelope>(); const localIds = new Set<string>();
  if (remote.status === "fulfilled") for (const row of remote.value.drafts as Array<{ id: string; revision: number; data: string; assetIds: string[]; savedAt: string }>) merged.set(row.id, { ...row, ownerId: c.ownerId, scopeKey: key, key: `${key}:${row.id}`, box: new Blob([fromBase64(row.data)]) });
  if (local.status === "fulfilled") for (const row of local.value) {
    if (row.ownerId !== c.ownerId || row.scopeKey !== key) continue;
    localIds.add(row.id);
    if (row.deleted) { merged.delete(row.id); void retire(c, row).catch(() => undefined); continue; }
    if (!merged.has(row.id) || merged.get(row.id)!.revision <= row.revision) merged.set(row.id, row);
  }
  if (local.status === "rejected" && remote.status === "rejected") throw new Error("복구 사본을 읽지 못했습니다. 연결과 기기 저장 공간을 확인해 주세요.");
  c.candidates = merged;
  return [...merged.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map(row => ({ id: row.id, revision: row.revision, savedAt: row.savedAt, local: localIds.has(row.id) }));
}
export async function restoreJournalRecoveryDraft(key: string, id: string): Promise<StoredJournalDraft> {
  const c = contextFor(key); const e = c.candidates.get(id);
  if (!e) throw new Error("복구 사본을 찾을 수 없습니다.");
  const cryptoKey = e.sealedKey ? await importRecoveryKey((await post(c.ownerId, { action: "unlock-legacy", sealedKey: e.sealedKey })).key) : await ownerKey(c.ownerId);
  const data = JSON.parse(decoder.decode(await decryptRecovery(cryptoKey, e.box, textContext(e))));
  const photos: StoredJournalPhoto[] = [];
  for (const photo of data.newPhotos) {
    if (e.sealedKey) { const { bytes, ...rest } = photo; photos.push({ ...rest, blob: new Blob([fromBase64(bytes)], { type: photo.contentType }) }); continue; }
    const assetKey = `${c.ownerId}:${photo.clientId}`;
    let asset = await store<Asset | undefined>("assets", "readonly", s => s.get(assetKey)).catch(() => undefined);
    if (!asset) {
      const response = await request(c.ownerId, `/api/journal-recovery/assets/${encodeURIComponent(photo.clientId)}`);
      if (!response.ok) throw new Error("복구 사진을 읽지 못했습니다. 연결 후 이 사본을 다시 선택해 주세요.");
      asset = { key: assetKey, box: await response.blob() };
      await store("assets", "readwrite", s => s.put(asset!)).catch(() => undefined);
    }
    c.assets.set(photo.clientId, asset);
    photos.push({ ...photo, blob: new Blob([await decryptRecovery(cryptoKey, asset.box, photoContext(c.ownerId, photo.clientId))], { type: photo.contentType }) });
  }
  c.source = e;
  return { ...data, key, newPhotos: photos };
}

async function retire(c: Context, e: Envelope) {
  if (!e.sealedKey) await post(c.ownerId, { action: "retire", id: e.id, sessionId: c.sessionId, cycleId: c.cycleId, revision: e.revision, ...(e.onlyIfRevision !== undefined ? { onlyIfRevision: e.onlyIfRevision } : {}) });
  await store("drafts", "readwrite", s => s.delete(e.key));
}
async function sync(c: Context, e: Envelope) {
  for (const id of e.assetIds) {
    if (c.uploaded.has(id)) continue;
    const asset = c.assets.get(id) ?? await store<Asset | undefined>("assets", "readonly", s => s.get(`${c.ownerId}:${id}`));
    if (!asset) throw new Error("복구 사진을 찾지 못했습니다. 현재 화면에서 사진을 다시 선택해 주세요.");
    await responseJson(await request(c.ownerId, `/api/journal-recovery/assets/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: asset.box }));
    c.uploaded.add(id);
  }
  try {
    await post(c.ownerId, { action: "save", id: e.id, sessionId: c.sessionId, cycleId: c.cycleId, revision: e.revision, data: toBase64(new Uint8Array(await e.box.arrayBuffer())), assetIds: e.assetIds });
  } catch (error) {
    // Another copy can retire a shared asset between upload and metadata save.
    // Re-send the same encrypted bytes on retry; server identity checks remain.
    if ((error as { status?: number }).status === 400) for (const id of e.assetIds) c.uploaded.delete(id);
    throw error;
  }
  if (c.id === e.id) c.serverRevision = Math.max(c.serverRevision, e.revision);
  // Retire only the exact restored revision after the replacement is durable.
  const source = c.source;
  if (source && source.id !== e.id) {
    await retire(c, { ...source, onlyIfRevision: source.revision }).catch(() => undefined);
    c.source = undefined;
  }
}
function flush(c: Context) {
  if (c.timer) clearTimeout(c.timer); c.timer = undefined;
  const pending = c.pending; if (!pending) return c.tail;
  c.pending = undefined;
  const job = c.tail.then(() => sync(c, pending));
  c.tail = job.catch(error => {
    if (c.id === pending.id && (!c.pending || c.pending.revision < pending.revision)) c.pending = pending;
    const retryAsNew = (error as { status?: number }).status === 409 && c.id === pending.id;
    if (retryAsNew) c.needsFork = true;
    if (contexts.get(c.scopeKey) === c && c.id === pending.id) notify(c.scopeKey, { retryAsNew, local: c.durableRevision >= pending.revision ? "saved" : "failed", server: "failed", message: error instanceof Error ? error.message : "자동 복구 전송에 실패했습니다." });
  });
  void job.then(() => { if (contexts.get(c.scopeKey) === c && c.id === pending.id) notify(c.scopeKey, { local: c.durableRevision >= pending.revision ? "saved" : "failed", server: c.pending ? "pending" : "saved" }); }, () => undefined);
  return c.tail;
}
export async function persistEncryptedJournalDraft(draft: StoredJournalDraft) {
  const c = contextFor(draft.key); const started = generation;
  if (c.needsFork) { c.id = crypto.randomUUID(); c.revision = 0; c.durableRevision = 0; c.serverRevision = 0; c.needsFork = false; }
  const id = c.id; const revision = ++c.revision;
  const cryptoKey = await ownerKey(c.ownerId);
  for (const photo of draft.newPhotos) {
    if (c.assets.has(photo.clientId)) continue;
    const box = await encryptRecovery(cryptoKey, new Uint8Array(await photo.blob.arrayBuffer()), photoContext(c.ownerId, photo.clientId));
    c.assets.set(photo.clientId, { key: `${c.ownerId}:${photo.clientId}`, box });
  }
  const envelope: Envelope = { key: `${draft.key}:${id}`, scopeKey: draft.key, ownerId: c.ownerId, id, revision, savedAt: draft.savedAt, box: new Blob(), assetIds: draft.newPhotos.map(p => p.clientId) };
  envelope.box = await encryptRecovery(cryptoKey, encoder.encode(JSON.stringify({ ...draft, newPhotos: draft.newPhotos.map(({ blob: _blob, ...p }) => p) })), textContext(envelope));
  if (started !== generation) throw new Error("로그아웃 후 초안을 저장할 수 없습니다.");
  let storageError: unknown;
  try {
    for (const photo of draft.newPhotos) await store("assets", "readwrite", s => s.put(c.assets.get(photo.clientId)!));
    await store("drafts", "readwrite", s => s.put(envelope));
    c.durableRevision = revision;
  } catch (error) { storageError = error; }
  c.pending = envelope; if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => void flush(c), 1500);
  notify(draft.key, { local: storageError ? "failed" : "saved", server: "pending" });
  if (storageError) throw storageError;
}
export async function removeEncryptedJournalDraft(key: string) {
  const c = contextFor(key);
  if (c.timer) clearTimeout(c.timer); c.timer = undefined; c.pending = undefined;
  const old: Envelope = { key: `${key}:${c.id}`, scopeKey: key, ownerId: c.ownerId, id: c.id, revision: c.revision + 1, savedAt: new Date().toISOString(), box: new Blob(), assetIds: [], deleted: true };
  c.id = crypto.randomUUID(); c.revision = 0; c.durableRevision = 0; c.serverRevision = 0;
  const source = c.source; c.source = undefined;
  await store("drafts", "readwrite", s => s.put(old)).catch(() => undefined);
  await c.tail;
  await retire(c, old);
  if (source) await retire(c, { ...source, onlyIfRevision: source.revision }).catch(() => undefined);
}
export async function flushJournalRecoveries() { await Promise.allSettled([...contexts.values()].map(flush)); }
export function lockJournalRecoveries() {
  generation++;
  for (const c of contexts.values()) if (c.timer) clearTimeout(c.timer);
  contexts.clear(); keyCache.clear(); legacyMigration = undefined;
}
export function retryJournalRecoveries() { for (const c of contexts.values()) void flush(c); }

export function isCurrentJournalDraftDurable(key: string) { const c = contexts.get(key); return Boolean(c && c.revision > 0 && Math.max(c.durableRevision, c.serverRevision) >= c.revision); }
