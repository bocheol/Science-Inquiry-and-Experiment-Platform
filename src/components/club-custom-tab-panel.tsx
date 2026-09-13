"use client";

import { useEffect, useRef, useState } from "react";
import { FormSaveError, saveForm, useFormDraft } from "@/components/use-form-draft";
import { FormConflict } from "@/components/form-conflict";
import { useToast } from "@/components/toast-provider";
import type { FormFieldDefinition } from "@/lib/club-settings";

type Tab = { id: string; title: string; definition: { description?: string; responseMode?: string; workflow?: string; fields?: FormFieldDefinition[] } };

function fieldText(field: FormFieldDefinition, value: unknown): string {
  if (field.kind === "table" && Array.isArray(value)) return value.map((row, index) => `${index + 1}행: ${(field.columns ?? []).map((column) => `${column.label}: ${String(row[column.id] ?? "")}`).join(" / ")}`).join("\n");
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "선택함" : "선택 안 함";
  return String(value ?? "");
}

export function ClubCustomTabPanel({ tab, sessionId, currentUserId }: { tab: Tab; sessionId: string; currentUserId: string }) {
  const draft = useFormDraft<Record<string, unknown>>(`science-custom-draft:${currentUserId}:${sessionId}:${tab.id}`, {},
    (value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  const values = draft.value;
  const { hydrate } = draft;
  const [status, setStatus] = useState("draft");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const sending = useRef(false);
  const [error, setError] = useState("");
  const { showToast } = useToast();
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    fetch(`/api/club-tabs?sessionId=${encodeURIComponent(sessionId)}&configVersionId=${encodeURIComponent(tab.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.message); if (active) { hydrate(result.responseData, result.version); setStatus(result.status); setFeedback(result.teacherFeedback); setLoaded(true); } })
      .catch(() => active && setError("서버 내용을 불러오지 못했습니다. 복구용 초안은 유지됩니다. 다시 불러온 뒤 저장해 주세요."))
      .finally(() => { window.clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [sessionId, tab.id, hydrate, reload]);
  function change(id: string, value: unknown) { draft.change((current) => ({ ...current, [id]: value })); }
  async function save(submit: boolean) {
    if (sending.current || !loaded || !draft.ready || draft.conflict) return;
    sending.current = true;
    const sent = draft.capture();
    setBusy(true); setError("");
    try {
      const version = await saveForm("/api/club-tabs", { sessionId, configVersionId: tab.id, responseData: sent.value, submit, expectedVersion: sent.baseVersion });
      draft.acknowledge(sent, version);
      if (submit) setFeedback(null);
      setStatus(submit && tab.definition.workflow === "review" ? "submitted" : "draft"); showToast(submit ? "교사 검토를 요청했습니다." : "내용을 저장했습니다.");
    } catch (cause) { const message = cause instanceof Error ? cause.message : "저장하지 못했습니다."; setError(message); showToast(message, "error"); if (cause instanceof FormSaveError && cause.status === 409) setReload((value) => value + 1); }
    finally { sending.current = false; setBusy(false); }
  }
  if (!draft.ready || (loading && !draft.pending)) return <div className="empty-state">탭 내용을 불러오는 중…</div>;
  return <section className="stack">{draft.conflict ? <FormConflict rows={(tab.definition.fields ?? []).filter((field) => field.kind !== "heading").map((field) => ({ label: field.label, mine: fieldText(field, draft.value[field.id]), server: fieldText(field, draft.server[field.id]) }))} onResolve={draft.resolve} /> : null}<div><h2 className="section-heading">{tab.title}</h2><p className="section-subtitle">{tab.definition.description}</p></div>{draft.warning ? <div className="warning-box" role="alert">{draft.warning}</div> : null}{draft.pending ? <p className="save-state">저장하지 않은 작성 내용이 이 탭에 보관되어 있습니다.</p> : null}{feedback ? <div className="notice-box"><b>교사 의견</b><p>{feedback}</p></div> : null}{error ? <div className="error-box" role="alert">{error}{!loaded ? <button className="button secondary" disabled={loading} onClick={() => setReload((value) => value + 1)}>다시 불러오기</button> : null}</div> : null}<div className="stack">{(tab.definition.fields ?? []).map((field) => {
    if (field.kind === "heading") return <h3 key={field.id}>{field.label}</h3>;
    const value = values[field.id];
    if (field.kind === "long_text") return <label className="label" key={field.id}>{field.label}{field.required ? " *" : ""}<textarea className="textarea" value={String(value ?? "")} onChange={(event) => change(field.id, event.target.value)} /><small>{field.help}</small></label>;
    if (field.kind === "single_choice") return <label className="label" key={field.id}>{field.label}{field.required ? " *" : ""}<select className="select" value={String(value ?? "")} onChange={(event) => change(field.id, event.target.value)}><option value="">선택</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select></label>;
    if (field.kind === "multiple_choice") return <fieldset key={field.id}><legend>{field.label}{field.required ? " *" : ""}</legend>{field.options?.map((option) => <label key={option}><input type="checkbox" checked={(Array.isArray(value) ? value : []).includes(option)} onChange={(event) => { const selected = Array.isArray(value) ? value.map(String) : []; change(field.id, event.target.checked ? [...selected, option] : selected.filter((item) => item !== option)); }} /> {option}</label>)}</fieldset>;
    if (field.kind === "checkbox") return <label key={field.id}><input type="checkbox" checked={Boolean(value)} onChange={(event) => change(field.id, event.target.checked)} /> {field.label}{field.required ? " *" : ""}</label>;
    if (field.kind === "table") { const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : []; return <div className="stack" key={field.id}><b>{field.label}{field.required ? " *" : ""}</b>{rows.map((row, rowIndex) => <div className="toolbar-group" key={rowIndex}>{field.columns?.map((column) => <label className="label" key={column.id}>{column.label}<input className="input" type={column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text"} value={String(row[column.id] ?? "")} onChange={(event) => { const next = rows.map((item) => ({ ...item })); next[rowIndex][column.id] = event.target.value; change(field.id, next); }} /></label>)}<button type="button" className="button ghost" onClick={() => change(field.id, rows.filter((_, index) => index !== rowIndex))}>행 삭제</button></div>)}<button type="button" className="button secondary" onClick={() => change(field.id, [...rows, {}])}>행 추가</button></div>; }
    return <label className="label" key={field.id}>{field.label}{field.required ? " *" : ""}<input className="input" type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"} value={String(value ?? "")} onChange={(event) => change(field.id, event.target.value)} /><small>{field.help}</small></label>;
  })}</div><div className="toolbar-group"><button className="button secondary" disabled={busy || draft.conflict || !loaded} onClick={() => void save(false)}>{busy ? "저장 중…" : "임시 저장"}</button>{tab.definition.workflow === "review" ? <button className="button" disabled={busy || draft.conflict || !loaded || (status === "submitted" && !draft.pending)} onClick={() => void save(true)}>{status === "submitted" && !draft.pending ? "검토 요청됨" : "교사 검토 요청"}</button> : null}<span className="save-state">{tab.definition.responseMode === "individual" ? "개인 작성" : "팀 공동 작성"}</span></div></section>;
}
