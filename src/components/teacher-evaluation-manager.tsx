"use client";

import { useEffect, useMemo, useState } from "react";
import type { EvaluationItem, EvaluationManagementData } from "@/lib/evaluation-service";
import { useToast } from "@/components/toast-provider";
import { FormConflict } from "@/components/form-conflict";
import { FormSaveError, saveForm, useFormDraft } from "@/components/use-form-draft";

const statusLabels: Record<string, string> = {
  draft: "설정 중",
  open: "학생 입력 중",
  closed: "입력 마감",
  reviewing: "교사 검토 중",
  published: "결과 공개 완료",
};

const flagLabels: Record<string, string> = {
  uniform_levels: "모든 문항 같은 단계",
  extreme_pattern: "극단값 반복",
  duplicate_comment: "다른 팀원과 동일한 의견",
  suspect_language: "부적절 표현 의심",
};

type SelectedEvaluation = NonNullable<EvaluationManagementData["selected"]>;
type ManagedPeerEvaluation = SelectedEvaluation["peerEvaluations"][number];
type ManagedStudent = SelectedEvaluation["progress"][number];
type TextDraft = { text: string };
const validTextDraft = (value: unknown): value is TextDraft => Boolean(value && typeof value === "object" && typeof (value as TextDraft).text === "string");

function hasUnsavedTeacherDraft(currentUserId: string, roundId: string) {
  const prefix = `science-teacher-evaluation:${currentUserId}:${roundId}:`;
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      if (sessionStorage.key(index)?.startsWith(prefix)) return true;
    }
  } catch { /* Editors show their own warning when recovery storage is unavailable. */ }
  return false;
}

