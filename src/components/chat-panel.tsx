"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast-provider";
import type { InquiryData } from "@/lib/inquiry-data";

export function ChatPanel({ data, onRefresh }: { data: InquiryData; onRefresh: () => Promise<void> }) {
  const { showToast } = useToast();
  const [interest, setInterest] = useState(data.session.interestInput ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const locked = busy || data.session.aiBusy;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [data.messages.length]);

  async function generateDirections() {
    setBusy(true); setError("");
    const response = await fetch("/api/inquiry/topic-suggestions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: data.session.id, interest }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "탐구 방향을 만들지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    showToast("탐구 방향 3개를 만들었습니다.");
    await onRefresh();
  }

  async function selectDirection(topic: string) {
    setBusy(true); setError("");
    const response = await fetch("/api/inquiry/topic-select", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: data.session.id, planId: data.plan.id, topic }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "주제를 선택하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    showToast("탐구 방향이 설정되었습니다.");
    await onRefresh();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!message.trim() || locked) return;
    const content = message.trim();
    setMessage(""); setBusy(true); setError("");
    const response = await fetch("/api/inquiry/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: data.session.id, content }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "질문을 보내지 못했습니다.";
      setMessage(content); setError(text); showToast(text, "error"); return;
    }
    showToast("질문을 보냈습니다.");
    await onRefresh();
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
          {locked ? <div className="message-row assistant"><div className="message-bubble"><span className="message-meta">AI 연구 조력자</span>팀의 질문을 살펴보고 있어요…</div></div> : null}
          <div ref={bottomRef} />
        </div>
        <form className="chat-composer" onSubmit={send}>
          <input className="input" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={locked ? "AI 답변이 끝나면 질문할 수 있어요" : "팀의 생각이나 질문을 입력하세요"} disabled={locked} />
          <button className="button" disabled={locked || !message.trim()}>보내기</button>
        </form>
        {error ? <div className="error-box" style={{ margin: "0 16px 16px" }}>{error}</div> : null}
      </div>
      <aside className="chat-side">
        <h3>탐구 방향 찾기</h3>
        <p className="section-subtitle">궁금한 현상이나 관심 분야를 팀의 말로 적어 보세요.</p>
        <textarea className="textarea" value={interest} onChange={(event) => setInterest(event.target.value)} placeholder="예: 과일이 갈변하는 속도가 온도에 따라 달라지는지 궁금해요." />
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
