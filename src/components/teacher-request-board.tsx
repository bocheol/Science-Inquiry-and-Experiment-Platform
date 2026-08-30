"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/toast-provider";
import type { TeacherRequest, TeacherRequestCategory, TeacherRequestStatus } from "@/lib/teacher-requests";

const categoryLabels: Record<TeacherRequestCategory, string> = {
  feature: "기능 건의",
  bug: "오류 문의",
  question: "사용 문의",
  other: "기타",
};

const statusLabels: Record<TeacherRequestStatus, string> = {
  received: "접수",
  reviewing: "검토 중",
  planned: "반영 예정",
  resolved: "처리 완료",
};

function seoulDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function TeacherRequestBoard() {
  const { showToast } = useToast();
  const [requests, setRequests] = useState<TeacherRequest[]>([]);
  const [category, setCategory] = useState<TeacherRequestCategory>("feature");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/teacher/requests", { cache: "no-store" });
    const result = (await response.json()) as { requests?: TeacherRequest[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "건의·문의 내역을 불러오지 못했습니다.");
    setRequests(result.requests ?? []);
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "건의·문의 내역을 불러오지 못했습니다.";
      setError(message);
      showToast(message, "error");
    });
  }, [refresh, showToast]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const response = await fetch("/api/teacher/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, title, content }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "건의·문의를 등록하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    setTitle(""); setContent("");
    showToast("제작자에게 건의·문의를 등록했습니다.");
    await refresh();
  }

  async function changeStatus(requestId: string, status: TeacherRequestStatus) {
    setBusy(true); setError("");
    const response = await fetch("/api/teacher/requests", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, status }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "처리 상태를 변경하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    showToast("건의·문의 처리 상태를 변경했습니다.");
    await refresh();
  }

  return (
    <section className="card card-body teacher-request-board no-print">
      <div className="toolbar">
        <div>
          <h2 className="section-heading">제작자에게 기능 건의 및 문의</h2>
          <p className="section-subtitle">교사 공동 게시판입니다. 등록 내용은 플랫폼 내부에만 저장됩니다.</p>
        </div>
        <span className="badge">교사 전체 공유</span>
      </div>
      <div className="warning-box"><b>개인정보 보호:</b> 학생 이름·학번·비밀번호·일지나 보고서 원문을 입력하지 마세요. 서버에서도 해당 정보로 보이는 입력을 차단합니다.</div>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      <form className="teacher-request-form" onSubmit={submit}>
        <label className="field"><span>분류</span><select className="select" value={category} onChange={(event) => setCategory(event.target.value as TeacherRequestCategory)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>제목</span><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={100} required /></label>
        <label className="field teacher-request-content"><span>내용</span><textarea className="textarea" value={content} onChange={(event) => setContent(event.target.value)} minLength={5} maxLength={3000} required placeholder="재현 방법이나 필요한 기능을 학생 식별정보 없이 적어 주세요." /></label>
        <button className="button" disabled={busy || title.trim().length < 2 || content.trim().length < 5}>{busy ? "처리 중…" : "등록"}</button>
      </form>
      <div className="teacher-request-list">
        {requests.map((item) => (
          <article className="teacher-request-card" key={item.id}>
            <div className="toolbar">
              <div><span className="badge">{categoryLabels[item.category]}</span><h3>{item.title}</h3></div>
              <select className="select" aria-label={`${item.title} 처리 상태`} value={item.status} disabled={busy} onChange={(event) => changeStatus(item.id, event.target.value as TeacherRequestStatus)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            </div>
            <p>{item.content}</p>
            <small>{item.authorName} 교사 · {seoulDate(item.createdAt)}</small>
          </article>
        ))}
        {!requests.length ? <p className="empty-state">등록된 건의·문의가 없습니다.</p> : null}
      </div>
    </section>
  );
}
