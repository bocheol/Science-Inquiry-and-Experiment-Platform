import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { generateKeyPairSync } from "node:crypto";
import { initializeJournalRecovery, listJournalRecoveryDrafts, restoreJournalRecoveryDraft, persistEncryptedJournalDraft, flushJournalRecoveries, lockJournalRecoveries, sealLegacyJournalDrafts, isCurrentJournalDraftDurable } from "@/lib/journal-recovery-client";
import type { StoredJournalDraft } from "@/lib/journal-drafts";

let cookieOwner = "owner";
const remote = new Map<string, Record<string, unknown>>(), assets = new Map<string, Blob>();
const key = Buffer.alloc(32, 12).toString("base64");
const scope = { ownerId: "owner", sessionId: "session", cycleId: "cycle" };
const scopeKey = "session:cycle:owner";
function draft(text = "합성 비공개 입력"): StoredJournalDraft { return { key: scopeKey, sessionId: "session", sessionNumber: 1, date: "2026-10-20", activities: text, observations: "", reflections: "", baseVersion: null, existingImages: [], newPhotos: [], pendingSync: false, savedAt: new Date().toISOString() }; }
async function rows() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("science-inquiry-journal-drafts", 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => { const r = db.transaction("drafts").objectStore("drafts").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
}
beforeEach(() => {
  lockJournalRecoveries(); cookieOwner = "owner"; remote.clear(); assets.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const owner = new Headers(init.headers).get("x-expected-user-id");
    if (owner !== cookieOwner) return Response.json({ message: "다른 계정" }, { status: 403 });
    if (url.endsWith("kind=key")) return Response.json({ key });
    if (url.endsWith("kind=legacy-seal")) return Response.json({ publicKey: generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey });
    if (url.includes("/assets/")) {
      if (init.method === "POST") { assets.set(`${owner}:${url}`, init.body as Blob); return Response.json({ ok: true }); }
      const value = assets.get(`${owner}:${url}`); return value ? new Response(value) : new Response(null, { status: 403 });
    }
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "retire") remote.delete(body.id);
      if (body.action === "save") remote.set(body.id, { ...body, owner, savedAt: new Date().toISOString() });
      return Response.json({ ok: true });
    }
    return Response.json({ drafts: [...remote.values()].filter(row => row.owner === owner) });
  }));
  initializeJournalRecovery(scopeKey, scope);
});
afterEach(() => { lockJournalRecoveries(); vi.unstubAllGlobals(); });

it("stores ciphertext only and restores text and photos after a fresh authenticated session", async () => {
  const input = draft(); input.newPhotos = [{ clientId: crypto.randomUUID(), fileName: "synthetic.jpg", contentType: "image/jpeg", blob: new Blob(["synthetic photo"]) }];
  await listJournalRecoveryDrafts(scopeKey); await persistEncryptedJournalDraft(input); await flushJournalRecoveries();
  const stored = await rows(); expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain(input.activities);
  expect(JSON.stringify(stored)).not.toContain("synthetic.jpg");
  expect(stored[0]!.box).toBeInstanceOf(Blob);
  expect(remote.size).toBe(1); expect(assets.size).toBe(1);
  const photoCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes("/assets/") && init?.method === "POST").length;
  await persistEncryptedJournalDraft({ ...input, activities: "추가 입력" }); await flushJournalRecoveries();
  expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes("/assets/") && init?.method === "POST")).toHaveLength(photoCalls);
  lockJournalRecoveries(); initializeJournalRecovery(scopeKey, scope);
  const candidates = await listJournalRecoveryDrafts(scopeKey); expect(candidates).toHaveLength(1);
  const restored = await restoreJournalRecoveryDraft(scopeKey, candidates[0]!.id);
  expect(restored.activities).toBe("추가 입력"); expect(await restored.newPhotos[0]!.blob.text()).toBe("synthetic photo");
});
it("requires the original owner to unlock after account switching", async () => {
  await persistEncryptedJournalDraft(draft()); await flushJournalRecoveries();
  lockJournalRecoveries(); cookieOwner = "peer";
  initializeJournalRecovery(scopeKey, scope);
  await expect(listJournalRecoveryDrafts(scopeKey)).rejects.toThrow("다른 계정");
  initializeJournalRecovery("session:cycle:peer", { ...scope, ownerId: "peer" });
  expect(await listJournalRecoveryDrafts("session:cycle:peer")).toEqual([]);
});
it("still sends the owner-only server recovery when IndexedDB writes fail", async () => {
  await listJournalRecoveryDrafts(scopeKey);
  vi.stubGlobal("indexedDB", { open() { throw new Error("synthetic storage failure"); } });
  await expect(persistEncryptedJournalDraft(draft())).rejects.toThrow("storage failure");
  await flushJournalRecoveries();
  expect(remote.size).toBe(1); expect(isCurrentJournalDraftDurable(scopeKey)).toBe(true);
});
it("forks a retired writer without losing its local copy and does not revive the old identifier", async () => {
  await persistEncryptedJournalDraft(draft());
  const oldId = (await rows())[0]!.id;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (init?.method === "POST" && String(url) === "/api/journal-recovery" && JSON.parse(String(init.body)).id === oldId) return Response.json({ message: "이미 정리된 사본" }, { status: 409 });
    return original(url, init);
  });
  await flushJournalRecoveries(); expect(remote.size).toBe(0);
  await persistEncryptedJournalDraft(draft("추가 입력을 보존")); await flushJournalRecoveries();
  expect(remote.size).toBe(1); expect([...remote.keys()]).not.toContain(oldId);
  expect(await rows()).toHaveLength(2);
});
it("rejects an encryption key response arriving after logout", async () => {
  let complete!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  const pending = listJournalRecoveryDrafts(scopeKey); lockJournalRecoveries();
  complete(Response.json({ key }));
  await expect(pending).rejects.toThrow("변경");
});
it("seals an old plaintext draft for its original owner even when a different account opens the device", async () => {
  const old = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("science-inquiry-journal-drafts", 1); r.onupgradeneeded = () => r.result.createObjectStore("drafts", { keyPath: "key" }); r.onsuccess = () => resolve(r.result); });
  await new Promise<void>(resolve => { const tx = old.transaction("drafts", "readwrite"); tx.objectStore("drafts").put(draft("이전 계정의 평문")); tx.oncomplete = () => resolve(); }); old.close();
  cookieOwner = "peer"; await sealLegacyJournalDrafts("peer");
  const records = await rows(); expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ ownerId: "owner", sealedKey: expect.any(String), box: expect.any(Blob) });
  expect(JSON.stringify(records)).not.toContain("이전 계정의 평문");
});
