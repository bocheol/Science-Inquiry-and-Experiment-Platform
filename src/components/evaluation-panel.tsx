"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormSaveError, saveForm, useFormDraft } from "@/components/use-form-draft";
import { FormConflict } from "@/components/form-conflict";
import type {
  EvaluationItem,
  EvaluationResponse,
  PeerEvaluationValue,
  SelfEvaluationValue,
} from "@/lib/evaluation-service";
import { useToast } from "@/components/toast-provider";

type EvaluationData = {
  round: {
    id: string;
    title: string;
    status: "open" | "closed" | "reviewing" | "published";
    template: { items: EvaluationItem[]; selfReflectionQuestions: [string, string] };
    peerTemplate: { items: EvaluationItem[]; selfReflectionQuestions: [string, string] };
  };
  teammates: Array<{ id: string; name: string; loginId: string }>;
  selfEvaluation: null | {
    version: number;
    responses: EvaluationResponse<SelfEvaluationValue>[];
    reflections: [string, string];
    submittedAt: string | null;
  };
  peerEvaluations: Array<{
    version: number;
    evaluateeId: string;
    responses: EvaluationResponse<PeerEvaluationValue>[];
    privateEvidence: string;
    publicComment: string;
    submittedAt: string | null;
  }>;
  result: null | {
    peerAverages: Record<string, number>;
    approvedComments: string[];
    teacherSummary: string;
    publishedAt: string | null;
  };
};

type View = "self" | "peer" | "result";

const levelOrder = [4, 3, 2, 1] as const;

function emptyResponses<T extends PeerEvaluationValue | SelfEvaluationValue>(items: EvaluationItem[], fallback: T) {
  return items.map((item) => ({ itemId: item.id, value: fallback, reason: "" })) as EvaluationResponse<T>[];
}

function responseFor<T extends PeerEvaluationValue | SelfEvaluationValue>(responses: EvaluationResponse<T>[], itemId: string) {
  return responses.find((response) => response.itemId === itemId);
}

function levelLabel(value: PeerEvaluationValue | SelfEvaluationValue) {
  if (value === "unable_to_judge") return "판단하기 어려움";
  if (value === "activity_unavailable") return "해당 활동 기회 없음";
  return `${value}단계`;
}

function evaluationText(responses: EvaluationResponse[], itemId: string) {
  const response = responses.find((item) => item.itemId === itemId);
  return response ? `${levelLabel(response.value)}${response.reason ? ` — ${response.reason}` : ""}` : "미제출";
}

function EvaluationChoices<T extends PeerEvaluationValue | SelfEvaluationValue>({
  item,
  value,
  unavailableValue,
  name,
  disabled,
  onChange,
}: {
  item: EvaluationItem;
  value: T;
  unavailableValue: Extract<T, string>;
  name: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="evaluation-choices">
      {levelOrder.map((level) => (
        <label className={`evaluation-choice level-${level} ${value === level ? "selected" : ""}`} key={level}>
          <input
            type="radio"
            name={name}
            value={level}
            checked={value === level}
            disabled={disabled}
            onChange={() => onChange(level as T)}
          />
          <b>{level}단계</b>
          <span>{item.levels[String(level) as "1" | "2" | "3" | "4"]}</span>
        </label>
      ))}
      <label className={`evaluation-choice unavailable ${value === unavailableValue ? "selected" : ""}`}>
        <input
          type="radio"
          name={name}
          value={unavailableValue}
          checked={value === unavailableValue}
          disabled={disabled}
          onChange={() => onChange(unavailableValue)}
        />
        <b>{unavailableValue === "unable_to_judge" ? "판단하기 어려움" : "해당 활동 기회 없음"}</b>
        <span>{unavailableValue === "unable_to_judge" ? "직접 관찰할 기회가 부족할 때만 선택합니다." : "전입·장기 결석 등으로 활동 기회 자체가 없었던 경우입니다."}</span>
      </label>
    </div>
  );
}

