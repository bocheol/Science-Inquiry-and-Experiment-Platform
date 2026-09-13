"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DocumentDiffView } from "@/components/document-diff-view";
import { versionKey, versionTime, type DocumentScope, type VersionComparison, type VersionList, type VersionOption, type VersionRef } from "@/lib/document-version-types";

class ReadError extends Error { constructor(message: string, public status = 0) { super(message); } }
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new ReadError(result.message ?? "기록을 불러오지 못했습니다.", response.status);
  return result as T;
}
function parseRef(value: string): VersionRef {
  const colon = value.indexOf(":");
  return { kind: value.slice(0, colon) as VersionRef["kind"], ...(value.slice(colon + 1) ? { id: value.slice(colon + 1) } : {}) };
}
function optionText(option: VersionOption) { return `${option.eventAt ? `${versionTime(option.eventAt)} · ` : ""}${option.label}${option.actorName ? ` · 기록 작업자 ${option.actorName}` : ""}`; }

export function DocumentVersionButton({ scope, initialRevisionId, children }: { scope: DocumentScope; initialRevisionId?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const scopeKey = `${scope.documentType}:${scope.documentId}:${scope.cycleId}`;
  return <><button className="button secondary" onClick={() => setOpen(true)}>{children ?? "두 버전 비교"}</button>
    {open ? <ComparisonDialog key={scopeKey} scope={scope} initialRevisionId={initialRevisionId} onClose={close} /> : null}</>;
}

function ComparisonDialog({ scope, initialRevisionId, onClose }: { scope: DocumentScope; initialRevisionId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [list, setList] = useState<VersionList | null>(null);
  const [options, setOptions] = useState<VersionOption[]>([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [filters, setFilters] = useState({ fromDate: "", toDate: "", generation: 0 });
  const [cursor, setCursor] = useState("");
  const [listBusy, setListBusy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [comparison, setComparison] = useState<VersionComparison | null>(null);
  const pinned = useRef(new Map<string, string>());
  const selections = useRef({ a, b }); selections.current = { a, b };
  const query = new URLSearchParams(scope).toString();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const historyMarker = useRef(`document-compare-${headingId}`);
  const requestClose = () => {
    if (window.history.state?.documentCompare === historyMarker.current) window.history.back();
    else closeRef.current();
  };
  useEffect(() => {
    const node = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    const previousState = window.history.state;
    window.history.pushState({ ...previousState, documentCompare: historyMarker.current }, "", window.location.href);
    const pop = () => closeRef.current();
    window.addEventListener("popstate", pop);
    node.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("popstate", pop);
      if (window.history.state?.documentCompare === historyMarker.current) window.history.replaceState(previousState, "", window.location.href);
      node.close(); document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let active = true;
    setListBusy(true); setListError("");
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    if (filters.fromDate) params.set("fromDate", filters.fromDate);
    if (filters.toDate) params.set("toDate", filters.toDate);
    void read<VersionList>(`/api/document-history/versions?${params}`, controller.signal).then(result => {
      if (!active) return;
      setList(result);
      setOptions(previous => {
        const keep = cursor ? previous : previous.filter(o => [selections.current.a, selections.current.b].includes(versionKey(o.ref)));
        return [...new Map([...keep, ...result.fixed, ...result.history].map(option => [versionKey(option.ref), option])).values()];
      });
      if (!selections.current.a && !selections.current.b) {
        const initial = initialRevisionId ? { kind: "revision" as const, id: initialRevisionId } : result.history[0]?.ref ?? result.fixed[0]?.ref;
        const other = result.fixed.find(o => versionKey(o.ref) !== (initial ? versionKey(initial) : "")) ?? result.history.find(o => versionKey(o.ref) !== (initial ? versionKey(initial) : ""));
        if (initial) {
          setA(versionKey(initial));
          if (initialRevisionId && !result.history.some(o => o.ref.id === initialRevisionId)) setOptions(previous => [...previous, { ref: initial, label: "선택한 변경 기록", eventAt: null }]);
        }
        if (other) setB(versionKey(other.ref));
      }
    }).catch(caught => {
      if (!active) return;
      setListError(caught instanceof ReadError ? caught.message : "목록 연결이 끊겼거나 응답이 늦습니다. 다시 불러와 주세요.");
      if (caught instanceof ReadError && [403, 404].includes(caught.status)) { setComparison(null); setOptions([]); setList(null); pinned.current.clear(); }
    }).finally(() => { clearTimeout(timeout); if (active) setListBusy(false); });
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [query, cursor, filters, initialRevisionId]);

  useEffect(() => {
    if (!a || !b || a === b) { setBusy(false); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let active = true;
    setBusy(true); setError("");
    const params = new URLSearchParams(query);
    for (const [side, key] of [["a", a], ["b", b]]) {
      const ref = parseRef(key);
      params.set(`${side}Kind`, ref.kind);
      if (ref.id) params.set(`${side}Id`, ref.id);
      const expected = ref.kind === "current" ? pinned.current.get(key) : undefined;
      if (expected) params.set(`${side}Fingerprint`, expected);
    }
    void read<VersionComparison>(`/api/document-history/compare?${params}`, controller.signal).then(result => {
      if (!active) return;
      pinned.current.set(a, result.a.fingerprint); pinned.current.set(b, result.b.fingerprint);
      setComparison(result);
    }).catch(caught => {
      if (!active) return;
      setError(caught instanceof ReadError ? caught.message : "연결이 끊겼거나 응답이 늦습니다. 작성 내용은 유지됩니다. 다시 시도해 주세요.");
      if (caught instanceof ReadError && [403, 404].includes(caught.status)) { setComparison(null); setOptions([]); setList(null); pinned.current.clear(); }
    }).finally(() => { clearTimeout(timeout); if (active) setBusy(false); });
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [a, b, query, refresh]);

  const ready = comparison && versionKey(comparison.a.ref) === a && versionKey(comparison.b.ref) === b;
  return createPortal(<dialog className="version-dialog" ref={dialog} aria-labelledby={headingId} onCancel={event => { event.preventDefault(); requestClose(); }}>
    <header className="version-dialog-header"><div><h2 id={headingId}>{scope.documentType === "plan" ? "계획서" : "보고서"} 버전 비교</h2><p>{list ? `${list.teamName} · ${list.cycleTitle}` : "선택한 회차의 저장 기록"}</p></div><button className="button secondary" autoFocus onClick={requestClose}>닫기</button></header>
    <div className="version-dialog-body">
      <p className="notice-box">미저장 초안은 그대로 유지됩니다. 서버에 저장된 두 버전을 선택해 비교하세요.</p>
      <details className="version-search"><summary>기록 날짜로 찾기</summary>
      <form className="version-date-filter" onSubmit={event => { event.preventDefault(); setCursor(""); setFilters({ fromDate, toDate, generation: filters.generation + 1 }); }}>
        <label>기록 시작일<input className="input" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} /></label>
        <label>기록 종료일<input className="input" type="date" value={toDate} onChange={e => setToDate(e.target.value)} /></label>
        <button className="button secondary" disabled={listBusy}>날짜로 찾기</button>
        <button type="button" className="button ghost" disabled={listBusy} onClick={() => { setFromDate(""); setToDate(""); setCursor(""); setFilters({ fromDate: "", toDate: "", generation: filters.generation + 1 }); }}>전체 날짜</button>
      </form>
      </details>
      <div className="version-selectors">
        <label>기준 A<select className="select" value={a} onChange={event => setA(event.target.value)}><option value="">버전 선택</option>{options.map(option => <option key={versionKey(option.ref)} value={versionKey(option.ref)} disabled={versionKey(option.ref) === b}>{optionText(option)}</option>)}</select></label>
        <button className="button ghost" disabled={!a || !b || busy} onClick={() => { if (ready) setComparison({ ...comparison, a: comparison.b, b: comparison.a }); setA(b); setB(a); }}>A/B 맞바꾸기</button>
        <label>비교 B<select className="select" value={b} onChange={event => setB(event.target.value)}><option value="">버전 선택</option>{options.map(option => <option key={versionKey(option.ref)} value={versionKey(option.ref)} disabled={versionKey(option.ref) === a}>{optionText(option)}</option>)}</select></label>
      </div>
      <p className="section-subtitle">A에서 B로 달라진 내용 · 모든 시각은 한국 시간입니다. 기록은 주로 변경 작업 직전의 전체 상태이며, 한 번의 임시 저장에 여러 항목 이력이 남을 수 있습니다.</p>
      {listBusy ? <p role="status">기록 목록을 불러오는 중…</p> : null}
      {listError ? <div className="error-box" role="alert">{listError}<button className="button secondary" onClick={() => setFilters(previous => ({ ...previous, generation: previous.generation + 1 }))}>목록 다시 불러오기</button></div> : null}
      {list?.nextCursor ? <button className="button secondary" disabled={listBusy} onClick={() => setCursor(list.nextCursor!)}>이전 기록 더 보기</button> : null}
      {list && !listBusy && !list.history.length ? <p className="notice-box">이 날짜 범위의 변경 이력이 없습니다. 다른 날짜를 선택해 주세요.</p> : null}
      {!listBusy && options.length < 2 && !listError ? <p className="notice-box">비교할 다른 기록이 없습니다. 저장 기록이 더 생기면 두 버전을 비교할 수 있습니다.</p> : null}
      <div className="toolbar-group"><button className="button secondary" disabled={!a || !b || busy} onClick={() => setRefresh(refresh + 1)}>선택한 두 버전 다시 비교</button>
        {[a, b].some(key => key === "current:") ? <button className="button secondary" disabled={busy} onClick={() => { pinned.current.delete("current:"); setRefresh(refresh + 1); }}>현재 저장본 다시 불러오기</button> : null}</div>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {busy ? <p role="status">선택한 두 버전을 확인하는 중…</p> : null}
      {ready && !busy ? <DocumentDiffView comparison={comparison} key={`${a}/${b}/${comparison.a.fingerprint}/${comparison.b.fingerprint}`} /> : null}
    </div>
  </dialog>, document.body);
}
