"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLAN_FIELDS } from "@/lib/constants";
import { TeacherJournalReview } from "@/components/teacher-journal-review";
import { TeacherReportReview } from "@/components/teacher-report-review";
import type { InquiryData } from "@/lib/inquiry-data";
import { DocumentHistoryPanel } from "@/components/document-history-panel";
import { useToast } from "@/components/toast-provider";

const statusText: Record<string, string> = { draft: "작성 중", pending: "승인 대기", feedback: "수정 요청", approved: "승인됨", reapproval_required: "재승인 필요" };

export function TeacherTeamReview({ data }: { data: InquiryData }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [feedback, setFeedback] = useState(data.plan.teacherFeedback ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [changingApprovedPlan, setChangingApprovedPlan] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const confirmationText = `${data.team.classNumber}반 ${data.team.name}`;

  async function review(decision: "approved" | "feedback") {
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/plans/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "review", planId: data.plan.id, decision, feedback, confirmation }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "검토 결과를 저장하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    const success = decision === "approved" ? "계획서를 승인했습니다." : "학생 팀에 수정 요청을 보냈습니다.";
    setMessage(success); showToast(success);
    setChangingApprovedPlan(false);
    setConfirmation("");
    router.refresh();
  }

  async function restorePlan(revisionId: string) {
    const response = await fetch("/api/teacher/plans/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", planId: data.plan.id, revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(result.message ?? "계획서를 복원하지 못했습니다.");
    setMessage("선택한 계획서 상태로 복원했습니다. 학생이 다시 제출하면 승인해 주세요.");
    showToast("계획서를 선택한 이력으로 복원했습니다.");
    router.refresh();
  }

  async function retryMaterials() {
    if (!data.materials) return;
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/teacher/materials/retry", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: data.materials.id }),
    });
    const result = (await response.json()) as { message?: string; syncStatus?: string };
    setBusy(false);
    if (!response.ok) {
      const text = result.message ?? "재전송하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    const success = result.syncStatus === "synced" ? "Google Sheet에 반영했습니다." : "신청은 보존되어 있으며 시트 연결을 기다리고 있습니다.";
    setMessage(success); showToast(success);
    router.refresh();
  }

  return (
    <div className="stack">
      <section className="team-banner">
        <div><h1>{data.team.classNumber}반 {data.team.name}</h1><p>{data.session.selectedTopic || "탐구 주제 미확정"}</p></div>
        <div className="member-list">{data.members.map((member) => <span className="member-pill" key={member.id}>{member.isLeader ? "⭐ " : ""}{member.name} ({member.loginId})</span>)}</div>
      </section>
      {error ? <div className="error-box">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}
      <section className="grid two">
        <article className="card card-body">
          <div className="toolbar"><h2 className="section-heading">탐구 계획서</h2><span className={`badge ${data.plan.reviewStatus}`}>{statusText[data.plan.reviewStatus]}</span></div>
          {PLAN_FIELDS.map((field) => {
            const value = data.plan.formData[field.key];
            return <div className="plan-field" key={field.key}><div className="label">{field.label}</div>{Array.isArray(value) ? <div className="table-wrap"><table className="data-table"><tbody>{value.map((row, index) => <tr key={index}>{Object.values(row as Record<string, unknown>).map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div> : <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{String(value ?? "") || <span style={{ color: "var(--muted)" }}>미작성</span>}</div>}</div>;
          })}
          {data.plan.reviewStatus === "approved" && !changingApprovedPlan ? (
            <div className="approval-complete-panel">
              <div><strong>승인 완료</strong><p>학생의 실험 일지가 열려 있습니다. 승인 상태를 바꿀 때만 아래 버튼을 사용하세요.</p></div>
              <button className="button ghost" disabled={busy} onClick={() => { setChangingApprovedPlan(true); setError(""); setMessage(""); }}>승인 상태 변경</button>
            </div>
          ) : (
            <>
              <div className="field" style={{ marginTop: 18 }}><label htmlFor="feedback">교사 피드백</label><textarea id="feedback" className="textarea" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="수정이 필요한 이유와 확인할 내용을 구체적으로 적어 주세요." /></div>
              {data.plan.reviewStatus === "approved" ? (
                <div className="approval-change-guard">
                  <strong>승인을 취소하고 수정 요청으로 바꾸시겠습니까?</strong>
                  <p>승인 기록이 수정 요청 상태로 바뀝니다. 계속하려면 아래에 <b>{confirmationText}</b>을(를) 정확히 입력하세요.</p>
                  <label className="label" htmlFor="approval-confirmation">확인 문구</label>
                  <input id="approval-confirmation" className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={confirmationText} autoComplete="off" />
                  <div className="toolbar-group">
                    <button className="button danger" disabled={busy || confirmation.trim() !== confirmationText || !feedback.trim()} onClick={() => review("feedback")}>수정 요청으로 변경</button>
                    <button className="button secondary" disabled={busy} onClick={() => { setChangingApprovedPlan(false); setConfirmation(""); setError(""); }}>취소</button>
                  </div>
                </div>
              ) : (
                <div className="toolbar-group"><button className="button" disabled={busy} onClick={() => review("approved")}>계획서 승인</button><button className="button danger" disabled={busy || !feedback.trim()} onClick={() => review("feedback")}>수정 요청</button></div>
              )}
            </>
          )}
          <DocumentHistoryPanel title="계획서" history={data.plan.history} canRestore onRestore={restorePlan} />
        </article>
        <div className="stack">
          <article className="card card-body">
            <h2 className="section-heading">팀 AI 대화</h2>
            <p className="section-subtitle">누가 질문했는지 교사에게만 실제 이름으로 표시됩니다.</p>
            <div style={{ maxHeight: 520, overflowY: "auto" }}>{data.messages.map((item) => <div className={`message-row ${item.role}`} key={item.id}><div className="message-bubble"><span className="message-meta">{item.role === "assistant" ? "AI 연구 조력자" : item.senderName}</span>{item.content}</div></div>)}{!data.messages.length ? <div className="empty-state">아직 대화가 없습니다.</div> : null}</div>
          </article>
          <article className="card card-body">
            <div className="toolbar"><h2 className="section-heading">준비물 신청</h2>{data.materials ? <span className={`badge ${data.materials.syncStatus === "failed" ? "feedback" : ""}`}>{data.materials.syncStatus === "synced" ? "시트 반영" : data.materials.syncStatus === "failed" ? "전송 실패" : "전송 대기"}</span> : null}</div>
            {data.materials ? <><p>합계 <b>{data.materials.totalAmount.toLocaleString()}원</b> {data.materials.budgetStatus === "over_budget" ? <span className="badge pending">예산 초과</span> : null}</p><ul>{data.materials.items.map((item, index) => <li key={index}>{item.name} · {item.quantity}개 · {(item.unitPrice * item.quantity + item.shipping).toLocaleString()}원</li>)}</ul>{data.materials.syncError ? <div className="warning-box">{data.materials.syncError}</div> : null}<button className="button ghost" onClick={retryMaterials} disabled={busy || data.materials.syncStatus === "synced"}>Google Sheet 재전송</button></> : <div className="empty-state">신청 내용이 없습니다.</div>}
          </article>
        </div>
      </section>
      <TeacherReportReview data={data} />
      <TeacherJournalReview teamId={data.team.id} />
    </div>
  );
}