type SelfDraft = { responses: EvaluationResponse<SelfEvaluationValue>[]; reflections: [string, string] };
type PeerDraft = { responses: EvaluationResponse<PeerEvaluationValue>[]; privateEvidence: string; publicComment: string };

function validResponses(value: unknown, items: EvaluationItem[], unavailable: string) {
  return Array.isArray(value) && value.length === items.length && items.every((item) =>
    value.filter((response) => response && response.itemId === item.id &&
      ([1, 2, 3, 4, unavailable].includes(response.value)) && typeof response.reason === "string").length === 1);
}

function SelfEvaluationForm({ data, draftKey, onSaved }: { data: EvaluationData; draftKey: string; onSaved: () => Promise<void> }) {
  const { showToast } = useToast();
  const initial = data.selfEvaluation;
  const server: SelfDraft = { responses: initial?.responses.length ? initial.responses : emptyResponses(data.round.template.items, 3), reflections: initial?.reflections ?? ["", ""] };
  const draft = useFormDraft<SelfDraft>(draftKey, server, (value): value is SelfDraft => {
    const candidate = value as SelfDraft | null;
    return Boolean(candidate && validResponses(candidate.responses, data.round.template.items, "activity_unavailable") &&
      Array.isArray(candidate.reflections) && candidate.reflections.length === 2 && candidate.reflections.every((text) => typeof text === "string"));
  }, initial?.version ?? null);
  const { responses, reflections } = data.round.status === "open" ? draft.value : server;
  const { hydrate } = draft;
  useEffect(() => { hydrate({ responses: initial?.responses.length ? initial.responses : emptyResponses(data.round.template.items, 3), reflections: initial?.reflections ?? ["", ""] }, initial?.version ?? null); }, [initial, data.round.template, hydrate]);
  const setResponses = (update: (current: SelfDraft["responses"]) => SelfDraft["responses"]) => draft.change((current) => ({ ...current, responses: update(current.responses) }));
  const setReflections = (update: (current: SelfDraft["reflections"]) => SelfDraft["reflections"]) => draft.change((current) => ({ ...current, reflections: update(current.reflections) }));
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const editable = data.round.status === "open";

  function setResponse(itemId: string, value: SelfEvaluationValue, reason?: string) {
    setResponses((current) => current.map((response) => response.itemId === itemId ? {
      ...response,
      value,
      reason: reason ?? (typeof value === "number" ? "" : response.reason),
    } : response));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || !editable || !draft.ready || draft.conflict) return;
    sending.current = true;
    const sent = draft.capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const version = await saveForm("/api/inquiry/evaluation", { action: "saveSelf", roundId: data.round.id, ...sent.value, expectedVersion: sent.baseVersion });
      draft.acknowledge(sent, version);
      setMessage("자기평가를 저장했습니다. 평가가 열려 있는 동안 다시 수정할 수 있습니다.");
      showToast("자기평가를 저장했습니다.");
      try { await onSaved(); } catch { setError("저장은 완료했지만 최신 평가 상태를 불러오지 못했습니다. 잠시 뒤 다시 확인해 주세요."); }
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "자기평가를 저장하지 못했습니다.";
      setError(text); showToast(text, "error");
      if (cause instanceof FormSaveError && cause.status === 409) { try { await onSaved(); } catch { /* Keep the draft and offer another explicit attempt. */ } }
    } finally { sending.current = false; setBusy(false); }
  }

  if (!draft.ready) return <div className="empty-state">작성 내용을 확인하고 있어요.</div>;
  if (!editable && !initial) return <div className="empty-state">제출한 자기평가가 없습니다.{draft.pending ? <p>미제출 초안은 이 탭에 보관되어 있습니다. 선생님이 평가를 다시 열면 이어서 작성할 수 있습니다.</p> : null}</div>;
  return (
    <form className="stack" onSubmit={submit}>
      {editable && draft.conflict ? <FormConflict rows={[
        ...data.round.template.items.map((item) => ({ label: item.prompt, mine: evaluationText(draft.value.responses, item.id), server: evaluationText(draft.server.responses, item.id) })),
        ...data.round.template.selfReflectionQuestions.map((label, index) => ({ label, mine: draft.value.reflections[index], server: draft.server.reflections[index] })),
      ]} onResolve={draft.resolve} /> : null}
      {draft.warning ? <div className="warning-box" role="alert">{draft.warning}</div> : null}
      {draft.pending ? <p className="save-state">{editable ? "저장하지 않은 작성 내용이 이 탭에 보관되어 있습니다." : "미제출 초안은 이 탭에 보관되어 있습니다. 아래는 서버에 제출한 내용입니다."}</p> : null}
      <div className="notice-box"><b>내 행동을 근거로 평가합니다.</b> 친분이나 결과의 성공 여부가 아니라 탐구 기간에 실제로 한 행동을 선택하세요.</div>
      {!editable ? <div className="warning-box">평가 입력이 마감되어 제출 내용을 읽기 전용으로 보여줍니다.</div> : null}
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}
      {data.round.template.items.map((item, index) => {
        const current = responseFor(responses, item.id)!;
        return (
          <section className="evaluation-item" key={item.id}>
            <div className="evaluation-item-heading"><span>{index + 1}</span><h3>나는 {item.prompt}</h3></div>
            <EvaluationChoices
              item={item}
              value={current.value}
              unavailableValue="activity_unavailable"
              name={`self-${item.id}`}
              disabled={!editable}
              onChange={(value) => setResponse(item.id, value)}
            />
            {current.value === "activity_unavailable" ? (
              <label className="field"><span>활동 기회가 없었던 이유</span><textarea className="textarea" maxLength={500} required disabled={!editable} value={current.reason} onChange={(event) => setResponse(item.id, current.value, event.target.value)} /></label>
            ) : null}
          </section>
        );
      })}
      <section className="evaluation-reflections">
        {data.round.template.selfReflectionQuestions.map((question, index) => (
          <label className="field" key={question}>
            <span>{question}</span>
            <textarea className="textarea" maxLength={1_000} required disabled={!editable} value={reflections[index]} onChange={(event) => setReflections((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value) as [string, string])} />
          </label>
        ))}
      </section>
      {editable ? <button className="button" disabled={busy || draft.conflict}>{busy ? "저장 중…" : initial ? "자기평가 수정 저장" : "자기평가 저장"}</button> : null}
    </form>
  );
}

