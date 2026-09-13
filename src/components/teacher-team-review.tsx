"use client";
import { TeacherMaterialReview } from "@/components/teacher-material-review";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PLAN_FIELDS } from "@/lib/constants";
import { TeacherJournalReview } from "@/components/teacher-journal-review";
import { TeacherReportReview } from "@/components/teacher-report-review";
import type { InquiryData } from "@/lib/inquiry-data";
import { DocumentHistoryPanel } from "@/components/document-history-panel";
import { useToast } from "@/components/toast-provider";
import { DiscussionPanel } from "@/components/discussion-panel";
import { PlanAiReviewPanel } from "@/components/plan-ai-review-panel";
import { TeacherCycleSettings } from "@/components/teacher-cycle-settings";
import { CycleAnalysisPanel } from "@/components/cycle-analysis-panel";
import { useFormDraft } from "@/components/use-form-draft";
import { appendPlanFeedback, isPlanFeedbackDraft, type PlanFeedbackDraft } from "@/lib/plan-feedback-draft";

const statusText: Record<string, string> = { draft: "작성 중", pending: "승인 대기", feedback: "수정 요청", approved: "승인됨", reapproval_required: "재승인 필요" };

export function TeacherTeamReview({ data, currentUserId }: { data: InquiryData; currentUserId: string }) {
  // Capturing an existing legacy submission must not discard a teacher's draft.
  const submissionKey = data.plan.latestSubmission?.source === "legacy_capture" ? "legacy" : data.plan.latestSubmission?.id ?? "legacy";
  const identity = JSON.stringify([currentUserId, data.team.id, data.plan.id, data.session.cycle?.id, submissionKey]);
  return <TeacherTeamReviewContent key={identity} data={data} currentUserId={currentUserId} draftKey={`science:plan-feedback:${identity}`} />;
}

