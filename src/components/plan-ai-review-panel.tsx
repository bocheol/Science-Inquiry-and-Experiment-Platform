"use client";

import { useState } from "react";
import type { InquiryData } from "@/lib/inquiry-data";
import { useToast } from "@/components/toast-provider";
import { planCheckFeedback } from "@/lib/plan-feedback-draft";

const readinessLabel = {
  needs_revision: "보완이 필요해요",
  ready_for_submission: "제출 전 최종 확인 단계예요",
  teacher_attention: "선생님과 확인할 점이 있어요",
};

const categoryLabel = {
  missing: "빠진 내용",
  contradiction: "서로 맞지 않는 내용",
  feasibility: "실행 가능성",
  safety: "안전",
  evidence: "근거",
};

function submissionTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "시각 확인 필요";
  // Stable across server/browser ICU versions and device time zones.
  return `${new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")} (한국 시간)`;
}

export function PlanAiReviewPanel({
  data,
  audience,
  disabled = false,
  onRefresh,
  onApplyFeedback,
  appliedFeedback = [],
  feedbackDisabled = false,
}: {
  data: InquiryData;
  audience: "student" | "teacher";
  disabled?: boolean;
  onRefresh: () => Promise<void> | void;
  onApplyFeedback?: (id: string, text: string) => void;
  appliedFeedback?: string[];
  feedbackDisabled?: boolean;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const review = audience === "student" ? data.plan.studentAiReview : data.plan.teacherAiReview;
  const labels = new Map(data.plan.fields.map((field) => [field.id, field.label]));
  const submission = data.plan.latestSubmission;
  const isStale = audience === "student"
    ? Boolean(review && "isCurrent" in review && !review.isCurrent)
    : Boolean(review && (!submission || review.snapshotId !== submission.snapshotId || submission.reviewStatus === "withdrawn"));

  async function requestReview() {
    setBusy(true);
    setError("");
    const endpoint = audience === "student" ? "/api/inquiry/plan-ai-review" : "/api/teacher/plans/ai-review";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: data.plan.id }),
      });
      const result = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "AI 검토를 완료하지 못했습니다.");
      showToast(audience === "student" ? "임시 저장된 계획서를 AI와 점검했습니다." : "고정된 제출본을 AI와 점검했습니다.");
      await onRefresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI 검토를 완료하지 못했습니다.";
      setError(message);
      showToast(message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="plan-ai-review" aria-label={audience === "student" ? "학생 계획서 AI 점검" : "교사 계획서 AI 검토 보조"}>
      <div className="toolbar">
        <div>
          <h3 className="section-heading">{audience === "student" ? "AI와 계획서 점검" : "AI 검토 보조"}</h3>
          <p className="section-subtitle">
            {audience === "student"
              ? "AI가 임시 저장된 내용에서 빠진 점과 확인 질문을 찾습니다. 문장은 팀이 직접 고칩니다."
              : "AI는 고정된 제출본의 확인 항목을 정리합니다. 승인과 피드백은 선생님이 결정합니다."}
          </p>
        </div>
      </div>
      {audience === "teacher" && submission ? (
        <p className="notice-box">
          {submission.source === "legacy_capture" ? "기존 제출 이력을 재구성하지 않고, AI 검토를 시작한 시점의 저장본을 고정했습니다." : `제출본 ${submission.submissionNumber}번`}
          {` · ${submissionTime(submission.submittedAt)}`}
        </p>
      ) : null}
      {isStale ? <p className="warning-box">{audience === "teacher" ? "이 AI 검토는 현재 검토할 제출본과 다릅니다. 최신 제출본을 다시 검토해 주세요." : "AI 점검 뒤 계획서가 바뀌었습니다. 현재 임시 저장본으로 다시 점검할 수 있습니다."}</p> : null}
      {error ? <p className="error-box">{error}</p> : null}
      <button className="button secondary full" disabled={busy || disabled} onClick={() => void requestReview()}>
        {busy ? "AI가 점검 중…" : review && !isStale ? "같은 저장본 점검 결과 보기" : audience === "student" ? "임시 저장본 AI 점검" : "제출본 AI 검토"}
      </button>
      {disabled ? <p className="section-subtitle">{audience === "student" ? "작성 중인 내용을 먼저 임시 저장해 주세요." : "학생이 계획서를 제출하면 사용할 수 있습니다."}</p> : null}
      {review ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className="notice-box"><b>{readinessLabel[review.result.readiness]}</b><br />{review.result.summary}</div>
          {review.result.strengths.length ? <div><b>잘된 점</b><ul>{review.result.strengths.map((item, index) => <li key={index}>{item.feedback}{item.fieldKeys.length ? <small> · {item.fieldKeys.map((key) => labels.get(key) ?? key).join(", ")}</small> : null}</li>)}</ul></div> : null}
          {review.result.checks.length ? <div><b>확인할 점</b><div className="stack">{review.result.checks.map((item, index) => (
            <article className={item.priority === "required" ? "warning-box" : "notice-box"} key={index}>
              <strong>{categoryLabel[item.category]} · {item.priority === "required" ? "꼭 확인" : "보완 권장"}</strong>
              <p>{item.observation}</p>
              <p><b>생각해 볼 질문:</b> {item.question}</p>
              <p><b>개선 방향:</b> {item.suggestion}</p>
              {item.fieldKeys.length ? <small>{item.fieldKeys.map((key) => labels.get(key) ?? key).join(" · ")}</small> : null}
              {audience === "teacher" && onApplyFeedback ? <div style={{ marginTop: 10 }}>
                <button type="button" className="button secondary"
                  disabled={disabled || feedbackDisabled || isStale || appliedFeedback.includes(`${review.id}:check:${index}`)}
                  onClick={() => onApplyFeedback(`${review.id}:check:${index}`, planCheckFeedback(item, labels))}>
                  {appliedFeedback.includes(`${review.id}:check:${index}`) ? "피드백에 반영됨" : "피드백에 반영"}
                </button>
              </div> : null}
            </article>
          ))}</div></div> : null}
          {review.result.limitations.length ? <div><b>AI가 판단할 수 없는 점</b><ul>{review.result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
        </div>
      ) : null}
    </section>
  );
}