function PeerEvaluationForm({ data, teammate, draftKey, onSaved }: { data: EvaluationData; teammate: EvaluationData["teammates"][number]; draftKey: string; onSaved: () => Promise<void> }) {
  const { showToast } = useToast();
  const saved = data.peerEvaluations.find((evaluation) => evaluation.evaluateeId === teammate.id);
  const server: PeerDraft = { responses: saved?.responses.length ? saved.responses : emptyResponses(data.round.peerTemplate.items, 3), privateEvidence: saved?.privateEvidence ?? "", publicComment: saved?.publicComment ?? "" };
  const draft = useFormDraft<PeerDraft>(draftKey, server, (value): value is PeerDraft => {
    const candidate = value as PeerDraft | null;
    return Boolean(candidate && validResponses(candidate.responses, data.round.peerTemplate.items, "unable_to_judge") &&
      typeof candidate.privateEvidence === "string" && typeof candidate.publicComment === "string");
  }, saved?.version ?? null);
  const { responses, privateEvidence, publicComment } = data.round.status === "open" ? draft.value : server;
  const { hydrate } = draft;
  useEffect(() => { hydrate({ responses: saved?.responses.length ? saved.responses : emptyResponses(data.round.peerTemplate.items, 3), privateEvidence: saved?.privateEvidence ?? "", publicComment: saved?.publicComment ?? "" }, saved?.version ?? null); }, [saved, data.round.peerTemplate, hydrate]);
  const setResponses = (update: (current: PeerDraft["responses"]) => PeerDraft["responses"]) => draft.change((current) => ({ ...current, responses: update(current.responses) }));
  const setPrivateEvidence = (text: string) => draft.change((current) => ({ ...current, privateEvidence: text }));
  const setPublicComment = (text: string) => draft.change((current) => ({ ...current, publicComment: text }));
  const sending = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const editable = data.round.status === "open";
  const hasLowLevel = responses.some((response) => response.value === 1 || response.value === 2);

  function setResponse(itemId: string, value: PeerEvaluationValue, reason?: string) {
    setResponses((current) => current.map((response) => response.itemId === itemId ? {
      ...response,
      value,
      reason: reason ?? (typeof value === "number" ? "" : response.reason),
    } : response));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || !editable || !confirmed || !draft.ready || draft.conflict) return;
    sending.current = true;
    const sent = draft.capture();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const version = await saveForm("/api/inquiry/evaluation", { action: "savePeer", roundId: data.round.id, evaluateeId: teammate.id, ...sent.value, confirmed, expectedVersion: sent.baseVersion });
      draft.acknowledge(sent, version);
      setMessage(`${teammate.name} 학생에 대한 평가를 저장했습니다.`);
      showToast("동료평가를 저장했습니다.");
      setConfirmed(false);
      try { await onSaved(); } catch { setError("저장은 완료했지만 최신 평가 상태를 불러오지 못했습니다. 잠시 뒤 다시 확인해 주세요."); }
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "동료평가를 저장하지 못했습니다.";
      setError(text); showToast(text, "error");
      if (cause instanceof FormSaveError && cause.status === 409) { try { await onSaved(); } catch { /* Keep the draft. */ } }
    } finally { sending.current = false; setBusy(false); }
  }

  if (!draft.ready) return <div className="empty-state">작성 내용을 확인하고 있어요.</div>;
  if (!editable && !saved) return <div className="empty-state">이 팀원에게 제출한 평가가 없습니다.{draft.pending ? <p>미제출 초안은 이 탭에 보관되어 있습니다. 선생님이 평가를 다시 열면 이어서 작성할 수 있습니다.</p> : null}</div>;
  return (
    <form className="stack peer-evaluation-form" onSubmit={submit}>
      {editable && draft.conflict ? <FormConflict rows={[
        ...data.round.peerTemplate.items.map((item) => ({ label: item.prompt, mine: evaluationText(draft.value.responses, item.id), server: evaluationText(draft.server.responses, item.id) })),
        { label: "교사 확인용 관찰 근거", mine: draft.value.privateEvidence, server: draft.server.privateEvidence },
        { label: "익명 의견", mine: draft.value.publicComment, server: draft.server.publicComment },
      ]} onResolve={draft.resolve} /> : null}
      {draft.warning ? <div className="warning-box" role="alert">{draft.warning}</div> : null}
      {draft.pending ? <p className="save-state">{editable ? "저장하지 않은 작성 내용이 이 탭에 보관되어 있습니다." : "미제출 초안은 이 탭에 보관되어 있습니다. 아래는 서버에 제출한 내용입니다."}</p> : null}
      <div className="notice-box"><b>{teammate.name}</b> 학생과 친한 정도나 성격이 아니라, 탐구 기간에 직접 본 행동만 평가합니다. 볼 기회가 부족했다면 가운데 단계 대신 `판단하기 어려움`을 선택하세요.</div>
      {!editable ? <div className="warning-box">평가 입력이 마감되어 제출 내용을 읽기 전용으로 보여줍니다.</div> : null}
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="notice-box">{message}</div> : null}
      {data.round.peerTemplate.items.map((item, index) => {
        const current = responseFor(responses, item.id)!;
        return (
          <section className="evaluation-item" key={item.id}>
            <div className="evaluation-item-heading"><span>{index + 1}</span><h3>이 팀원은 {item.prompt}</h3></div>
            <EvaluationChoices
              item={item}
              value={current.value}
              unavailableValue="unable_to_judge"
              name={`peer-${teammate.id}-${item.id}`}
              disabled={!editable}
              onChange={(value) => setResponse(item.id, value)}
            />
            {current.value === "unable_to_judge" ? (
              <label className="field"><span>판단하기 어려운 이유</span><textarea className="textarea" maxLength={500} required disabled={!editable} value={current.reason} onChange={(event) => setResponse(item.id, current.value, event.target.value)} /></label>
            ) : null}
          </section>
        );
      })}
      {hasLowLevel ? (
        <label className="field private-evidence"><span>교사 확인용 관찰 근거 <b>필수</b></span><textarea className="textarea" maxLength={1_000} required disabled={!editable} value={privateEvidence} onChange={(event) => setPrivateEvidence(event.target.value)} /><small>1·2단계의 근거입니다. 학생에게 자동 공개되지 않고 선생님만 먼저 확인합니다.</small></label>
      ) : null}
      <label className="field"><span>이 팀원에게 전할 익명 의견 <small>선택, 200자 이내</small></span><textarea className="textarea" maxLength={200} disabled={!editable} value={publicComment} onChange={(event) => setPublicComment(event.target.value)} placeholder="직접 본 도움이 된 행동과 다음 활동에 도움이 될 구체적인 제안을 적어 주세요." /><small>선생님이 승인한 의견만 평가자가 드러나지 않게 공개됩니다.</small></label>
      {editable ? (
        <label className="evaluation-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required /> 친분·성격·소문이 아니라 직접 본 행동만 평가했습니다.</label>
      ) : null}
      {editable ? <button className="button" disabled={busy || !confirmed || draft.conflict}>{busy ? "저장 중…" : saved ? "이 팀원 평가 수정 저장" : "이 팀원 평가 저장"}</button> : null}
    </form>
  );
}