function TeacherTeamReviewContent({ data, currentUserId, draftKey }: { data: InquiryData; currentUserId: string; draftKey: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const draft = useFormDraft<PlanFeedbackDraft>(draftKey, {
    feedback: data.plan.teacherFeedback ?? "", applied: [],
    expectedStatus: data.plan.reviewStatus, expectedFeedback: data.plan.teacherFeedback ?? "",
  }, isPlanFeedbackDraft);
  const { feedback } = draft.value;
  const sending = useRef(false);
  const { hydrate } = draft;
  useEffect(() => {
    hydrate({ feedback: data.plan.teacherFeedback ?? "", applied: [], expectedStatus: data.plan.reviewStatus, expectedFeedback: data.plan.teacherFeedback ?? "" });
  }, [hydrate, data.plan.teacherFeedback, data.plan.reviewStatus]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [changingApprovedPlan, setChangingApprovedPlan] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const cycleReadOnly = Boolean(data.session.cycle && data.session.cycle.status !== "active");
  const canReview = !cycleReadOnly && ["pending", "approved", "feedback"].includes(data.plan.reviewStatus);
  const feedbackChanged = draft.pending && (draft.value.expectedStatus !== data.plan.reviewStatus || draft.value.expectedFeedback !== (data.plan.teacherFeedback ?? ""));
  const confirmationText = `${data.team.clubId ? data.team.activityName : `${data.team.classNumber}반`} ${data.team.name}`;
  const reviewedFormData = data.plan.latestSubmissionSnapshot?.formData ?? data.plan.formData;
  const displayedPlanFields = data.plan.fields.some((field) => field.kind !== "heading")
    ? data.plan.fields.filter((field) => field.kind !== "heading").map((field) => ({ key: field.id, label: field.label }))
    : PLAN_FIELDS;

  async function review(decision: "approved" | "feedback") {
    if (sending.current || !draft.ready || !canReview || feedbackChanged) return;
    sending.current = true;
    setBusy(true); setError(""); setMessage("");
    const sent = draft.capture();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
    const response = await fetch("/api/teacher/plans/review", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ action: "review", planId: data.plan.id, decision, feedback: sent.value.feedback, confirmation,
        expected: { submissionId: data.plan.latestSubmission?.id ?? null, cycleId: data.session.cycle?.id ?? null,
          status: sent.value.expectedStatus, feedback: sent.value.expectedFeedback } }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      throw new Error(result.message ?? "검토 결과를 저장하지 못했습니다.");
    }
    draft.acknowledge(sent, 0);
    const success = decision === "approved" ? "계획서를 승인했습니다." : "학생 팀에 수정 요청을 보냈습니다.";
    setMessage(success); showToast(success);
    setChangingApprovedPlan(false);
    setConfirmation("");
    router.refresh();
    } catch (caught) {
      const text = caught instanceof TypeError || (caught instanceof Error && caught.name === "AbortError")
        ? "연결이 끊겼거나 응답이 늦습니다. 작성한 피드백은 유지됩니다. 최신 제출 상태를 확인한 뒤 다시 보내 주세요."
        : caught instanceof Error ? caught.message : "검토 결과를 저장하지 못했습니다.";
      setError(text); showToast(text, "error");
    } finally { window.clearTimeout(timer); sending.current = false; setBusy(false); }
  }

  function applyFeedback(id: string, text: string) {
    if (!draft.ready || busy || !canReview || feedbackChanged) return;
    try {
      draft.change((previous) => appendPlanFeedback(previous, id, text));
      if (data.plan.reviewStatus === "approved") setChangingApprovedPlan(true);
      setMessage("수정 요청 메시지에 추가했습니다. 내용을 검토한 뒤 보내 주세요.");
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "피드백을 추가하지 못했습니다."); }
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

  return (
    <div className="stack">
      <section className="team-banner">
        <div><h1>{data.team.activityName ?? `${data.team.classNumber}반`} · {data.team.name}</h1><p>{data.session.selectedTopic || "탐구 주제 미확정"}</p>{data.session.cycle ? <small>{data.session.cycle.origin === "legacy_unclassified" ? "기존 탐구 자료" : data.session.cycle.title}</small> : null}</div>
        <div className="member-list">{data.members.map((member) => <span className="member-pill" key={member.id}>{member.isLeader ? "⭐ " : ""}{member.name} ({member.loginId})</span>)}</div>
      </section>
      {error ? <div className="error-box">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}
      {data.session.cycle?.status === "active" ? <TeacherCycleSettings cycle={data.session.cycle} /> : null}
      <CycleAnalysisPanel data={data} audience="teacher" currentUserId={currentUserId} />
      <section className="card card-body"><DiscussionPanel key={data.session.cycle?.id} sessionId={data.session.id} cycleId={data.session.cycle?.id} currentUserId={currentUserId} members={data.members} readOnly canSummarize /></section>
      <section className="grid two">
        <article className="card card-body">
          <div className="toolbar"><h2 className="section-heading">탐구 계획서</h2><span className={`badge ${data.plan.reviewStatus}`}>{statusText[data.plan.reviewStatus]}</span></div>
          {data.plan.latestSubmission ? <p className="notice-box">제출본 {data.plan.latestSubmission.submissionNumber}번을 고정해 표시하고 있습니다. 학생이 이후 작성 중인 내용과 섞이지 않습니다.</p> : null}
          {displayedPlanFields.map((field) => {
            const value = reviewedFormData[field.key];
            return <div className="plan-field" key={field.key}><div className="label">{field.label}</div>{Array.isArray(value) ? <div className="table-wrap"><table className="data-table"><tbody>{value.map((row, index) => <tr key={index}>{Object.values(row as Record<string, unknown>).map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div> : <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{String(value ?? "") || <span style={{ color: "var(--muted)" }}>미작성</span>}</div>}</div>;
          })}
          {!cycleReadOnly ? <PlanAiReviewPanel
            data={data}
            audience="teacher"
            disabled={!canReview || busy}
            onRefresh={() => router.refresh()}
            onApplyFeedback={applyFeedback}
            appliedFeedback={draft.value.applied}
            feedbackDisabled={busy || !draft.ready || feedbackChanged}
          /> : <div className="notice-box">완료된 탐구 회차의 계획서입니다. 승인 상태와 이력은 변경할 수 없습니다.</div>}
          {!cycleReadOnly && (data.plan.reviewStatus === "approved" && !changingApprovedPlan ? (
            <div className="approval-complete-panel">
              <div><strong>승인 완료</strong><p>학생의 실험 일지가 열려 있습니다. 승인 상태를 바꿀 때만 아래 버튼을 사용하세요.</p></div>
              <button className="button ghost" disabled={busy} onClick={() => { setChangingApprovedPlan(true); setError(""); setMessage(""); }}>승인 상태 변경</button>
            </div>
          ) : (
            <>
              <div className="field" style={{ marginTop: 18 }}><label htmlFor="feedback">교사 피드백 · 수정 요청 메시지</label><textarea id="feedback" className="textarea" value={feedback} disabled={busy || !draft.ready} maxLength={4000} onChange={(event) => draft.change((previous) => ({ ...previous, feedback: event.target.value }))} placeholder="수정이 필요한 이유와 확인할 내용을 구체적으로 적어 주세요." />
                <small>{feedback.length.toLocaleString()} / 4,000자 · AI 항목을 반영해도 아직 학생에게 전송되지 않습니다.</small>
                {draft.pending ? <small>작성 중인 초안을 이 브라우저 탭에 보관했습니다.</small> : null}
                {draft.warning ? <p className="warning-box">{draft.warning}</p> : null}
                {feedbackChanged ? <div className="warning-box">검토 상태나 다른 교사의 피드백이 변경되었습니다. 현재 초안은 유지했습니다. 최신 내용과 비교해 주세요.
                  <p style={{ whiteSpace: "pre-wrap" }}>현재 저장된 피드백: {data.plan.teacherFeedback || "없음"}</p>
                  <button type="button" className="button secondary" onClick={() => draft.change((previous) => ({ ...previous, expectedStatus: data.plan.reviewStatus, expectedFeedback: data.plan.teacherFeedback ?? "" }))}>최신 내용 확인 후 내 초안 유지</button>
                </div> : null}
              </div>
              {data.plan.reviewStatus === "approved" ? (
                <div className="approval-change-guard">
                  <strong>승인을 취소하고 수정 요청으로 바꾸시겠습니까?</strong>
                  <p>승인 기록이 수정 요청 상태로 바뀝니다. 계속하려면 아래에 <b>{confirmationText}</b>을(를) 정확히 입력하세요.</p>
                  <label className="label" htmlFor="approval-confirmation">확인 문구</label>
                  <input id="approval-confirmation" className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={confirmationText} autoComplete="off" />
                  <div className="toolbar-group">
                    <button className="button danger" disabled={busy || !draft.ready || feedbackChanged || confirmation.trim() !== confirmationText || !feedback.trim()} onClick={() => review("feedback")}>수정 요청으로 변경</button>
                    <button className="button secondary" disabled={busy} onClick={() => { setChangingApprovedPlan(false); setConfirmation(""); setError(""); }}>취소</button>
                  </div>
                </div>
              ) : (
                <div className="toolbar-group"><button className="button" disabled={busy || !draft.ready || !canReview || data.plan.reviewStatus === "feedback" || feedbackChanged} onClick={() => review("approved")}>계획서 승인</button><button className="button danger" disabled={busy || !draft.ready || !canReview || feedbackChanged || !feedback.trim()} onClick={() => review("feedback")}>수정 요청 보내기</button></div>
              )}
            </>
          ))}
          <DocumentHistoryPanel title="계획서" history={data.plan.history} canRestore={!cycleReadOnly} onRestore={restorePlan} />
        </article>
        <div className="stack">
          <article className="card card-body">
            <h2 className="section-heading">팀 AI 대화</h2>
            <p className="section-subtitle">누가 질문했는지 교사에게만 실제 이름으로 표시됩니다.</p>
            <div style={{ maxHeight: 520, overflowY: "auto" }}>{data.messages.map((item) => <div className={`message-row ${item.role}`} key={item.id}><div className="message-bubble"><span className="message-meta">{item.role === "assistant" ? "AI 연구 조력자" : item.senderName}</span>{item.content}</div></div>)}{!data.messages.length ? <div className="empty-state">아직 대화가 없습니다.</div> : null}</div>
          </article>
          <TeacherMaterialReview latest={data.materials} pending={data.pendingMaterials} readOnly={cycleReadOnly} />
        </div>
      </section>
      <TeacherReportReview data={data} currentUserId={currentUserId} readOnly={cycleReadOnly} />
      <TeacherJournalReview teamId={data.team.id} />
    </div>
  );
}
