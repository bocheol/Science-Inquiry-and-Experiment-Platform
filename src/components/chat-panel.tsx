"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast-provider";
import type { InquiryData } from "@/lib/inquiry-data";

type RetryRequest = { fingerprint: string; id: string };
type ChatDraft = { interest: string; message: string; topicRequest: RetryRequest | null; messageRequest: RetryRequest | null };
function retryRequest(value: unknown): RetryRequest | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RetryRequest>;
  return typeof item.fingerprint === "string" && typeof item.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.id) ? { fingerprint: item.fingerprint, id: item.id } : null;
}

export function ChatPanel({ data, currentUserId, onRefresh }: { data: InquiryData; currentUserId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useToast();
  const [interest, setInterest] = useState(data.session.interestInput ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const draftKey = `inquiry-ai-chat:${currentUserId}:${data.session.id}:${data.session.cycle?.id ?? "uncategorized"}`;
  const draft = useRef<ChatDraft>({ interest: data.session.interestInput ?? "", message: "", topicRequest: null, messageRequest: null });
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [restored, setRestored] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const readOnly = !data.session.cycle || data.session.cycle.status !== "active";
  const locked = busy || data.session.aiBusy || readOnly || !restored;

  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === "object") draft.current = {
          interest: typeof saved.interest === "string" ? saved.interest : draft.current.interest,
          message: typeof saved.message === "string" ? saved.message : "",
          topicRequest: retryRequest(saved.topicRequest), messageRequest: retryRequest(saved.messageRequest),
        };
      }
    } catch { setStorageUnavailable(true); }
    setInterest(draft.current.interest); setMessage(draft.current.message); setRestored(true);
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [draftKey]);

  function updateDraft(patch: Partial<ChatDraft>) {
    draft.current = { ...draft.current, ...patch };
    setInterest(draft.current.interest); setMessage(draft.current.message);
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft.current)); }
    catch { setStorageUnavailable(true); }
  }

  async function post(path: string, body: object) {
    controller.current = new AbortController();
    let response: Response;
    try {
      response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.current.signal });
    } catch { throw new Error("연결을 확인한 뒤 다시 시도해 주세요. 작성 내용은 유지됩니다."); }
    const result = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
    if (!response.ok || result?.ok !== true) throw new Error(typeof result?.message === "string" ? result.message : "서버 응답을 확인하지 못했습니다. 작성 내용을 유지한 채 다시 시도해 주세요.");
  }

  function failure(cause: unknown) {
    if (!mounted.current) return;
    const text = cause instanceof Error ? cause.message : "처리하지 못했습니다. 작성 내용을 확인한 뒤 다시 시도해 주세요.";
    setError(text); showToast(text, "error");
  }

  async function refreshAfterSave() {
    try { await onRefresh(); }
    catch { if (mounted.current) setError("요청은 처리됐지만 목록을 새로 불러오지 못했습니다. 새로고침해 주세요."); }
  }

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [data.messages.length]);

  async function generateDirections() {
    if (locked) return;
    const normalizedInterest = interest.trim();
    const fingerprint = `${draftKey}\n${normalizedInterest}`;
    const request = draft.current.topicRequest?.fingerprint === fingerprint ? draft.current.topicRequest : { fingerprint, id: crypto.randomUUID() };
    updateDraft({ topicRequest: request });
    setBusy(true); setError("");
    try {
      await post("/api/inquiry/topic-suggestions", { sessionId: data.session.id, cycleId: data.session.cycle?.id, interest: normalizedInterest, requestId: request.id });
      if (!mounted.current) return;
      updateDraft({ topicRequest: null });
      showToast("탐구 방향 3개를 만들었습니다.");
      await refreshAfterSave();
    } catch (cause) { failure(cause); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function selectDirection(topic: string) {
    if (locked) return;
    setBusy(true); setError("");
    try {
      await post("/api/inquiry/topic-select", { sessionId: data.session.id, cycleId: data.session.cycle?.id, planId: data.plan.id, topic, expectedTopic: String(data.plan.formData.topic ?? "") });
      if (!mounted.current) return;
      showToast("탐구 방향이 설정되었습니다.");
      await refreshAfterSave();
    } catch (cause) { failure(cause); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim() || locked) return;
    const content = message.trim();
    const fingerprint = `${draftKey}\n${content}`;
    const request = draft.current.messageRequest?.fingerprint === fingerprint ? draft.current.messageRequest : { fingerprint, id: crypto.randomUUID() };
    updateDraft({ messageRequest: request });
    setBusy(true); setError("");
    try {
      await post("/api/inquiry/messages", { sessionId: data.session.id, cycleId: data.session.cycle?.id, content, requestId: request.id });
      if (!mounted.current) return;
      updateDraft({ messageRequest: null, ...(draft.current.message.trim() === content ? { message: "" } : {}) });
      showToast("질문을 보냈습니다.");
      await refreshAfterSave();
    } catch (cause) { failure(cause); }
    finally { if (mounted.current) setBusy(false); }
  }

  return (
    <div className="chat-layout">
      <div className="chat-main">
        <div className="chat-messages" aria-live="polite">
          {!data.messages.length ? <div className="empty-state"><div style={{ fontSize: 34 }}>💬</div><b>팀의 첫 질문을 시작해 보세요.</b><br />오른쪽에서 관심사를 적어 탐구 방향을 받을 수도 있습니다.</div> : null}
          {data.messages.map((item) => (
            <div className={`message-row ${item.role}`} key={item.id}>
              <div className="message-bubble">
                <span className="message-meta">{item.role === "assistant" ? "AI 연구 조력자" : item.senderName}</span>
                {item.content}
                {item.citations.length ? <div className="citation-list"><b>확인한 출처</b>{item.citations.map((citation) => <a key={citation.url} href={citation.url} target="_blank" rel="noreferrer">↗ {citation.title}</a>)}</div> : null}
              </div>
            </div>
          ))}
          {!readOnly && locked ? <div className="message-row assistant"><div className="message-bubble"><span className="message-meta">AI 연구 조력자</span>팀의 질문을 살펴보고 있어요…</div></div> : null}
          <div ref={bottomRef} />
        </div>
        <form className="chat-composer" onSubmit={send}>
          <input className="input" value={message} onChange={(event) => updateDraft({ message: event.target.value })} placeholder={readOnly ? "완료된 회차의 대화입니다" : locked ? "AI 답변이 끝나면 질문할 수 있어요" : "팀의 생각이나 질문을 입력하세요"} disabled={locked} />
          <button className="button" disabled={locked || !message.trim()}>보내기</button>
        </form>
        {error ? <div className="error-box" role="alert" style={{ margin: "0 16px 16px" }}>{error}</div> : null}
        {storageUnavailable ? <p className="notice-box">이 브라우저에서는 초안을 보관하지 못합니다. 화면을 닫기 전에 작성 내용을 복사해 주세요.</p> : null}
      </div>
      <aside className="chat-side">
        <h3>탐구 방향 찾기</h3>
        <p className="section-subtitle">궁금한 현상이나 관심 분야를 팀의 말로 적어 보세요.</p>
        <textarea className="textarea" value={interest} onChange={(event) => updateDraft({ interest: event.target.value })} disabled={readOnly || !restored} placeholder="예: 과일이 갈변하는 속도가 온도에 따라 달라지는지 궁금해요." />
        <button className="button full" onClick={generateDirections} disabled={locked || interest.trim().length < 2}>AI와 방향 3개 찾기</button>
        <div className="suggestion-list">
          {data.session.topicSuggestions.map((direction) => (
            <article className="suggestion-card" key={direction.title}>
              <h4>{direction.title}</h4>
              <p>{direction.reason}</p>
              <p><b>연결:</b> {direction.relation}</p>
              <p><b>연구 질문:</b> {direction.candidateQuestion}</p>
              {direction.safetyNote ? <p><b>안전:</b> {direction.safetyNote}</p> : null}
              <button className="button ghost full" onClick={() => selectDirection(direction.candidateQuestion)} disabled={locked}>이 방향 선택</button>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
