"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ReadOnlyFormFields } from "@/components/read-only-form-fields";
import type { InquiryData } from "@/lib/inquiry-data";
import { DocumentHistoryPanel } from "@/components/document-history-panel";
import { useToast } from "@/components/toast-provider";
import { useFormDraft } from "@/components/use-form-draft";
import { isReportFeedbackDraft, type ReportFeedbackDraft, type ReportReviewExpected } from "@/lib/report-review-state";

const statusText: Record<string, string> = { draft: "작성 중", submitted: "검토 대기", feedback: "수정 요청", reviewed: "확인 완료" };

export function TeacherReportReview({ data, currentUserId, readOnly = false }: { data: InquiryData; currentUserId: string; readOnly?: boolean }) {
  const identity = JSON.stringify([currentUserId, data.team.id, data.report.id, data.session.cycle?.id, data.report.configVersionId]);
  return <TeacherReportReviewContent key={identity} data={data} readOnly={readOnly} draftKey={`science:report-feedback:${identity}`} />;
}

function TeacherReportReviewContent({ data, readOnly, draftKey }: { data: InquiryData; readOnly: boolean; draftKey: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const expected = useMemo(() => ({
    cycleId: data.session.cycle?.id ?? "",
    version: data.report.reviewVersion,
    status: data.report.status,
    feedback: data.report.teacherFeedback ?? "",
  }) as ReportReviewExpected, [data.session.cycle?.id, data.report.reviewVersion, data.report.status, data.report.teacherFeedback]);
  const initial = useMemo(() => ({ feedback: expected.feedback, expected }), [expected]);
  const draft = useFormDraft<ReportFeedbackDraft | string>(draftKey, initial,
    (value): value is ReportFeedbackDraft | string => isReportFeedbackDraft(value) || (typeof value === "string" && value.length <= 10_000));
  const feedback = typeof draft.value === "string" ? draft.value : draft.value.feedback;
  const conflict = draft.pending && (typeof draft.value === "string" || JSON.stringify(draft.value.expected) !== JSON.stringify(expected));
  const { hydrate } = draft;
  useEffect(() => { hydrate(initial); }, [initial, hydrate]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const canReview = data.report.status === "submitted" || data.report.status === "reviewed" || data.report.status === "feedback";

  async function review(decision: "reviewed" | "feedback") {
    if (!draft.ready || conflict || busy) return;
    const sent = draft.capture();
    if (typeof sent.value === "string") return;
    setBusy(true); setError(""); setMessage("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
    const response = await fetch("/api/teacher/reports/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "review", reportId: data.report.id, decision, feedback: sent.value.feedback, expected: sent.value.expected }),
      signal: controller.signal,
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const text = result.message ?? "검토 결과를 저장하지 못했습니다.";
      setError(text); showToast(text, "error"); router.refresh(); return;
    }
    const success = decision === "reviewed" ? "보고서 확인을 완료했습니다." : "학생 팀에 수정 요청을 보냈습니다.";
    draft.acknowledge(sent, 0);
    setMessage(success); showToast(success);
    router.refresh();
    } catch {
      const text = "연결이 끊겼거나 응답이 늦습니다. 작성 내용은 보관되어 있습니다. 다시 시도해 주세요.";
      setError(text); showToast(text, "error");
    } finally { window.clearTimeout(timer); setBusy(false); }
  }

  async function restoreReport(revisionId: string) {
    const response = await fetch("/api/teacher/reports/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", reportId: data.report.id, revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(result.message ?? "보고서를 복원하지 못했습니다.");
    setMessage("선택한 보고서 상태로 복원했습니다. 학생이 다시 제출하면 검토해 주세요.");
    showToast("보고서를 선택한 이력으로 복원했습니다.");
    router.refresh();
  }

  return <section className="card card-body">
    <div className="toolbar"><div><h2 className="section-heading">팀 최종보고서</h2><p className="section-subtitle">학교 양식의 보고서 내용과 팀원별 역할을 확인합니다.</p></div><span className={`badge ${data.report.status === "feedback" ? "feedback" : data.report.status === "submitted" ? "pending" : ""}`}>{statusText[data.report.status] ?? data.report.status}</span></div>
    {error ? <div className="error-box">{error}</div> : null}
    {message ? <div className="notice-box">{message}</div> : null}
    {draft.warning ? <div className="warning-box">{draft.warning}</div> : null}
    {data.report.teacherFeedback ? <div className="warning-box"><b>현재 피드백</b><br />{data.report.teacherFeedback}</div> : null}
    <div className="report-read-cover">
      <div><span className="label">연구주제</span><h3>{String(data.report.formData.title ?? data.session.selectedTopic ?? "") || "미작성"}</h3></div>
      <div className="table-wrap"><table className="data-table report-role-table"><thead><tr><th>학번</th><th>이름</th><th>구분</th><th>팀원별 역할</th></tr></thead><tbody>{data.report.roles.map((role) => <tr key={role.userId}><td>{role.loginId}</td><td>{role.name}{!role.isActive ? " (팀에서 제거됨)" : ""}</td><td>{role.isLeader ? "팀장" : "팀원"}</td><td>{role.description || "미작성"}</td></tr>)}</tbody></table></div>
    </div>
    <ReadOnlyFormFields fields={data.report.fields.filter(field => field.id !== "title")} values={data.report.formData} />
    {readOnly ? <div className="notice-box">완료된 탐구 회차의 보고서입니다. 검토 상태와 이력은 변경할 수 없습니다.</div> : <><div className="field" style={{ marginTop: 20 }}><label htmlFor="report-feedback">교사 피드백</label><textarea id="report-feedback" className="textarea" value={feedback} disabled={!draft.ready} onChange={(event) => draft.change(previous => ({ feedback: event.target.value, expected: typeof previous === "string" ? { ...expected, cycleId: "legacy-unverified" } : previous.expected }))} placeholder="수정할 내용을 구체적으로 적어 주세요." maxLength={10_000} /></div>
    {conflict ? <div className="warning-box"><p>초안을 작성한 뒤 보고서 내용이나 검토 상태가 바뀌었습니다. 위의 최신 보고서와 현재 피드백을 확인해 주세요. 작성한 초안은 보관됩니다.</p><button className="button secondary" disabled={busy} onClick={() => draft.change({ feedback, expected })}>최신 보고서를 확인하고 초안 유지</button></div> : null}
    {draft.pending ? <p className="save-state">아직 보내지 않은 피드백입니다. 이 탭에 복구용 초안으로 보관됩니다.</p> : null}
    <div className="toolbar-group"><button className="button" disabled={!draft.ready || busy || conflict || !canReview || data.report.status === "feedback"} onClick={() => review("reviewed")}>확인 완료</button><button className="button danger" disabled={!draft.ready || busy || conflict || !canReview || !feedback.trim()} onClick={() => review("feedback")}>수정 요청</button>{!canReview ? <span className="save-state">학생이 제출한 뒤 검토할 수 있습니다.</span> : null}</div></>}
    <DocumentHistoryPanel scope={{ documentType: "report", documentId: data.report.id, cycleId: data.session.cycle!.id }} title="보고서" history={data.report.history} canRestore={!readOnly} onRestore={restoreReport} />
  </section>;
}
