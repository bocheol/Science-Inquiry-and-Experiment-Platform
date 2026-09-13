"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DailySummary, DiscussionEntry } from "@/lib/discussions";
import { useToast } from "@/components/toast-provider";

type Feed = { sources: DiscussionEntry[]; receipts?: Array<{ entryId: string; userId: string; name: string; readAt: string | null }>; unreadEntryIds?: string[]; history: DailySummary[]; jobs: Array<{ activity_date: string; requested_version: number; generated_version: number; status: string }>; cycle?: { id: string; status: string }; cycles?: Array<{ id: string; title: string; status: string }>; legacyHistory?: DailySummary[] };
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const labels = { discussion: "논의한 내용", decision: "기록에 나타난 합의", question: "미해결 질문", next: "다음에 할 일", ai_suggestion: "AI가 제안한 내용", reported_activity: "기록된 활동" };
const sourceLabels = { peer: "원격 채팅", meeting: "대면 메모", supplement: "보완 메모", ai_question: "AI에게 한 질문", ai_answer: "AI 답변" };
const time = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

export function DiscussionPanel({ sessionId, cycleId, currentUserId, members, readOnly: readOnlyProp = false, canSummarize = false, active = true }: { sessionId: string; cycleId?: string; currentUserId: string; members: Array<{ id: string; name: string }>; readOnly?: boolean; canSummarize?: boolean; active?: boolean }) {
  const [tab, setTab] = useState<"peer" | "meeting" | "summary" | "flow">("peer");
  const [date, setDate] = useState(today);
  const [feed, setFeed] = useState<Feed>({ sources: [], history: [], jobs: [] });
  const messageList = useRef<HTMLDivElement>(null);
  const [viewCycleId, setViewCycleId] = useState(cycleId);
  const readOnly = readOnlyProp || viewCycleId !== cycleId || feed.cycle?.id !== viewCycleId || feed.cycle?.status !== "active";
  const [text, setText] = useState(""); const [note, setNote] = useState("");
  const [noteDate, setNoteDate] = useState(today);
  const [participants, setParticipants] = useState<string[]>([currentUserId]);
  const [parentId, setParentId] = useState<string | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<DiscussionEntry | null>(null);
  const requestId = useRef<string | null>(null); const requestPayload = useRef("");
  const legacyDraftKey = `inquiry-discussion:${currentUserId}:${sessionId}`;
  const draftKey = `${legacyDraftKey}:${cycleId ?? "uncategorized"}`;
  const [legacyDraft, setLegacyDraft] = useState("");
  const restored = useRef(false);
  const { showToast } = useToast();
  useEffect(() => {
    try { const raw = sessionStorage.getItem(legacyDraftKey); if (raw) { const d = JSON.parse(raw); setLegacyDraft([d.text, d.note].filter(value => typeof value === "string" && value.trim()).join("\n\n")); } } catch { /* Keep unknown legacy data untouched. */ }
    try { const raw = sessionStorage.getItem(draftKey); if (raw) { const d = JSON.parse(raw); setText(d.text ?? ""); setNote(d.note ?? ""); setNoteDate(d.noteDate ?? today()); setParticipants(d.participants ?? [currentUserId]); setParentId(d.parentId ?? null); requestId.current=d.requestId??null; requestPayload.current=d.requestPayload??""; } } catch { /* Storage can be disabled. */ }
    restored.current = true;
  }, [draftKey, legacyDraftKey, currentUserId]);
  useEffect(() => {
    if (!restored.current || readOnly) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ text, note, noteDate, participants, parentId, requestId: requestId.current, requestPayload: requestPayload.current })); } catch { /* Keep the in-memory draft. */ }
  }, [draftKey, text, note, noteDate, participants, parentId, readOnly]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (text.trim() || note.trim()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [text, note]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/discussions?sessionId=${encodeURIComponent(sessionId)}&cycleId=${encodeURIComponent(viewCycleId ?? "")}&date=${date}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "기록을 불러오지 못했습니다.");
    if (!signal?.aborted) { setFeed(data); setError(""); }
  }, [sessionId, date, viewCycleId]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let loading = false;
    const load = async () => { if (loading || document.visibilityState === "hidden") return; loading = true; try { await refresh(controller.signal); } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "연결을 확인해 주세요."); } finally { loading = false; } };
    setSource(null); setFeed({ sources: [], history: [], jobs: [] }); void load();
    const timer = window.setInterval(() => void load(), tab === "peer" ? 5000 : 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh, active, tab]);

  useEffect(() => {
    if (!active || tab !== "peer" || feed.cycle?.id !== viewCycleId || !viewCycleId || !feed.unreadEntryIds?.length) return;
    const controller = new AbortController();
    const unread = new Set(feed.unreadEntryIds);
    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (document.visibilityState !== "visible" || controller.signal.aborted) return;
      const entryIds = [...visible].slice(0, 100);
      if (!entryIds.length) return;
      for (const id of entryIds) { visible.delete(id); unread.delete(id); }
      void fetch("/api/discussions", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ action: "read", sessionId, cycleId: viewCycleId, entryIds }) }).catch(() => undefined);
      // A failed/lost request remains unread in the next poll and is retried.
      if (visible.size) timer = setTimeout(flush, 100);
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        if (!id || !unread.has(id)) continue;
        if (entry.isIntersecting && entry.intersectionRect.height >= Math.min(40, entry.boundingClientRect.height)) visible.add(id);
        else visible.delete(id);
      }
      if (!timer && visible.size) timer = setTimeout(flush, 100);
    }, { threshold: [0, 0.1, 0.5, 1] });
    const observe = () => {
      observer.disconnect(); visible.clear();
      if (document.visibilityState === "visible") messageList.current?.querySelectorAll<HTMLElement>("[data-message-id]").forEach(element => observer.observe(element));
    };
    observe(); document.addEventListener("visibilitychange", observe);
    return () => { controller.abort(); observer.disconnect(); if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", observe); };
  }, [active, tab, feed, sessionId, viewCycleId]);

  async function post(payload: object) {
    const response = await fetch("/api/discussions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, sessionId, cycleId: viewCycleId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "기록을 저장하지 못했습니다.");
    return result as { date?: string; message?: string };
  }
  async function save(kind: "peer" | "meeting" | "supplement") {
    if (readOnly || busy) return;
    setBusy(true); setError("");
    const payload = { kind, content: kind === "peer" ? text : note, date: noteDate, participantIds: participants, parentId: parentId ?? undefined };
    const fingerprint = JSON.stringify(payload);
    if (requestPayload.current !== fingerprint || !requestId.current) { requestId.current = crypto.randomUUID(); requestPayload.current = fingerprint; }
    try { sessionStorage.setItem(draftKey, JSON.stringify({ text, note, noteDate, participants, parentId, requestId: requestId.current, requestPayload: requestPayload.current })); } catch { /* Retry also works without storage. */ }
    try {
      const result = await post({ action: "save", id: requestId.current, ...payload });
      requestId.current = null;
      if (kind === "peer") setText(""); else { setNote(""); setParentId(null); setTab("summary"); }
      setDate(result.date ?? today()); showToast(result.message ?? "저장했습니다."); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "연결을 확인한 뒤 다시 보내 주세요. 작성 내용은 유지됩니다."); }
    finally { setBusy(false); }
  }
  const summary = feed.history.find(h => h.activityDate === date);
  const job = feed.jobs.find(j => j.activity_date === date);
  function showEvidence(id: string, evidence?: DiscussionEntry[]) { setSource((evidence ?? feed.sources).find(s => s.id === id) ?? null); }
  function summaryContent(item: DailySummary) {
    return <div className="discussion-summary-grid">{Object.entries(labels).map(([category, label]) => {
      const items = item.items.filter(i => i.category === category);
      return items.length ? <section key={category}><h3>{label}</h3><ul>{items.map((i,index) => <li key={index}><p>{i.text}</p><div className="toolbar-group">{i.sourceIds.map((id,n) => <button className="button ghost compact" key={id} onClick={() => showEvidence(id, item.sources.length ? item.sources : feed.sources)}>근거 {n+1}</button>)}</div></li>)}</ul></section> : null;
    })}{!item.items.length ? <p>이 날짜에는 별도로 정리할 탐구 논의가 없습니다. 원문은 대화·대면 기록에서 확인할 수 있습니다.</p> : null}</div>;
  }
  return <section className="discussion-panel stack" aria-label="팀 대화와 활동 기록">
    {!readOnly && legacyDraft ? <details className="notice-box"><summary>회차를 확인할 수 없는 이전 초안</summary><p>필요한 내용을 복사해 현재 회차와 비교해 주세요.</p><pre style={{ whiteSpace: "pre-wrap" }}>{legacyDraft}</pre></details> : null}
    <div><h2 className="section-heading">팀 대화·활동 기록</h2><p className="section-subtitle">현재 팀원과 교사가 함께 보는 공간입니다. 원문과 AI 정리를 구분해 보존합니다.</p></div>
    {feed.cycles?.length ? <label className="label">탐구 회차<select className="input" aria-label="기록을 볼 탐구 회차" value={viewCycleId ?? ""} disabled={busy} onChange={event => setViewCycleId(event.target.value)}>{feed.cycles.map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.title}{cycle.status !== "active" ? " · 읽기 전용" : ""}</option>)}</select></label> : null}
    {feed.cycle?.status && feed.cycle.status !== "active" ? <p className="notice-box">완료된 회차입니다. 원문과 저장된 정리를 읽을 수 있으며 새 정리는 생성하지 않습니다.</p> : null}
    <nav className="toolbar-group" aria-label="활동 기록 메뉴">{([['peer','우리끼리 대화'],['meeting','대면 기록'],['summary','날짜별 AI 정리'],['flow','탐구 흐름']] as const).map(([value,label]) => <button className={`button ${tab===value?'':'secondary'}`} aria-pressed={tab===value} key={value} onClick={()=>setTab(value)}>{label}</button>)}</nav>
    {tab !== "flow" ? <div className="toolbar"><label className="label">활동 날짜 <input type="date" className="input" value={date} max={today()} onChange={e=>{if(e.target.value)setDate(e.target.value);}} /></label>{canSummarize && viewCycleId === cycleId && feed.cycle?.status === "active" ? <button className="button secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await post({action:'summarize',date});showToast(r.message??'처리했습니다.');await refresh();}catch(e){setError(e instanceof Error?e.message:'정리하지 못했습니다.');}finally{setBusy(false);}}}>이 날짜 지금 정리</button>:null}</div> : null}
    {error ? <p className="error-box" role="alert">{error}</p> : null}
    {tab === "summary" && feed.legacyHistory?.length ? <details className="notice-box"><summary>이전 형식의 날짜별 정리 보기</summary><p>회차 구분 전에 저장된 기록입니다. 서로 다른 회차가 섞여 있을 수 있으므로 선택한 회차의 정리와 구분해 확인해 주세요.</p>{feed.legacyHistory.map(item => <details key={item.id}><summary>{item.activityDate} · 이력 {item.version}</summary>{summaryContent(item)}</details>)}</details> : null}
    {tab === "peer" ? <>
      <div className="discussion-messages" ref={messageList}>{feed.sources.filter(s=>s.kind==='peer').map(s=>{
        const receipts = feed.receipts?.filter(row => row.entryId === s.id) ?? [];
        const read = receipts.filter(row => row.readAt);
        return <article className="message-row user" data-message-id={s.id} key={s.id}><div className="message-bubble"><div className="message-meta">{s.authorName} · {time(s.createdAt)}</div><div style={{whiteSpace:'pre-wrap'}}>{s.content}</div>{s.authorId === currentUserId && receipts.length ? <details className="message-meta"><summary>읽음 {read.length}/{receipts.length}명</summary><p>{read.length ? read.map(row => row.name).join(", ") : "아직 읽음 기록이 없습니다."}</p></details> : null}</div></article>;
      })}{!feed.sources.some(s=>s.kind==='peer')?<p className="empty-state">이 날짜의 원격 대화가 없습니다.</p>:null}</div>
      {!readOnly?<form className="stack" onSubmit={e=>{e.preventDefault();void save('peer');}}><label className="label" htmlFor={`peer-${sessionId}`}>팀원에게 보낼 메시지</label><textarea className="textarea" id={`peer-${sessionId}`} maxLength={4000} disabled={busy} value={text} onChange={e=>setText(e.target.value)} placeholder="실험 아이디어와 의견을 나눠 보세요."/><div className="toolbar"><small>새 메시지는 오늘 날짜로 저장합니다.</small><button className="button" disabled={busy||!text.trim()}>{busy?'저장 중…':'보내기'}</button></div></form>:null}
    </>:null}
    {tab === "meeting" ? <>
      {feed.sources.filter(s=>s.kind==='meeting').map(s=><article className="discussion-note" key={s.id}><h3>대면 활동 · {s.activityDate}</h3><p className="section-subtitle">작성 {s.authorName} · 입력 {time(s.createdAt)} · 참여 {s.participants.map(p=>p.name).join(', ')}</p><p style={{whiteSpace:'pre-wrap'}}>{s.content}</p><p className="section-subtitle">내용 확인: {s.confirmedBy.length}/{s.participants.length}명 · 작성자 메모에 근거한 기록</p>{feed.sources.filter(a=>a.parentId===s.id).map(a=><div className="notice-box" key={a.id}><b>{a.authorName}의 보완 · {time(a.createdAt)}</b><p style={{whiteSpace:'pre-wrap'}}>{a.content}</p></div>)}{!readOnly?<div className="toolbar-group">{s.participants.some(p=>p.id===currentUserId)?<button className="button secondary" disabled={busy||s.confirmedBy.includes(currentUserId)} onClick={async()=>{setBusy(true);try{await post({action:'confirm',entryId:s.id});await refresh();}catch(e){setError(e instanceof Error?e.message:'확인하지 못했습니다.');}finally{setBusy(false);}}}>{s.confirmedBy.includes(currentUserId)?'확인함':'원문 내용 확인'}</button>:null}<button className="button secondary" onClick={()=>{setParentId(s.id);setNoteDate(s.activityDate);}}>보완 남기기</button></div>:null}</article>)}
      {!readOnly?<form className="stack discussion-note" onSubmit={e=>{e.preventDefault();void save(parentId?'supplement':'meeting');}}><h3>{parentId?'기존 기록에 보완 남기기':'대면 기록 남기기'}</h3><label className="label">실제 활동 날짜<input type="date" className="input" max={today()} value={noteDate} disabled={Boolean(parentId)} onChange={e=>setNoteDate(e.target.value)} required/></label>{!parentId?<fieldset disabled={busy}><legend>함께 참여한 팀원</legend><div className="toolbar-group">{members.map(m=><label key={m.id}><input type="checkbox" checked={participants.includes(m.id)} onChange={e=>setParticipants(p=>e.target.checked?[...p,m.id]:p.filter(id=>id!==m.id))}/>{m.name}</label>)}</div></fieldset>:null}<label className="label" htmlFor={`note-${sessionId}`}>나눈 이야기와 결정한 내용</label><textarea id={`note-${sessionId}`} className="textarea" rows={8} maxLength={16000} disabled={busy} value={note} onChange={e=>setNote(e.target.value)} placeholder="순서나 문장 형식에 얽매이지 않고 적어 주세요. 누가 제안했는지, 무엇을 결정했고 무엇이 남았는지 함께 적으면 좋습니다."/><p className="section-subtitle">원문을 먼저 저장하고 AI가 활동 날짜에 맞춰 정리합니다. 보완은 원문을 덮어쓰지 않고 별도로 남습니다.</p><div className="toolbar-group"><button className="button" disabled={busy||!note.trim()}>{busy?'원문 저장·AI 정리 중…':'저장하고 AI 정리'}</button>{parentId?<button type="button" className="button secondary" onClick={()=>setParentId(null)}>새 기록으로 전환</button>:null}</div></form>:null}
      {readOnly&&!feed.sources.some(s=>s.kind==='meeting')?<p className="empty-state">이 날짜의 대면 기록이 없습니다.</p>:null}
    </>:null}
    {tab === "summary" ? <><p className="notice-box">AI 초안입니다. 학생의 실제 수행·역량 판단은 원문과 관찰 내용을 함께 확인해 주세요. 대면 메모는 작성자가 기록한 내용이며 AI 답변은 별도로 표시합니다.</p>{feed.cycle?.status==="active"&&job&&job.requested_version>job.generated_version?<p role="status">{job.status==='failed'?'AI 정리에 실패해 재시도 대기 중입니다. 원문은 보존되어 있습니다.':job.status==='processing'?'AI가 정리 중입니다.':'새 기록의 정리 대기 중입니다. 원격 대화는 다음 날 자동 정리됩니다.'}</p>:null}{summary?<><small>정리 {time(summary.createdAt)} · 이력 {summary.version}</small>{summaryContent(summary)}</>:<p className="empty-state">아직 이 날짜의 AI 정리가 없습니다.</p>}</>:null}
    {tab === "flow" ? <><p className="section-subtitle">날짜별 논의와 다음 할 일을 시간순으로 연결합니다. 각 날짜에서 근거 원문을 확인할 수 있습니다.</p>{[...feed.history].reverse().map(h=><details className="discussion-note" key={h.id}><summary>{h.activityDate} · {h.items.find(i=>i.category==='discussion')?.text??'활동 정리'}</summary><div className="toolbar-group"><button className="button secondary" onClick={()=>{setDate(h.activityDate);setTab('summary');}}>이 날짜 정리와 근거 보기</button><button className="button secondary" onClick={()=>{setDate(h.activityDate);setTab('meeting');}}>대면 원문 보기</button></div><ul>{h.items.filter(i=>i.category==='decision'||i.category==='question'||i.category==='next').map((i,n)=><li key={n}><b>{labels[i.category]}:</b> {i.text}</li>)}</ul></details>)}{!feed.history.length?<p className="empty-state">날짜별 정리가 쌓이면 탐구 흐름이 나타납니다.</p>:null}</>:null}
    {source?<section className="discussion-evidence" role="region" aria-label="근거 원문"><div className="toolbar"><h3>{sourceLabels[source.kind]} 원문</h3><button className="button secondary" onClick={()=>setSource(null)}>닫기</button></div><p>{source.authorName} · 활동 {source.activityDate} · 입력 {time(source.createdAt)}</p><p style={{whiteSpace:'pre-wrap'}}>{source.content}</p>{source.kind==='meeting'||source.kind==='supplement'?<small>작성자 메모에 근거한 기록입니다.</small>:null}</section>:null}
  </section>;
}
