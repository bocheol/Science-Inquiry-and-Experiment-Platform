"use client";

import { useEffect, useRef, useState } from "react";
import { DocumentDrafts, reportFieldValue, sameFieldValue, type FieldDraft } from "@/lib/document-drafts";

type Options = {
  kind: "plan" | "report";
  documentId: string;
  cycleId: string;
  configVersionId: string | null;
  currentUserId: string;
  remote: Record<string, unknown>;
  onRefresh: () => Promise<void>;
};

export function useDocumentEditor(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const drafts = useRef(new DocumentDrafts());
  const saving = useRef(false);
  const active = useRef<string | null>(null);
  const bases = useRef<Record<string, unknown>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [, render] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [legacyDraft, setLegacyDraft] = useState<Record<string, unknown>>({});
  const storageKey = `science-document-draft:${options.currentUserId}:${options.kind}:${options.documentId}:${options.cycleId}:${options.configVersionId ?? "default"}`;

  function renderDrafts() {
    try {
      if (Object.keys(drafts.current.entries).length) sessionStorage.setItem(storageKey, JSON.stringify(drafts.current.entries));
      else sessionStorage.removeItem(storageKey);
    } catch {
      setError("이 탭의 임시 저장소를 사용할 수 없습니다. 서버 저장 완료를 확인하고 화면을 떠나 주세요.");
    }
    render((value) => value + 1);
  }

  useEffect(() => {
    try {
      drafts.current.restore(sessionStorage.getItem(storageKey));
      const legacy = new DocumentDrafts();
      legacy.restore(sessionStorage.getItem(`science-document-draft:${options.currentUserId}:${options.kind}:${options.documentId}`));
      setLegacyDraft(legacy.values({}));
    } catch { /* Storage can be disabled. */ }
    if (drafts.current.pendingKeys.length) setState("이 탭의 작성 내용을 복구했습니다. 팀원과 공유하려면 임시 저장해 주세요.");
    render((value) => value + 1);
  }, [storageKey]);

  useEffect(() => {
    drafts.current.reconcile(options.remote);
    renderDrafts();
  }, [options.remote]);

  async function request(url: string, body: object, method = "POST") {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "저장 요청을 처리하지 못했습니다.");
    } finally { window.clearTimeout(timer); }
  }

  async function lock(key: string, action: "acquire" | "release") {
    const { kind, documentId } = latest.current;
    await request(`/api/inquiry/${kind}/lock`, { [`${kind}Id`]: documentId, cycleId: options.cycleId, fieldKey: key, action });
  }

  function showFailure(cause: unknown) {
    const message = cause instanceof TypeError || (cause instanceof Error && cause.name === "AbortError") ? "서버 연결이 끊겼거나 응답이 늦습니다." : cause instanceof Error ? cause.message : "연결을 확인해 주세요.";
    setError(`${message} 작성 내용은 화면에 보관됩니다. 연결과 다른 팀원의 편집 상태를 확인한 뒤 저장을 다시 시도해 주세요.`);
    setState("저장하지 못한 내용이 있습니다.");
  }

  function focus(key: string) {
    active.current = key;
    bases.current[key] = latest.current.remote[key];
    setEditing(key); // Protect input before the asynchronous lock request returns.
    void lock(key, "acquire").catch(showFailure);
  }

  function change(key: string, value: unknown) {
    drafts.current.change(key, value, bases.current[key] ?? latest.current.remote[key]);
    setState("작성 중 · 아직 서버에 저장되지 않았습니다.");
    renderDrafts(); // Local recovery is independent of explicit server saves.
  }

  function save(key: string, sent: FieldDraft): Promise<boolean> {
    const job = queue.current.then(async () => {
      const { kind, documentId } = latest.current;
      setState("임시 저장 중…"); setError("");
      try {
        await lock(key, "acquire");
        const body = kind === "plan"
          ? { planId: documentId, fieldKey: key, value: sent.value, expectedValue: sent.baseValue }
          : key.startsWith("role:")
            ? { kind: "role", reportId: documentId, userId: key.slice(5), value: reportFieldValue(sent.value), expectedValue: reportFieldValue(sent.baseValue) }
            : { kind: "field", reportId: documentId, fieldKey: key, value: reportFieldValue(sent.value), expectedValue: reportFieldValue(sent.baseValue) };
        await request(`/api/inquiry/${kind}`, { ...body, cycleId: options.cycleId }, "PATCH");
        drafts.current.acknowledge(key, sent);
        bases.current[key] = sent.value;
        renderDrafts();
        setState(drafts.current.pendingKeys.length ? "저장 후 추가 작성한 내용은 다시 임시 저장해 주세요." : "임시 저장 완료 · 팀원과 공유됨");
        // A save completion must never clear focus in a different field, or
        // release the lock if the student has already returned to this field.
        await releaseIfInactive(key);
        await latest.current.onRefresh().catch(() => {
          setError("내 내용은 저장됐지만 공유 화면을 갱신하지 못했습니다. 연결이 복구되면 최신 내용을 확인해 주세요.");
        });
        return true;
      } catch (cause) {
        showFailure(cause);
        void latest.current.onRefresh().catch(() => {});
        return false;
      }
    });
    queue.current = job;
    return job;
  }

  async function releaseIfInactive(key: string) {
    if (active.current === key) return;
    try {
      await lock(key, "release");
      if (active.current === key) await lock(key, "acquire");
    } catch { /* Expiry releases a lock even if the release response is lost. */ }
  }

  function blur(key: string) {
    if (active.current === key) { active.current = null; setEditing(null); }
    void releaseIfInactive(key);
  }

  async function saveAll() {
    if (saving.current) return false;
    // Capture every field at the click, not when each queued request starts.
    const snapshot = drafts.current.pendingKeys.map((key) => [key, { ...drafts.current.entries[key] }] as const);
    if (!snapshot.length) return true;
    saving.current = true;
    setBusy(true);
    try {
      for (const [key, sent] of snapshot) if (!(await save(key, sent))) return false;
      return drafts.current.pendingKeys.length === 0;
    } finally { saving.current = false; setBusy(false); }
  }

  // Resume lock renewal even when returning to the same focused input does not
  // fire an element focus event. Drafts survive lock conflicts and failed fetches.
  const handlers = useRef({ lock, showFailure });
  handlers.current = { lock, showFailure };
  useEffect(() => {
    const renew = () => {
      if (document.visibilityState === "hidden" || !active.current) return;
      void handlers.current.lock(active.current, "acquire").catch(handlers.current.showFailure);
    };
    const resume = () => { renew(); };
    const visibility = () => {
      if (document.visibilityState !== "hidden") resume();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (drafts.current.pendingKeys.length) { event.preventDefault(); event.returnValue = ""; }
    };
    const timer = window.setInterval(renew, 15_000);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const conflicts = Object.entries(drafts.current.entries)
    .filter(([key, draft]) => !draft.saved && !sameFieldValue(options.remote[key], draft.baseValue) && !sameFieldValue(options.remote[key], draft.value))
    .map(([key, draft]) => ({ key, mine: draft.value, remote: options.remote[key] }));
  function useRemote(key: string) {
    delete drafts.current.entries[key];
    bases.current[key] = latest.current.remote[key];
    renderDrafts(); setError(""); setState("공유된 최신 내용을 불러왔습니다.");
  }
  async function keepMine(key: string) {
    const draft = drafts.current.entries[key];
    if (!draft) return;
    draft.baseValue = latest.current.remote[key] ?? "";
    renderDrafts();
    setError(""); setState("내 내용을 선택했습니다. 임시 저장을 눌러 반영해 주세요.");
  }
  return { legacyDraft, form: drafts.current.values(options.remote), editing, state, error, busy, pending: drafts.current.pendingKeys.length > 0,
    focus, change, blur, saveAll, setState, setError, conflicts, useRemote, keepMine };
}