function EvaluationResult({ data }: { data: EvaluationData }) {
  const result = data.result;
  if (!result) return <div className="empty-state"><h2>아직 결과가 공개되지 않았어요</h2><p>선생님이 의견을 검토하고 결과를 공개하면 이곳에서 확인할 수 있습니다.</p></div>;
  return (
    <div className="stack evaluation-result">
      <div className="notice-box">동료평가는 누가 평가했는지 알 수 없도록 합쳐서 보여줍니다. 유효 평가가 3건 미만인 항목은 숫자로 공개하지 않습니다.</div>
      <section className="card card-body">
        <h2 className="section-heading">나의 자기평가</h2>
        {data.selfEvaluation ? (
          <div className="evaluation-summary-list">
            {data.round.template.items.map((item) => {
              const response = responseFor(data.selfEvaluation!.responses, item.id);
              return <div key={item.id}><b>{item.prompt}</b><span>{response ? levelLabel(response.value) : "미제출"}</span></div>;
            })}
            {data.round.template.selfReflectionQuestions.map((question, index) => <div className="reflection-result" key={question}><b>{question}</b><p>{data.selfEvaluation!.reflections[index] || "작성하지 않음"}</p></div>)}
          </div>
        ) : <p>제출한 자기평가가 없습니다.</p>}
      </section>
      <section className="card card-body">
        <h2 className="section-heading">받은 동료평가</h2>
        <div className="evaluation-summary-list">
          {data.round.peerTemplate.items.map((item) => (
            <div key={item.id}><b>{item.prompt}</b><span>{result.peerAverages[item.id] == null ? "교사 종합 피드백으로 제공" : `${result.peerAverages[item.id].toFixed(1)} / 4.0`}</span></div>
          ))}
        </div>
      </section>
      <section className="card card-body"><h2 className="section-heading">승인된 익명 의견</h2>{result.approvedComments.length ? <ul className="comment-list">{result.approvedComments.map((comment, index) => <li key={`${index}-${comment}`}>{comment}</li>)}</ul> : <p>공개된 개별 의견이 없습니다.</p>}</section>
      <section className="feedback-box"><h2>선생님 종합 피드백</h2><p>{result.teacherSummary || "별도 종합 피드백이 없습니다."}</p></section>
    </div>
  );
}