function CommentDecisionEditor({ currentUserId, roundId, roundStatus, evaluation, onSaved }: {
  currentUserId: string;
  roundId: string;
  roundStatus: SelectedEvaluation["status"];
  evaluation: ManagedPeerEvaluation;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const initial = { text: evaluation.redactedPublicComment || evaluation.publicComment };
  const draft = useFormDraft<TextDraft>(`science-teacher-evaluation:${currentUserId}:${roundId}:comment:${evaluation.id}`, initial, validTextDraft, evaluation.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { hydrate } = draft;
  useEffect(() => { hydrate(initial, evaluation.version); }, [evaluation.redactedPublicComment, evaluation.publicComment, evaluation.version, hydrate]);

  async function decide(status: "approved" | "hidden") {
    if (busy || draft.conflict || roundStatus === "published") return;
    if (status === "hidden") draft.change({ text: "" });
    const sent = draft.capture();
    setBusy(true); setError("");
    try {
      const version = await saveForm("/api/teacher/evaluations", {
        action: "reviewComment", evaluationId: evaluation.id, expectedVersion: sent.baseVersion,
        status, redactedPublicComment: status === "approved" ? sent.value.text : "",
      });
      draft.acknowledge(sent, version);
      const message = status === "approved" ? "익명 의견을 공개 승인했습니다." : "익명 의견을 숨겼습니다.";
      showToast(message);
      await onSaved();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "익명 의견을 저장하지 못했습니다.";
      setError(message); showToast(message, "error");
      if (cause instanceof FormSaveError && cause.status === 409) await onSaved().catch(() => undefined);
    } finally { setBusy(false); }
  }

  if (!draft.ready) return <div className="empty-state">의견 초안을 확인하고 있어요.</div>;
  return <div className="stack">
    {draft.conflict ? <FormConflict rows={[{ label: "학생에게 공개할 문장", mine: draft.value.text, server: draft.server.text }]} onResolve={draft.resolve} /> : null}
    {draft.warning ? <div className="warning-box" role="alert">{draft.warning}</div> : null}
    {draft.pending ? <p className="save-state">저장하지 않은 검토 문장이 이 탭에 보관되어 있습니다.</p> : null}
    {error ? <div className="error-box" role="alert">{error}</div> : null}
    <label className="field"><span>학생에게 공개할 문장</span><textarea className="textarea compact" maxLength={200} disabled={roundStatus === "published"} value={draft.value.text} onChange={(event) => draft.change({ text: event.target.value })} /></label>
    {roundStatus !== "published" ? <div className="toolbar-group"><button className="button" disabled={busy || draft.conflict} onClick={() => void decide("approved")}>원문/최소 가림 승인</button><button className="button danger" disabled={busy || draft.conflict} onClick={() => void decide("hidden")}>숨김</button></div> : null}
  </div>;
}

function TeacherSummaryEditor({ currentUserId, roundId, roundStatus, student, onSaved }: {
  currentUserId: string;
  roundId: string;
  roundStatus: SelectedEvaluation["status"];
  student: ManagedStudent;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const initial = { text: student.teacherSummary };
  const draft = useFormDraft<TextDraft>(`science-teacher-evaluation:${currentUserId}:${roundId}:summary:${student.studentId}`, initial, validTextDraft, student.teacherSummaryVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { hydrate } = draft;
  useEffect(() => { hydrate(initial, student.teacherSummaryVersion); }, [student.teacherSummary, student.teacherSummaryVersion, hydrate]);

  async function save() {
    if (busy || draft.conflict || roundStatus === "published") return;
    const sent = draft.capture();
    setBusy(true); setError("");
    try {
      const version = await saveForm("/api/teacher/evaluations", {
        action: "saveSummary", roundId, studentId: student.studentId,
        teacherSummary: sent.value.text, expectedVersion: sent.baseVersion,
      });
      draft.acknowledge(sent, version);
      const message = `${student.name} 학생의 종합 피드백을 저장했습니다.`;
      showToast(message);
      await onSaved();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "종합 피드백을 저장하지 못했습니다.";
      setError(message); showToast(message, "error");
      if (cause instanceof FormSaveError && cause.status === 409) await onSaved().catch(() => undefined);
    } finally { setBusy(false); }
  }

  if (!draft.ready) return <div className="empty-state">피드백 초안을 확인하고 있어요.</div>;
  return <article className={`summary-editor ${!student.disclosureEligible ? "required-summary" : ""}`}>
    {draft.conflict ? <FormConflict rows={[{ label: `${student.name} 학생 종합 피드백`, mine: draft.value.text, server: draft.server.text }]} onResolve={draft.resolve} /> : null}
    {draft.warning ? <div className="warning-box" role="alert">{draft.warning}</div> : null}
    {draft.pending ? <p className="save-state">저장하지 않은 종합 피드백이 이 탭에 보관되어 있습니다.</p> : null}
    {error ? <div className="error-box" role="alert">{error}</div> : null}
    <label className="field"><span>{student.teamName} · {student.name} {!student.disclosureEligible ? <b>필수</b> : <small>선택</small>}</span><textarea className="textarea compact" maxLength={2_000} disabled={roundStatus === "published"} value={draft.value.text} onChange={(event) => draft.change({ text: event.target.value })} /></label>
    {roundStatus !== "published" ? <button className="button secondary" disabled={busy || draft.conflict} onClick={() => void save()}>{busy ? "저장 중…" : "피드백 저장"}</button> : null}
  </article>;
}

export function TeacherEvaluationManager({ initialData, currentUserId }: { initialData: EvaluationManagementData; currentUserId: string }) {
  const { showToast } = useToast();
  const [data, setData] = useState(initialData);
  const [scopeKey, setScopeKey] = useState(initialData.clubId ? `club:${initialData.clubId}` : `class:${initialData.classNumber ?? 9}`);
  const [selectedRoundId, setSelectedRoundId] = useState(initialData.selected?.id ?? "");
  const [title, setTitle] = useState(initialData.selected?.title ?? "2026학년도 과학 탐구 자기·동료평가");
  const [items, setItems] = useState<EvaluationItem[]>(initialData.selected?.template.items ?? []);
  const [optionalItem, setOptionalItem] = useState<"none" | "safety" | "theory">("none");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selected = data.selected;

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setItems(selected.template.items);
  }, [selected]);

  const pendingComments = useMemo(() => selected?.peerEvaluations.filter((evaluation) => evaluation.publicComment && evaluation.commentReviewStatus === "pending").length ?? 0, [selected]);
  const incompleteStudents = useMemo(() => selected?.progress.filter((student) => !student.selfSubmitted || student.peerSubmitted < student.peerExpected).length ?? 0, [selected]);

  async function refresh(nextScopeKey = scopeKey, roundId = selectedRoundId) {
    const [scope, value] = nextScopeKey.split(":", 2);
    const params = new URLSearchParams(scope === "club" ? { clubId: value } : { classNumber: value });
    if (roundId) params.set("roundId", roundId);
    const response = await fetch(`/api/teacher/evaluations?${params}`, { cache: "no-store" });
    const result = (await response.json()) as EvaluationManagementData & { message?: string };
    if (!response.ok) throw new Error(result.message ?? "평가 현황을 불러오지 못했습니다.");
    setData(result);
    setSelectedRoundId(result.selected?.id ?? "");
  }

  async function action(body: Record<string, unknown>, successMessage: string) {
    if (body.action === "publish" && selected && hasUnsavedTeacherDraft(currentUserId, selected.id)) {
      const text = "저장하지 않은 검토 문장이나 종합 피드백이 있습니다. 각 저장 버튼을 누른 뒤 결과를 공개해 주세요.";
      setError(text); showToast(text, "error");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/teacher/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { message?: string; roundId?: string };
      if (!response.ok) throw new Error(result.message ?? "평가를 처리하지 못했습니다.");
      const roundId = result.roundId ?? selectedRoundId;
      setSelectedRoundId(roundId);
      setMessage(successMessage);
      showToast(successMessage);
      await refresh(scopeKey, roundId);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "평가를 처리하지 못했습니다.";
      setError(text); showToast(text, "error");
    } finally {
      setBusy(false);
    }
  }

  async function changeScope(value: string) {
    setScopeKey(value);
    setSelectedRoundId("");
    setError("");
    setMessage("");
    try {
      await refresh(value, "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "학급 평가를 불러오지 못했습니다.");
    }
  }

  function updateItem(itemId: string, update: Partial<EvaluationItem>) {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, ...update } : item));
  }

  function updateLevel(itemId: string, level: "1" | "2" | "3" | "4", value: string) {
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, levels: { ...item.levels, [level]: value } } : item));
  }

  return (
    <div className="stack teacher-evaluation-manager">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}

      <section className="card card-body">
        <div className="toolbar">
          <div><h2 className="section-heading">평가 회차</h2><p className="section-subtitle">학급별로 평가를 열고, 의견을 모두 검토한 뒤 결과를 공개합니다.</p></div>
          <div className="toolbar-group">
            <label className="label" htmlFor="evaluationClass">운영 대상</label>
            <select id="evaluationClass" className="select" value={scopeKey} onChange={(event) => void changeScope(event.target.value)} disabled={busy}>
              {Array.from({ length: 9 }, (_, index) => index + 1).map((number) => <option key={number} value={`class:${number}`}>{number}반</option>)}
              {data.availableClubs.map((club) => <option key={club.id} value={`club:${club.id}`}>동아리 · {club.name}</option>)}
            </select>
            {data.rounds.length ? (
              <select className="select" aria-label="평가 회차" value={selectedRoundId} onChange={(event) => { setSelectedRoundId(event.target.value); void refresh(scopeKey, event.target.value); }} disabled={busy}>
                {data.rounds.map((round) => <option key={round.id} value={round.id}>{round.title} · {statusLabels[round.status]}</option>)}
              </select>
            ) : null}
          </div>
        </div>
      </section>

      {!selected ? (
        <section className="card card-body stack">
          <div><h2 className="section-heading">새 평가 만들기</h2><p className="section-subtitle">핵심 4문항과 자기성찰 2문항이 기본으로 들어갑니다.</p></div>
          <label className="field"><span>평가 제목</span><input className="input" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field"><span>선택 문항 <small>최대 1개</small></span><select className="select" value={optionalItem} onChange={(event) => setOptionalItem(event.target.value as typeof optionalItem)}><option value="none">추가하지 않음</option><option value="safety">안전 수칙과 정직한 기록</option><option value="theory">이론 탐구 기여</option></select></label>
          <button className="button" disabled={busy} onClick={() => { const [scope, value] = scopeKey.split(":", 2); void action({ action: "create", ...(scope === "club" ? { clubId: value } : { classNumber: Number(value) }), title, optionalItem }, "평가 초안을 만들었습니다. 문항을 확인한 뒤 학생에게 열어 주세요."); }}>평가 초안 만들기</button>
        </section>
      ) : (
        <>
          <section className="card card-body stack">
            <div className="toolbar">
              <div><span className="eyebrow">{data.scopeLabel}</span><h2 className="section-heading">{selected.title}</h2><p className="section-subtitle">상태: {statusLabels[selected.status]}</p></div>
              <div className="toolbar-group">
                {selected.status === "draft" ? <button className="button" disabled={busy} onClick={() => action({ action: "open", roundId: selected.id }, "학생 평가를 열었습니다.")}>학생 평가 열기</button> : null}
                {selected.status === "open" ? <button className="button danger" disabled={busy} onClick={() => window.confirm("학생 입력을 마감하고 교사 검토로 전환할까요?") && action({ action: "close", roundId: selected.id }, "학생 입력을 마감했습니다. 익명 의견을 검토해 주세요.")}>입력 마감</button> : null}
                {selected.status === "reviewing" || selected.status === "closed" ? <button className="button secondary" disabled={busy} onClick={() => action({ action: "reopen", roundId: selected.id }, "학생 입력을 다시 열었습니다.")}>입력 다시 열기</button> : null}
                {selected.status === "reviewing" || selected.status === "closed" ? <button className="button" disabled={busy || pendingComments > 0} onClick={() => window.confirm("검토된 결과를 학생에게 일괄 공개할까요? 공개 후에는 입력을 다시 열 수 없습니다.") && action({ action: "publish", roundId: selected.id }, "학생에게 평가 결과를 공개했습니다.")}>결과 공개</button> : null}
              </div>
            </div>
            <div className="grid four evaluation-metrics">
              <article className="metric"><span>학생</span><strong>{selected.progress.length}</strong></article>
              <article className="metric"><span>미완료 학생</span><strong>{incompleteStudents}</strong></article>
              <article className="metric"><span>검토할 의견</span><strong>{pendingComments}</strong></article>
              <article className="metric"><span>평균 공개 가능</span><strong>{selected.progress.filter((student) => student.disclosureEligible).length}</strong></article>
            </div>
            {selected.status === "reviewing" && pendingComments > 0 ? <div className="warning-box">검토하지 않은 익명 의견 {pendingComments}건을 모두 승인하거나 숨겨야 결과를 공개할 수 있습니다.</div> : null}
          </section>

          {selected.status === "draft" && !data.clubId ? (
            <section className="card card-body stack">
              <div><h2 className="section-heading">문항과 행동 기준 확인</h2><p className="section-subtitle">평가를 연 뒤에는 현재 회차의 문항을 바꿀 수 없습니다.</p></div>
              <label className="field"><span>평가 제목</span><input className="input" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              {items.map((item, index) => (
                <article className="evaluation-template-item" key={item.id}>
                  <label className="field"><span>{index + 1}번 문항</span><input className="input" maxLength={160} value={item.prompt} onChange={(event) => updateItem(item.id, { prompt: event.target.value })} /></label>
                  <div className="grid two">
                    {([4, 3, 2, 1] as const).map((level) => <label className="field" key={level}><span>{level}단계 행동 기준</span><textarea className="textarea compact" maxLength={500} value={item.levels[String(level) as "1" | "2" | "3" | "4"]} onChange={(event) => updateLevel(item.id, String(level) as "1" | "2" | "3" | "4", event.target.value)} /></label>)}
                  </div>
                </article>
              ))}
              <button className="button" disabled={busy} onClick={() => action({ action: "updateTemplate", roundId: selected.id, title, items }, "평가 문항과 행동 기준을 저장했습니다.")}>문항 설정 저장</button>
            </section>
          ) : null}

          <section className="card">
            <div className="card-body"><h2 className="section-heading">학생별 제출·공개 조건</h2><p className="section-subtitle">유효 평가가 문항마다 3건 이상이어야 숫자 평균과 개별 익명 의견을 공개할 수 있습니다.</p></div>
            <div className="table-wrap"><table className="data-table evaluation-progress-table"><thead><tr><th>팀·학생</th><th>자기평가</th><th>동료평가 제출</th><th>받은 평가</th><th>문항별 유효 수</th><th>공개 방식</th></tr></thead><tbody>
              {selected.progress.map((student) => <tr key={student.studentId} className={!student.disclosureEligible ? "needs-teacher" : ""}><td><b>{student.teamName} · {student.name}</b><br /><small>{student.loginId}</small></td><td>{student.selfSubmitted ? <span className="badge approved">제출</span> : <span className="badge pending">미제출</span>}</td><td>{student.peerSubmitted}/{student.peerExpected}</td><td>{student.peerReceived}</td><td>{selected.peerTemplate.items.map((item) => <span className={`badge ${student.validCounts[item.id] >= 3 ? "approved" : "pending"}`} key={item.id}>{student.validCounts[item.id] ?? 0}</span>)}</td><td>{student.disclosureEligible ? "평균·승인 의견" : "교사 종합 피드백"}</td></tr>)}
            </tbody></table></div>
          </section>

          {selected.status === "reviewing" || selected.status === "closed" || selected.status === "published" ? (
            <section className="card card-body stack">
              <div><h2 className="section-heading">익명 의견 검토</h2><p className="section-subtitle">평가자와 원문은 교사만 봅니다. 의미를 바꾸지 말고 개인정보·욕설만 최소한으로 가리세요.</p></div>
              {!selected.peerEvaluations.some((evaluation) => evaluation.publicComment) ? <div className="empty-state">학생이 작성한 공개 의견이 없습니다.</div> : null}
              {selected.peerEvaluations.filter((evaluation) => evaluation.publicComment).map((evaluation) => (
                <article className={`peer-review-card ${evaluation.commentReviewStatus === "pending" ? "needs-review" : ""}`} key={evaluation.id}>
                  <div className="toolbar"><div><b>{evaluation.teamName} · {evaluation.evaluatorName} → {evaluation.evaluateeName}</b><p className="section-subtitle">교사에게는 평가자가 표시되며 학생에게는 공개되지 않습니다.</p></div><span className={`badge ${evaluation.commentReviewStatus === "pending" ? "pending" : evaluation.commentReviewStatus === "approved" ? "approved" : ""}`}>{evaluation.commentReviewStatus === "pending" ? "검토 필요" : evaluation.commentReviewStatus === "approved" ? "공개 승인" : "숨김"}</span></div>
                  <div className="peer-response-summary">{evaluation.responses.map((response) => <span key={response.itemId}><b>{selected.peerTemplate.items.find((item) => item.id === response.itemId)?.prompt}</b> {typeof response.value === "number" ? `${response.value}단계` : "판단하기 어려움"}{response.reason ? ` · ${response.reason}` : ""}</span>)}</div>
                  {evaluation.privateEvidence ? <div className="private-review-note"><b>교사 확인용 근거</b><p>{evaluation.privateEvidence}</p></div> : null}
                  {evaluation.flags.length ? <div className="toolbar-group">{evaluation.flags.map((flag) => <span className="badge pending" key={flag}>{flagLabels[flag] ?? flag}</span>)}</div> : null}
                  <CommentDecisionEditor key={`${selected.id}:${evaluation.id}`} currentUserId={currentUserId} roundId={selected.id} roundStatus={selected.status} evaluation={evaluation} onSaved={() => refresh(scopeKey, selected.id)} />
                </article>
              ))}
            </section>
          ) : null}

          {selected.status === "reviewing" || selected.status === "closed" || selected.status === "published" ? (
            <section className="card card-body stack">
              <div><h2 className="section-heading">학생별 교사 종합 피드백</h2><p className="section-subtitle">유효 평가가 3건 미만인 학생은 결과 공개 전에 반드시 작성해야 합니다.</p></div>
              {selected.progress.map((student) => <TeacherSummaryEditor key={`${selected.id}:${student.studentId}`} currentUserId={currentUserId} roundId={selected.id} roundStatus={selected.status} student={student} onSaved={() => refresh(scopeKey, selected.id)} />)}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
