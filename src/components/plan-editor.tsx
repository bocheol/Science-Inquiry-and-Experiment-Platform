"use client";

import { useMemo } from "react";
import { useDocumentEditor } from "@/components/use-document-editor";
import type { InquiryData } from "@/lib/inquiry-data";
import { LegacyDocumentDraft } from "@/components/legacy-document-draft";
import { DocumentConflicts } from "@/components/document-conflicts";
import { DocumentHistoryPanel } from "@/components/document-history-panel";
import { useToast } from "@/components/toast-provider";
import { PlanAiReviewPanel } from "@/components/plan-ai-review-panel";

const statusText: Record<string, string> = { draft: "작성 중", pending: "승인 대기", feedback: "수정 요청", approved: "승인됨", reapproval_required: "재승인 필요" };

export function PlanEditor({ data, currentUserId, onRefresh }: { data: InquiryData; currentUserId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useToast();
  const { legacyDraft, form, editing, state, error, busy, pending, focus, change, blur, saveAll, setState, setError, conflicts, useRemote, keepMine } = useDocumentEditor({
    kind: "plan", documentId: data.plan.id, cycleId: data.session.cycle!.id, configVersionId: data.plan.configVersionId, currentUserId, remote: data.plan.formData, onRefresh,
  });
  const lockMap = useMemo(() => new Map(data.plan.locks.filter((item) => Date.parse(item.expiresAt) > Date.now()).map((item) => [item.fieldKey, item])), [data.plan.locks]);


  async function submit() {
    if (pending) { setError("작성한 내용을 먼저 임시 저장한 뒤 제출해 주세요."); return; }
    setError("");
    const response = await fetch("/api/inquiry/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: data.session.cycle!.id, planId: data.plan.id, action: "submit" }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const text = result.message ?? "제출하지 못했습니다.";
      setError(text); showToast(text, "error"); return;
    }
    showToast("탐구 계획서를 제출했습니다.");
    await onRefresh();
  }

  async function restore(revisionId: string) {
    if (pending) throw new Error("작성 중인 내용을 먼저 저장한 뒤 이력을 복원해 주세요.");
    setError(""); setState("복원 중…");
    const response = await fetch("/api/inquiry/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: data.session.cycle!.id, planId: data.plan.id, action: "restore", revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) { setState(""); throw new Error(result.message ?? "복원하지 못했습니다."); }
    setState("복원됨");
    showToast("탐구 계획서를 선택한 이력으로 복원했습니다.");
    await onRefresh();
  }

  return (
    <div className="plan-layout">
      <section className="card plan-form">
        <div className="page-title" style={{ marginBottom: 8 }}><div><h1 style={{ fontSize: 26 }}>팀 탐구 계획서</h1><p>{data.team.activityName ?? `${data.team.classNumber}반`} {data.team.name} · 팀원 정보는 자동으로 포함됩니다.</p></div><span className={`badge ${data.plan.reviewStatus}`}>{statusText[data.plan.reviewStatus]}</span></div>
        {data.plan.latestSubmission && data.plan.latestSubmission.reviewStatus !== "withdrawn" ? <div className="notice-box">제출본 {data.plan.latestSubmission.submissionNumber}번이 고정되어 선생님 검토 화면에 표시됩니다.</div> : null}
        {data.plan.teacherFeedback ? <div className="warning-box"><b>선생님 피드백</b><br />{data.plan.teacherFeedback}</div> : null}
        {error ? <div className="error-box">{error}</div> : null}
        {data.plan.description ? <p className="notice-box">{data.plan.description}</p> : null}
        {data.plan.fields.map((field) => {
          if (field.kind === "heading") return <h2 className="section-heading" key={field.id}>{field.label}</h2>;
          const otherLock = lockMap.get(field.id);
          const lockedByOther = otherLock && otherLock.userId !== currentUserId;
          if (field.kind === "table") {
            const rows = Array.isArray(form[field.id]) ? form[field.id] as Array<Record<string, unknown>> : [];
            return (
            <div className="plan-field" key={field.id}>
              <div className="field-heading"><span className="label">{field.label}</span>{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : null}</div>
              <div className="table-wrap">
                <table className="schedule-table"><thead><tr>{field.columns?.map((column) => <th key={column.id}>{column.label}</th>)}<th></th></tr></thead>
                  <tbody>{rows.map((row, index) => <tr key={index}>{field.columns?.map((column) => <td key={column.id}><input className="input" type={column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text"} value={String(row[column.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => { const next = rows.map((item) => ({ ...item })); next[index][column.id] = event.target.value; change(field.id, next); }} onBlur={() => blur(field.id)} /></td>)}<td><button className="button ghost" disabled={Boolean(lockedByOther)} onMouseDown={(event) => event.preventDefault()} onClick={() => { const next = rows.filter((_, rowIndex) => rowIndex !== index); change(field.id, next); }}>삭제</button></td></tr>)}</tbody>
                </table>
              </div>
              <button className="button ghost" style={{ marginTop: 10 }} disabled={Boolean(lockedByOther)} onClick={() => { focus(field.id); change(field.id, [...rows, {}]); }}>+ 행 추가</button>
            </div>
          ); }
          return (
            <div className="plan-field" key={field.id}>
              <div className="field-heading"><label className="label" htmlFor={`plan-${field.id}`}>{field.label}{field.required ? " *" : ""}</label>{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : editing === field.id ? <span className="save-state">작성 중</span> : null}</div>
              {field.kind === "single_choice" ? <select id={`plan-${field.id}`} className="select" value={String(form[field.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)}><option value="">선택</option>{field.options?.map((value) => <option key={value}>{value}</option>)}</select> : field.kind === "multiple_choice" ? <div className="toolbar-group">{field.options?.map((option) => { const selected = Array.isArray(form[field.id]) ? form[field.id] as string[] : []; return <label key={option}><input type="checkbox" checked={selected.includes(option)} disabled={Boolean(lockedByOther)} onChange={(event) => { const next = event.target.checked ? [...selected, option] : selected.filter((item) => item !== option); change(field.id, next); }} /> {option}</label>; })}</div> : field.kind === "checkbox" ? <label><input type="checkbox" checked={Boolean(form[field.id])} disabled={Boolean(lockedByOther)} onChange={(event) => { change(field.id, event.target.checked); }} /> 확인</label> : field.kind === "long_text" ? <textarea id={`plan-${field.id}`} className="textarea" value={String(form[field.id] ?? "")} readOnly={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)} /> : <input id={`plan-${field.id}`} className="input" type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"} value={String(form[field.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)} />}
              {field.help ? <small>{field.help}</small> : null}
            </div>
          );
        })}
        <PlanAiReviewPanel data={data} audience="student" disabled={busy || pending} onRefresh={onRefresh} />
      </section>
      <aside className="card plan-side">
        <h3 className="section-heading">작성 안내</h3>
        <p className="section-subtitle">작성 중인 글은 이 탭에 복구용으로 보관됩니다. 임시 저장을 눌러야 팀원에게 공유되고 변경 이력에 남습니다.</p>
        <div className="notice-box" role="status">{state || "팀원이 같은 항목을 열면 작성자 표시와 잠금이 적용됩니다."}</div>
        <button className="button full" onClick={submit} disabled={busy || data.plan.reviewStatus === "pending" || data.plan.reviewStatus === "approved"}>{data.plan.reviewStatus === "pending" ? "선생님 확인 중" : data.plan.reviewStatus === "approved" ? "승인 완료" : "선생님께 제출"}</button>
        <button className="button secondary full" disabled={busy || !pending} onClick={() => void saveAll()}>임시 저장</button>
        <LegacyDocumentDraft values={legacyDraft} labels={Object.fromEntries(data.plan.fields.map((field) => [field.id, field.label]))} />
        <DocumentConflicts conflicts={conflicts} labels={Object.fromEntries(data.plan.fields.map((field) => [field.id, field.label]))} busy={busy} onUseRemote={useRemote} onKeepMine={keepMine} />
        <DocumentHistoryPanel scope={{ documentType: "plan", documentId: data.plan.id, cycleId: data.session.cycle!.id }} title="계획서" history={data.plan.history} canRestore={data.team.leaderUserId === currentUserId} onRestore={restore} />
      </aside>
    </div>
  );
}
