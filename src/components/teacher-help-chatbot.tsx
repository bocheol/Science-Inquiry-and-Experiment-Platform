"use client";

import { useState } from "react";

type Message = { role: "teacher" | "guide"; content: string; sources?: string[] };

export function TeacherHelpChatbot() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "guide", content: "플랫폼 사용법을 물어보세요. 공식 기능 안내 범위에서만 답합니다." },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    const value = question.trim();
    if (!value || busy) return;
    setQuestion(""); setBusy(true); setError("");
    setMessages((current) => [...current, { role: "teacher", content: value }]);
    const response = await fetch("/api/teacher/help-chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: value }),
    });
    const result = (await response.json()) as { answer?: string; sources?: string[]; message?: string };
    setBusy(false);
    if (!response.ok || !result.answer) return setError(result.message ?? "안내를 불러오지 못했습니다.");
    setMessages((current) => [...current, { role: "guide", content: result.answer!, sources: result.sources }]);
  }

  return <section className="card card-body teacher-help-chat">
    <div><h2 className="section-heading">플랫폼 사용법 문의</h2><p className="section-subtitle">공식 사용법만 안내하는 읽기 전용 도우미입니다. 학생 개인정보·학번·비밀번호·학생 자료를 입력하지 마세요.</p></div>
    <div className="help-chat-log" aria-live="polite">
      {messages.map((message, index) => <div className={`help-chat-message ${message.role}`} key={index}>
        <strong>{message.role === "guide" ? "사용법 도우미" : "교사"}</strong>
        <p>{message.content}</p>
        {message.sources?.length ? <span>공식 안내: {message.sources.join(", ")}</span> : null}
      </div>)}
      {busy ? <div className="save-state">공식 안내에서 찾는 중…</div> : null}
    </div>
    {error ? <div className="error-box" role="alert">{error}</div> : null}
    <div className="help-chat-input"><input className="input" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void ask(); }} maxLength={500} placeholder="예: 승인한 계획서를 다시 수정하려면?" /><button className="button" disabled={busy || !question.trim()} onClick={() => void ask()}>질문</button></div>
  </section>;
}
