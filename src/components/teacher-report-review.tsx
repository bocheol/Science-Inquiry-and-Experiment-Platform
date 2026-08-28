"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REPORT_FIELDS } from "@/lib/constants";
import type { InquiryData } from "@/lib/inquiry-data";
import { DocumentHistoryPanel } from "@/components/document-history-panel";

const statusText: Record<string, string> = { draft: "작성 중", submitted: "검토 대기", feedback: "수정 요청", reviewed: "확인 완료" };

export function TeacherReportReview({ data }: { data: InquiryData }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState(data.report.teacherFeedback ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const canReview = data.report.status === "submitted" || data.report.status === "reviewed";

  async function review(decision: "reviewed" | "feedback") {
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/reports/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "review", reportId: data.report.id, decision, feedback }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) return setError(result.message ?? "검토 결과를 저장하지 못했습니다.");
    setMessage(decision === "reviewed" ? "보고서 확인을 완료했습니다." : "학생 팀에 수정 요청을 보냈습니다.");
    router.refresh();
  }

  async function restoreReport(revisionId: string) {
    const response = await fetch("/api/teacher/reports/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", reportId: data.report.id, revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(result.message ?? "보고서를 복원하지 못했습니다.");
    setMessage("선택한 보고서 상태로 복원했습니다. 학생이 다시 제출하면 검토해 주세요.");
    router.refresh();
  }

  return <section className="card card-body">
    <div className="toolbar"><div><h2 className="section-heading">팀 최종보고서</h2><p className="section-subtitle">학교 양식의 보고서 내용과 팀원별 역할을 확인합니다.</p></div><span className={`badge ${data.report.status === "feedback" ? "feedback" : data.report.status === "submitted" ? "pending" : ""}`}>{statusText[data.report.status] ?? data.report.status}</span></div>
    {error ? <div className="error-box">{error}</div> : null}
    {message ? <div className="notice-box">{message}</div> : null}
    {data.report.teacherFeedback ? <div className="warning-box"><b>현재 피드백</b><br />{data.report.teacherFeedback}</div> : null}
    <div className="report-read-cover">
      <div><span className="label">연구주제</span><h3>{String(data.report.formData.title ?? data.session.selectedTopic ?? "") || "미작성"}</h3></div>
      <div className="table-wrap"><table className="data-table report-role-table"><thead><tr><th>학번</th><th>이름</th><th>구분</th><th>팀원별 역할</th></tr></thead><tbody>{data.report.roles.map((role) => <tr key={role.userId}><td>{role.loginId}</td><td>{role.name}{!role.isActive ? " (팀에서 제거됨)" : ""}</td><td>{role.isLeader ? "팀장" : "팀원"}</td><td>{role.description || "미작성"}</td></tr>)}</tbody></table></div>
    </div>
    {REPORT_FIELDS.map((field) => <div className="plan-field" key={field.key}><div className="label">{field.label}</div><div className="report-read-value">{String(data.report.formData[field.key] ?? "") || <span>미작성</span>}</div></div>)}
    <div className="field" style={{ marginTop: 20 }}><label htmlFor="report-feedback">교사 피드백</label><textarea id="report-feedback" className="textarea" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="수정할 내용을 구체적으로 적어 주세요." maxLength={10_000} /></div>
    <div className="toolbar-group"><button className="button" disabled={busy || !canReview} onClick={() => review("reviewed")}>확인 완료</button><button className="button danger" disabled={busy || !canReview || !feedback.trim()} onClick={() => review("feedback")}>수정 요청</button>{!canReview ? <span className="save-state">학생이 제출한 뒤 검토할 수 있습니다.</span> : null}</div>
    <DocumentHistoryPanel title="보고서" history={data.report.history} canRestore onRestore={restoreReport} />
  </section>;
}
