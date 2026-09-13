"use client";
import { PRACTICE_MATERIAL_LABEL } from "@/lib/material-practice";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DocumentVersionButton } from "@/components/document-version-comparison";
import type { CycleAnalysisView, CycleDecision } from "@/lib/cycle-analysis";
import type { InquiryData } from "@/lib/inquiry-data";
import { useToast } from "@/components/toast-provider";
import { PastCycleJournals } from "@/components/past-cycle-journals";

const findingCategory: Record<string, string> = {
  hypothesis_variables_measurement: "가설·변인·측정 연결",
  control_and_confounding: "통제·교란변인",
  measurement_error: "측정오차",
  repetition_and_sample: "반복측정·표본",
  interpretation_and_generalization: "해석·일반화",
  feasibility: "실행 가능성",
  safety: "안전",
};

const decisionText: Record<CycleDecision["decision"], string> = {
  accepted: "제안을 받아들임",
  modified: "우리 상황에 맞게 수정",
  rejected: "제안을 선택하지 않음",
};

const materialSyncText: Record<string, string> = {
  pending: "전송 대기",
  syncing: "전송 중",
  synced: "전송 완료",
  failed: "전송 실패",
};

type SnapshotField = { id?: unknown; label?: unknown; kind?: unknown };

function printable(value: unknown) {
  if (value == null || value === "") return <span style={{ color: "var(--muted)" }}>미작성</span>;
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (Array.isArray(value)) {
    if (!value.length) return <span style={{ color: "var(--muted)" }}>미작성</span>;
    return <div className="table-wrap"><table className="data-table"><tbody>{value.map((row, rowIndex) =>
      <tr key={rowIndex}>{(row && typeof row === "object" ? Object.values(row as Record<string, unknown>) : [row])
        .map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div>;
  }
  if (typeof value === "object") return <span>{JSON.stringify(value)}</span>;
  return <span style={{ whiteSpace: "pre-wrap" }}>{String(value)}</span>;
}

function SnapshotDocument({ title, formData, definition, memberRoles = [] }: {
  title: string;
  formData: Record<string, unknown>;
  definition: Record<string, unknown>;
  memberRoles?: Array<{ memberAlias: string; description: string }>;
}) {
  const configured = Array.isArray(definition.fields) ? definition.fields as SnapshotField[] : [];
  const labels = new Map(configured.filter((field) => typeof field.id === "string")
    .map((field) => [field.id as string, typeof field.label === "string" ? field.label : field.id as string]));
  const keys = [...new Set([...configured.map((field) => field.id).filter((id): id is string => typeof id === "string"), ...Object.keys(formData)])];
  return <details className="cycle-document"><summary><strong>{title}</strong></summary><div className="stack compact">
    {keys.map((key) => <div className="plan-field" key={key}><div className="label">{labels.get(key) ?? key}</div>{printable(formData[key])}</div>)}
    {memberRoles.length ? <div className="plan-field"><div className="label">당시 팀원 역할</div><ul>{memberRoles.map((role) => <li key={role.memberAlias}><b>{role.memberAlias}</b>: {role.description || "미작성"}</li>)}</ul></div> : null}
    {!keys.length && !memberRoles.length ? <div className="empty-state">저장된 내용이 없습니다.</div> : null}
  </div></details>;
}

type SnapshotMaterialItem = {
  name?: unknown;
  specification?: unknown;
  unitPrice?: unknown;
  quantity?: unknown;
  shipping?: unknown;
};

function SnapshotMaterials({ requests }: { requests: CycleAnalysisView["documents"]["materialRequests"] }) {
  return <details className="cycle-document"><summary><strong>고정된 준비물 신청</strong></summary><div className="stack compact">
    {requests.map((request, requestIndex) => <article className="plan-field" key={request.id}>
      <div className="toolbar"><strong>신청 {requestIndex + 1}</strong><span className="badge">{request.isPractice ? PRACTICE_MATERIAL_LABEL : materialSyncText[request.syncStatus.toLowerCase()] ?? request.syncStatus}</span></div>
      <ul>{request.items.map((rawItem, itemIndex) => {
        const item = rawItem && typeof rawItem === "object" ? rawItem as SnapshotMaterialItem : {};
        const quantity = typeof item.quantity === "number" ? item.quantity : Number(item.quantity) || 0;
        const unitPrice = typeof item.unitPrice === "number" ? item.unitPrice : Number(item.unitPrice) || 0;
        const shipping = typeof item.shipping === "number" ? item.shipping : Number(item.shipping) || 0;
        return <li key={itemIndex}><b>{String(item.name || `항목 ${itemIndex + 1}`)}</b>{item.specification ? ` · ${String(item.specification)}` : ""} · {quantity}개 · {(unitPrice * quantity + shipping).toLocaleString()}원</li>;
      })}</ul>
      <small>합계 {request.totalAmount.toLocaleString()}원 · {new Date(request.submittedAt).toLocaleString("ko-KR")}</small>
    </article>)}
    {!requests.length ? <div className="empty-state">이 회차에 제출한 준비물 신청이 없습니다.</div> : null}
  </div></details>;
}

function AnalysisBody({ analysis, editable, draftOwnerId, onSaved, historical = false }: {
  analysis: CycleAnalysisView;
  historical?: boolean;
  editable: boolean;
  draftOwnerId: string;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const initial = useMemo(() => new Map(analysis.decisions.map((item) => [item.suggestionId, item])), [analysis.decisions]);
  const [drafts, setDrafts] = useState<Record<string, { decision: CycleDecision["decision"]; reason: string }>>(() =>
    Object.fromEntries(analysis.result.suggestions.map((suggestion) => {
      const saved = initial.get(suggestion.id);
      return [suggestion.id, { decision: saved?.decision ?? "accepted", reason: saved?.reason ?? "" }];
    })),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const draftKey = (suggestionId: string) => `science-cycle-decision:${draftOwnerId}:${analysis.id}:${suggestionId}`;
  useEffect(() => {
    if (!editable) return;
    try {
      setDrafts((current) => ({ ...current, ...Object.fromEntries(analysis.result.suggestions.flatMap((suggestion) => {
        const raw = sessionStorage.getItem(draftKey(suggestion.id));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as { decision?: unknown; reason?: unknown };
        if (!["accepted", "modified", "rejected"].includes(String(parsed.decision)) || typeof parsed.reason !== "string") return [];
        return [[suggestion.id, { decision: parsed.decision as CycleDecision["decision"], reason: parsed.reason }]];
      })) }));
    } catch { setError("이 브라우저의 복구용 판단 초안을 읽지 못했습니다. 화면을 떠나기 전에 저장해 주세요."); }
  // The analysis identity controls hydration. Polling must not replace typing in progress.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.id, draftOwnerId, editable]);

  function changeDraft(suggestionId: string, next: { decision: CycleDecision["decision"]; reason: string }) {
    setDrafts((current) => ({ ...current, [suggestionId]: next }));
    try { sessionStorage.setItem(draftKey(suggestionId), JSON.stringify({ ...next, token: crypto.randomUUID() })); }
    catch { setError("복구용 판단 초안을 보관하지 못했습니다. 화면을 떠나기 전에 저장해 주세요."); }
  }

  async function save(suggestionId: string) {
    const draft = drafts[suggestionId];
    const saved = initial.get(suggestionId);
    if (!draft?.reason.trim()) { setError("선택 이유를 적어 주세요."); return; }
    let sentRaw: string | null = null;
    try { sentRaw = sessionStorage.getItem(draftKey(suggestionId)); } catch { /* Keep the visible draft. */ }
    setBusyId(suggestionId); setError("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
    const response = await fetch("/api/inquiry/cycle-decisions", {
      method: "PATCH",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        analysisId: analysis.id,
        suggestionId,
        decision: draft.decision,
        reason: draft.reason,
        expectedVersion: saved?.version ?? null,
      }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const message = result.message ?? "선택을 저장하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    try {
      if (sentRaw !== null && sessionStorage.getItem(draftKey(suggestionId)) === sentRaw) sessionStorage.removeItem(draftKey(suggestionId));
    } catch { /* Keep recovery data when storage is unavailable. */ }
    showToast("AI 제안에 대한 팀의 판단을 저장했습니다.");
    onSaved();
    } catch {
      const message = "연결이 끊겼거나 응답이 늦습니다. 판단 초안은 유지됩니다. 다시 시도해 주세요.";
      setError(message); showToast(message, "error");
    } finally { window.clearTimeout(timer); setBusyId(null); }
  }

  return (
    <div className="stack cycle-analysis-body">
      {!historical && !analysis.isCurrent ? <div className="warning-box">작성 자료나 AI 검토 기준이 바뀌었습니다. 회차 전환이나 탐구 완료 전에 최신 기준으로 다시 분석해야 합니다.</div> : null}
      <div className="notice-box"><strong>{analysis.analysisType === "intermediate" ? "중간 분석" : "최종 분석"}</strong><p>{analysis.result.overview}</p><small>{analysis.result.inquiryField} · {analysis.result.researchType}</small></div>
      {analysis.result.strengths.length ? <section><h4>확인된 강점</h4><ul>{analysis.result.strengths.map((item, index) => <li key={index}>{item.statement}</li>)}</ul></section> : null}
      {analysis.result.findings.length ? <section><h4>검토할 연결과 한계</h4><div className="stack compact">{analysis.result.findings.map((item, index) => <article className="plan-field" key={index}><div className="toolbar"><strong>{findingCategory[item.category] ?? item.category}</strong><span className={`badge ${item.priority === "required" ? "feedback" : ""}`}>{item.priority === "required" ? "먼저 확인" : "권장"}</span></div><p>{item.observation}</p><p><b>팀이 답할 질문:</b> {item.question}</p><small>근거 {item.evidenceIds.join(", ") || "직접 확인 불가"}</small></article>)}</div></section> : null}
      <section><h4>{analysis.analysisType === "intermediate" ? "탐구를 이어가기 위한 선택지" : "최종 성찰 질문"}</h4>{analysis.analysisType === "intermediate" && editable ? <p className="section-subtitle">팀에 필요한 제안만 선택해 판단과 이유를 남겨도 됩니다.</p> : null}<div className="stack compact">{analysis.result.suggestions.map((suggestion, index) => {
        const saved = initial.get(suggestion.id);
        const draft = drafts[suggestion.id]!;
        return <article className="cycle-suggestion" key={suggestion.id}>
          <strong>{index + 1}. {suggestion.title}</strong>
          <p>{suggestion.rationale}</p>
          <p><b>가능한 다음 행동:</b> {suggestion.feasibleNextStep}</p>
          {suggestion.safetyNote ? <p><b>안전 확인:</b> {suggestion.safetyNote}</p> : null}
          <p><b>팀이 논의할 질문:</b> {suggestion.questionForStudents}</p>
          {editable ? <div className="stack compact">
            <label className="label">팀의 선택<select className="select" value={draft.decision} onChange={(event) => changeDraft(suggestion.id, { ...draft, decision: event.target.value as CycleDecision["decision"] })}><option value="accepted">제안을 받아들임</option><option value="modified">우리 상황에 맞게 수정</option><option value="rejected">제안을 선택하지 않음</option></select></label>
            <label className="label">선택한 이유<textarea className="textarea" value={draft.reason} maxLength={1200} placeholder="자료와 남은 시간, 안전 조건을 고려해 팀의 이유를 적어 주세요." onChange={(event) => changeDraft(suggestion.id, { ...draft, reason: event.target.value })} /></label>
            <button className="button secondary" disabled={busyId === suggestion.id || !draft.reason.trim()} onClick={() => void save(suggestion.id)}>{busyId === suggestion.id ? "저장 중…" : saved ? "판단 수정 저장" : "판단 저장"}</button>
          </div> : saved ? <div className="decision-readonly"><strong>{decisionText[saved.decision]}</strong><p>{saved.reason}</p></div> : <div className="empty-state">아직 팀의 판단을 저장하지 않았습니다.</div>}
        </article>;
      })}</div></section>
      {analysis.result.cycleComparison.length ? <section><h4>회차 사이의 변화</h4><ul>{analysis.result.cycleComparison.map((item, index) => <li key={index}><b>{item.aspect}:</b> {item.change}</li>)}</ul></section> : null}
      {analysis.result.limitations.length ? <section><h4>자료로 확인할 수 없는 점</h4><ul>{analysis.result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null}
      {error ? <div className="error-box">{error}</div> : null}
      <small>AI 결과는 고정된 자료를 바탕으로 한 검토 보조입니다. 학생의 선택과 교사의 최종 판단을 대신하지 않습니다.</small>
    </div>
  );
}

export function CycleAnalysisPanel({ data, audience, currentUserId }: { data: InquiryData; audience: "student" | "teacher"; currentUserId: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = data.session.cycles.find((cycle) => cycle.status === "active") ?? null;

  async function teacherAction(action: "analyze" | "start_next" | "finish_project", analysisType?: "intermediate" | "final") {
    if (!active) return;
    setBusy(true); setError("");
    try {
    const response = await fetch("/api/teacher/cycles", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, cycleId: active.id, ...(analysisType ? { analysisType } : {}) }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const message = result.message ?? "회차 작업을 완료하지 못했습니다.";
      setError(message); showToast(message, "error"); return;
    }
    showToast(action === "analyze" ? "고정된 자료로 AI 분석을 완료했습니다." : action === "start_next" ? "다음 탐구 회차를 시작했습니다." : "전체 탐구를 완료했습니다.");
    router.refresh();
    } catch {
      const message = "회차 작업의 응답을 확인하지 못했습니다. 새로고침하여 처리 상태를 확인한 뒤 다시 시도해 주세요.";
      setError(message); showToast(message, "error");
    } finally { setBusy(false); }
  }

  return (
    <section className="card card-body cycle-analysis-panel">
      <div><h2 className="section-heading">탐구 회차 분석</h2><p className="section-subtitle">계획서·보고서·관찰 기록·대화 근거를 한 버전으로 고정해 분석하고, 이전 회차는 읽기 전용으로 남깁니다.</p></div>
      {error ? <div className="error-box">{error}</div> : null}
      {audience === "teacher" && active ? <div className="toolbar-group cycle-actions">
        {!active.analysis ? <><button className="button secondary" disabled={busy} onClick={() => { if (window.confirm("현재 탐구를 돌아볼 중간 분석을 만드시겠습니까? 이후 같은 회차에서 최종 분석으로 마무리하거나 다음 회차로 이어갈 수 있습니다.")) void teacherAction("analyze", "intermediate"); }}>{busy ? "분석 중…" : "중간 AI 분석 만들기"}</button><button className="button ghost" disabled={busy} onClick={() => { if (window.confirm("현재 회차에서 탐구를 마무리할 최종 분석을 만드시겠습니까? 이후에는 최종 분석을 갱신하여 탐구를 완료합니다.")) void teacherAction("analyze", "final"); }}>최종 AI 분석 만들기</button></> : active.analysis.analysisType === "intermediate" ? <><button className="button" disabled={busy || !active.analysis.isCurrent} onClick={() => void teacherAction("start_next")}>다음 회차 시작</button><button className="button secondary" disabled={busy} onClick={() => { if (window.confirm("중간 분석과 학생 판단을 보존하고, 같은 회차의 최종 분석을 만드시겠습니까?")) void teacherAction("analyze", "final"); }}>이 회차에서 최종 분석</button></> : <button className="button" disabled={busy || !active.analysis.isCurrent} onClick={() => void teacherAction("finish_project")}>전체 탐구 완료</button>}
        {active.analysis && !active.analysis.isCurrent ? <button className="button secondary" disabled={busy} onClick={() => void teacherAction("analyze", active.analysis!.analysisType)}>{busy ? "분석 중…" : "최신 자료로 다시 분석"}</button> : null}
      </div> : null}
      {data.session.cycles.map((cycle) => <details key={cycle.id} open={cycle.status === "active"} className="cycle-history-item">
        <summary><strong>{cycle.title}</strong> · {cycle.status === "active" ? "진행 중" : cycle.status === "completed" ? "완료" : "보관"}{cycle.analysis ? ` · ${cycle.analysis.analysisType === "intermediate" ? "중간 분석" : "최종 분석"}` : ""}</summary>
        <div className="toolbar-group"><DocumentVersionButton scope={{ documentType: "plan", documentId: data.plan.id, cycleId: cycle.id }}>계획서 두 버전 비교</DocumentVersionButton><DocumentVersionButton scope={{ documentType: "report", documentId: data.report.id, cycleId: cycle.id }}>보고서 두 버전 비교</DocumentVersionButton></div><div className="cycle-history-content">{cycle.analysis ? <><div className="cycle-documents"><SnapshotDocument title="고정된 계획서" formData={cycle.analysis.documents.plan.formData} definition={cycle.analysis.documents.plan.configDefinition} /><SnapshotDocument title="고정된 보고서" formData={cycle.analysis.documents.report.formData} definition={cycle.analysis.documents.report.configDefinition} memberRoles={cycle.analysis.documents.report.memberRoles} /><SnapshotMaterials requests={cycle.analysis.documents.materialRequests} /></div><AnalysisBody key={cycle.analysis.id} analysis={cycle.analysis} draftOwnerId={currentUserId} editable={audience === "student" && cycle.status === "active" && cycle.analysis.analysisType === "intermediate" && cycle.analysis.isCurrent} onSaved={() => router.refresh()} /></> : <div className="empty-state">아직 이 회차의 AI 분석이 없습니다.</div>}</div>
        {(cycle.analysisHistory ?? []).length ? <details className="cycle-document"><summary><strong>이전 분석과 학생 판단 보기</strong></summary>{cycle.analysisHistory.map(previous => <details key={previous.id}><summary>{previous.analysisType === "intermediate" ? "중간 분석" : "최종 분석"} · {new Date(previous.createdAt).toLocaleString("ko-KR")}</summary><AnalysisBody analysis={previous} historical editable={false} draftOwnerId={currentUserId} onSaved={() => {}} /></details>)}</details> : null}
        {cycle.status !== "active" ? <PastCycleJournals sessionId={data.session.id} teamId={data.team.id} cycleId={cycle.id} audience={audience}/> : null}
      </details>)}
      {!data.session.cycles.length ? <div className="empty-state">탐구 회차가 없습니다.</div> : null}
    </section>
  );
}
