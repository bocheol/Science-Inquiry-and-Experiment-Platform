"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Draft<T> = { token: string; value: T; baseVersion?: number | null };
type Snapshot<T> = { value: T; version: number | null | undefined };

// Callers key the component by user/document identity. Only input events write
// recovery data; mounting or receiving a server response never writes a draft.
export function useFormDraft<T>(key: string, initial: T, validate: (value: unknown) => value is T, initialVersion?: number | null) {
  const [value, setValue] = useState(initial);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [warning, setWarning] = useState("");
  const current = useRef<Draft<T>>({ token: "", value: initial, baseVersion: initialVersion });
  const [server, setServer] = useState<Snapshot<T>>({ value: initial, version: initialVersion });
  const dirty = useRef(false);
  const validator = useRef(validate);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const draft = JSON.parse(raw) as Draft<unknown>;
        if (typeof draft.token !== "string" || !validator.current(draft.value)) throw new Error("Invalid draft");
        current.current = { token: draft.token, value: draft.value, baseVersion: draft.baseVersion };
        dirty.current = true;
        setValue(draft.value);
        setPending(true);
      }
    } catch {
      setWarning("이 브라우저의 복구용 초안을 읽지 못했습니다. 화면을 떠나기 전에 저장해 주세요.");
    }
    setReady(true);
  }, [key]);

  const change = useCallback((update: T | ((previous: T) => T)) => {
    const next = typeof update === "function" ? (update as (previous: T) => T)(current.current.value) : update;
    current.current = { token: crypto.randomUUID(), value: next, baseVersion: current.current.baseVersion };
    dirty.current = true;
    setValue(next);
    setPending(true);
    try { sessionStorage.setItem(key, JSON.stringify(current.current)); }
    catch { setWarning("복구용 초안을 보관하지 못했습니다. 화면을 떠나기 전에 저장해 주세요."); }
  }, [key]);

  const hydrate = useCallback((server: T, version?: number | null) => {
    setServer({ value: server, version });
    if (dirty.current) return;
    current.current = { token: "", value: server, baseVersion: version };
    setValue(server);
  }, []);

  const acknowledge = useCallback((sent: Draft<T>, version: number) => {
    // An earlier, unmounted form must not remove a newer form's recovery draft.
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const stored = JSON.parse(raw) as Draft<T>;
        if (stored.token === sent.token) sessionStorage.removeItem(key);
        else if (stored.baseVersion === sent.baseVersion) sessionStorage.setItem(key, JSON.stringify({ ...stored, baseVersion: version }));
      }
    } catch { /* Keep the screen contents even when browser storage is unavailable. */ }
    window.dispatchEvent(new CustomEvent("science-form-saved", { detail: { key, sent, version } }));
  }, [key]);

  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; sent: Draft<T>; version: number }>).detail;
      if (detail.key !== key || current.current.baseVersion !== detail.sent.baseVersion) return;
      current.current = { ...current.current, baseVersion: detail.version };
      setServer((previous) => typeof previous.version === "number" && previous.version > detail.version ? previous : { value: detail.sent.value, version: detail.version });
      if (current.current.token === detail.sent.token) { dirty.current = false; setPending(false); }
    };
    window.addEventListener("science-form-saved", saved);
    return () => window.removeEventListener("science-form-saved", saved);
  }, [key]);

  function resolve(keepMine: boolean) {
    if (server.version === undefined) return;
    current.current = { token: crypto.randomUUID(), value: keepMine ? current.current.value : server.value, baseVersion: server.version };
    dirty.current = keepMine;
    setValue(current.current.value);
    setPending(keepMine);
    setServer({ ...server });
    try {
      if (keepMine) sessionStorage.setItem(key, JSON.stringify(current.current));
      else sessionStorage.removeItem(key);
    } catch { setWarning("복구용 초안을 보관하지 못했습니다. 화면을 떠나기 전에 저장해 주세요."); }
  }

  const conflict = ready && pending && server.version !== undefined && current.current.baseVersion !== server.version;
  return { value, change, hydrate, acknowledge, capture: () => current.current, ready, pending, warning, conflict, server: server.value, resolve };
}

export class FormSaveError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function saveForm(url: string, body: unknown) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const result = await response.json() as { message?: string; version?: number };
    if (!response.ok) throw new FormSaveError(result.message ?? "저장하지 못했습니다. 작성 내용을 확인해 주세요.", response.status);
    if (!Number.isInteger(result.version)) throw new Error("저장 확인을 받지 못했습니다. 작성 내용은 보관되어 있습니다. 다시 확인해 주세요.");
    return result.version!;
  } catch (cause) {
    if (cause instanceof TypeError || (cause instanceof Error && cause.name === "AbortError")) {
      throw new Error("연결이 끊겼거나 응답이 늦습니다. 작성 내용은 유지되며 저장을 다시 시도할 수 있습니다.");
    }
    throw cause;
  } finally { window.clearTimeout(timer); }
}