export function EvaluationPanel({ teamId, currentUserId }: { teamId: string; currentUserId: string }) {
  const [data, setData] = useState<EvaluationData | null>(null);
  const [view, setView] = useState<View>("self");
  const [selectedTeammateId, setSelectedTeammateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    if (!active.current) return;
    const request = ++sequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/api/inquiry/evaluation?teamId=${encodeURIComponent(teamId)}`, { cache: "no-store", signal: controller.signal });
      const result = (await response.json()) as { data?: EvaluationData | null; message?: string };
      if (!active.current || request !== sequence.current) return;
      if (!response.ok) throw new Error(result.message ?? "평가를 불러오지 못했습니다.");
      setData(result.data ?? null);
      setError("");
      if (result.data?.round.status === "published") setView("result");
      setSelectedTeammateId((selected) => result.data?.teammates.some((member) => member.id === selected) ? selected : result.data?.teammates[0]?.id ?? "");
    } catch (cause) {
      if (active.current && request === sequence.current) throw cause;
    } finally { window.clearTimeout(timer); }
  }, [teamId]);

  useEffect(() => {
    let mounted = true;
    active.current = true;
    void refresh().catch(() => mounted && setError("평가를 불러오지 못했습니다. 작성 초안은 보관되어 있습니다.")).finally(() => mounted && setLoading(false));
    return () => { mounted = false; active.current = false; sequence.current++; };
  }, [refresh]);

  const teammate = useMemo(() => data?.teammates.find((member) => member.id === selectedTeammateId) ?? data?.teammates[0], [data, selectedTeammateId]);
  if (loading) return <div className="empty-state">평가 운영 상태를 확인하고 있어요.</div>;
  if (error) return <div className="error-box">{error}<button className="button secondary" onClick={() => { setLoading(true); void refresh().catch(() => setError("평가를 불러오지 못했습니다. 다시 시도해 주세요.")).finally(() => setLoading(false)); }}>다시 불러오기</button></div>;
  if (!data) return <div className="empty-state"><h2>아직 열린 평가가 없어요</h2><p>학기말에 선생님이 평가를 열면 자기평가와 팀원 평가를 작성할 수 있습니다.</p></div>;
  const draftKey = `science-evaluation-draft:${currentUserId}:${teamId}:${data.round.id}`;

  return (
    <div className="stack evaluation-panel">
      <div className="toolbar evaluation-title">
        <div><span className="eyebrow">학기말 평가</span><h2>{data.round.title}</h2><p>{data.round.status === "open" ? "입력 가능" : data.round.status === "published" ? "결과 공개" : "입력 마감·교사 검토 중"}</p></div>
        <span className={`badge ${data.round.status === "open" ? "approved" : data.round.status === "published" ? "" : "pending"}`}>{data.round.status === "open" ? "평가 열림" : data.round.status === "published" ? "공개 완료" : "검토 중"}</span>
      </div>
      <nav className="sub-tabs" aria-label="평가 메뉴">
        <button className={view === "self" ? "active" : ""} onClick={() => setView("self")}>나의 자기평가 {data.selfEvaluation ? "✓" : ""}</button>
        <button className={view === "peer" ? "active" : ""} onClick={() => setView("peer")}>팀원 평가 {data.peerEvaluations.length}/{data.teammates.length}</button>
        <button className={view === "result" ? "active" : ""} onClick={() => setView("result")}>받은 결과</button>
      </nav>
      {view === "self" ? <SelfEvaluationForm key={`${draftKey}:self`} draftKey={`${draftKey}:self`} data={data} onSaved={refresh} /> : null}
      {view === "peer" ? (
        data.teammates.length ? <div className="stack"><div className="peer-selector">{data.teammates.map((member) => <button key={member.id} className={member.id === teammate?.id ? "active" : ""} onClick={() => setSelectedTeammateId(member.id)}>{member.name} {data.peerEvaluations.some((evaluation) => evaluation.evaluateeId === member.id) ? "✓" : ""}</button>)}</div>{teammate ? <PeerEvaluationForm key={`${draftKey}:peer:${teammate.id}`} draftKey={`${draftKey}:peer:${teammate.id}`} data={data} teammate={teammate} onSaved={refresh} /> : null}</div> : <div className="empty-state">평가할 활성 팀원이 없습니다.</div>
      ) : null}
      {view === "result" ? <EvaluationResult data={data} /> : null}
    </div>
  );
}
