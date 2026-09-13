"use client";

import { useMemo } from "react";
import { useDocumentEditor } from "@/components/use-document-editor";
import type { InquiryData } from "@/lib/inquiry-data";
import { LegacyDocumentDraft } from "@/components/legacy-document-draft";
import { DocumentConflicts } from "@/components/document-conflicts";
import { DocumentHistoryPanel } from "@/components/document-history-panel";
import { useToast } from "@/components/toast-provider";

const statusText: Record<string, string> = {
  draft: "작성 중",
  submitted: "제출됨",
  feedback: "수정 요청",
  reviewed: "교사 확인 완료",
};

export function ReportEditor({ data, currentUserId, onRefresh }: { data: InquiryData; currentUserId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useToast();
  const remote = useMemo(() => ({
    title: data.session.selectedTopic ?? "", ...data.report.formData,
    ...Object.fromEntries(data.report.roles.map((role) => [`role:${role.userId}`, role.description])),
  }), [data.session.selectedTopic, data.report.formData, data.report.roles]);
  const { legacyDraft, form, editing, state, error, busy, pending, focus, change, blur, saveAll, setState, setError, conflicts, useRemote, keepMine } = useDocumentEditor({
    kind: "report", documentId: data.report.id, cycleId: data.session.cycle!.id, configVersionId: data.report.configVersionId, currentUserId, remote, onRefresh,
  });
  const roles = new Map(data.report.roles.map((role) => [role.userId, String(form[`role:${role.userId}`] ?? "")]));
  const lockMap = useMemo(() => new Map(data.report.locks.filter((item) => Date.parse(item.expiresAt) > Date.now()).map((item) => [item.fieldKey, item])), [data.report.locks]);
  const titleField = data.report.fields.find((field) => field.id === "title");

  async function submit() {
    if (pending) { setError("작성한 내용을 먼저 임시 저장한 뒤 제출해 주세요."); return; }
    setError(""); setState("제출 중…");
    const response = await fetch("/api/inquiry/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: data.session.cycle!.id, reportId: data.report.id, action: "submit" }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const text = result.message ?? "제출하지 못했습니다.";
      setState(""); setError(text); showToast(text, "error"); return;
    }
    setState("제출됨");
    showToast("팀 최종보고서를 제출했습니다.");
    await onRefresh();
  }

  async function restore(revisionId: string) {
    if (pending) throw new Error("작성 중인 내용을 먼저 저장한 뒤 이력을 복원해 주세요.");
    setError(""); setState("복원 중…");
    const response = await fetch("/api/inquiry/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: data.session.cycle!.id, reportId: data.report.id, action: "restore", revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) { setState(""); throw new Error(result.message ?? "복원하지 못했습니다."); }
    setState("복원됨");
    showToast("팀 최종보고서를 선택한 이력으로 복원했습니다.");
    await onRefresh();
  }

  return (
    <div className="report-layout">
      <section className="card report-form">
        <div className="page-title report-title">
          <div><h1>팀 최종보고서</h1><p>{data.report.description || "팀이 함께 작성하는 최종보고서입니다."}</p></div>
          <span className={`badge ${data.report.status === "feedback" ? "feedback" : data.report.status === "submitted" ? "pending" : ""}`}>{statusText[data.report.status] ?? data.report.status}</span>
        </div>
        {data.report.teacherFeedback ? <div className="warning-box"><b>선생님 피드백</b><br />{data.report.teacherFeedback}</div> : null}
        {error ? <div className="error-box" role="alert">{error}</div> : null}

        <div className="report-cover">
          {titleField ? <div className="plan-field">
            <ReportFieldHeading fieldKey="title" label={`${titleField.label}${titleField.required ? " *" : ""}`} lockMap={lockMap} currentUserId={currentUserId} editing={editing} />
            <input id="report-title" className="input" value={String(form.title ?? "")} disabled={Boolean(lockMap.get("title") && lockMap.get("title")!.userId !== currentUserId)} onFocus={() => focus("title")} onChange={(event) => change("title", event.target.value)} onBlur={() => blur("title")} maxLength={500} />
          </div> : null}
          <div className="report-cover-meta"><div><span>팀명</span><b>{data.team.name}</b></div><div><span>{data.team.clubId ? '동아리' : '학급'}</span><b>{data.team.activityName ?? `${data.team.classNumber}반`}</b></div></div>
          <div className="table-wrap">
            <table className="data-table report-role-table">
              <thead><tr><th>학번</th><th>이름</th><th>구분</th><th>팀원별 역할</th></tr></thead>
              <tbody>{data.report.roles.filter((role) => role.isActive).map((role) => {
                const fieldKey = `role:${role.userId}`;
                const otherLock = lockMap.get(fieldKey);
                const lockedByOther = otherLock && otherLock.userId !== currentUserId;
                return <tr key={role.userId}><td>{role.loginId}</td><td>{role.name}</td><td>{role.isLeader ? "팀장" : "팀원"}</td><td><div className="field-heading role-heading">{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : null}</div><input id={`report-${fieldKey}`} className="input" value={roles.get(role.userId) ?? ""} disabled={Boolean(lockedByOther)} onFocus={() => focus(fieldKey)} onChange={(event) => change(fieldKey, event.target.value)} onBlur={() => blur(fieldKey)} maxLength={2_000} placeholder="담당한 역할" /></td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>

        {data.report.fields.filter((field) => field.id !== "title").map((field) => {
          if (field.kind === "heading") return <h2 className="section-heading" key={field.id}>{field.label}</h2>;
          const otherLock = lockMap.get(field.id);
          const lockedByOther = otherLock && otherLock.userId !== currentUserId;
          if (field.kind === "table") {
            const rows = Array.isArray(form[field.id]) ? form[field.id] as Array<Record<string, unknown>> : [];
            return <div className="plan-field" key={field.id}><ReportFieldHeading fieldKey={field.id} label={`${field.label}${field.required ? " *" : ""}`} lockMap={lockMap} currentUserId={currentUserId} editing={editing} /><div className="table-wrap"><table className="schedule-table"><thead><tr>{field.columns?.map((column) => <th key={column.id}>{column.label}</th>)}<th></th></tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{field.columns?.map((column) => <td key={column.id}><input className="input" type={column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text"} value={String(row[column.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => { const next = rows.map((item) => ({ ...item })); next[rowIndex][column.id] = event.target.value; change(field.id, next); }} onBlur={() => blur(field.id)} /></td>)}<td><button type="button" className="button ghost" disabled={Boolean(lockedByOther)} onMouseDown={(event) => event.preventDefault()} onClick={() => { const next = rows.filter((_, index) => index !== rowIndex); change(field.id, next); }}>삭제</button></td></tr>)}</tbody></table></div><button type="button" className="button ghost" disabled={Boolean(lockedByOther)} onMouseDown={(event) => event.preventDefault()} onClick={() => { focus(field.id); change(field.id, [...rows, {}]); }}>+ 행 추가</button></div>;
          }
          return <div className="plan-field" key={field.id}>
            <ReportFieldHeading fieldKey={field.id} label={`${field.label}${field.required ? " *" : ""}`} lockMap={lockMap} currentUserId={currentUserId} editing={editing} />
            {field.kind === "single_choice" ? <select id={`report-${field.id}`} className="select" value={String(form[field.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)}><option value="">선택</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : field.kind === "multiple_choice" ? <div className="toolbar-group">{field.options?.map((option) => { const selected = Array.isArray(form[field.id]) ? form[field.id] as string[] : []; return <label key={option}><input type="checkbox" checked={selected.includes(option)} disabled={Boolean(lockedByOther)} onChange={(event) => { const next = event.target.checked ? [...selected, option] : selected.filter((item) => item !== option); change(field.id, next); }} /> {option}</label>; })}</div> : field.kind === "checkbox" ? <label><input type="checkbox" checked={Boolean(form[field.id])} disabled={Boolean(lockedByOther)} onChange={(event) => { change(field.id, event.target.checked); }} /> 확인</label> : field.kind === "long_text" ? <textarea id={`report-${field.id}`} className="textarea report-textarea" value={String(form[field.id] ?? "")} readOnly={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)} maxLength={30_000} /> : <input id={`report-${field.id}`} className="input" type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"} value={String(form[field.id] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => focus(field.id)} onChange={(event) => change(field.id, event.target.value)} onBlur={() => blur(field.id)} maxLength={30_000} />}
            {field.help ? <small>{field.help}</small> : null}
          </div>;
        })}
      </section>
      <aside className="card plan-side">
        <h3 className="section-heading">작성 안내</h3>
        <p className="section-subtitle">작성 중인 글은 이 탭에 복구용으로 보관됩니다. 임시 저장을 눌러야 팀원에게 공유되고 변경 이력에 남습니다. 부록은 선택 항목입니다.</p>
        <div className="notice-box" role="status">{state || "서버에는 임시 저장 버튼으로 저장합니다. 같은 항목은 한 명씩 편집할 수 있습니다."}</div>
        <button className="button full" onClick={submit} disabled={busy || data.report.status === "submitted" || data.report.status === "reviewed"}>{data.report.status === "submitted" ? "선생님 확인 중" : data.report.status === "reviewed" ? "확인 완료" : "선생님께 제출"}</button>
        <button className="button secondary full" disabled={busy || !pending} onClick={() => void saveAll()}>임시 저장</button>
        <LegacyDocumentDraft values={legacyDraft} labels={Object.fromEntries(data.report.fields.map((field) => [field.id, field.label]))} />
        <DocumentConflicts conflicts={conflicts} labels={Object.fromEntries(data.report.fields.map((field) => [field.id, field.label]))} busy={busy} onUseRemote={useRemote} onKeepMine={keepMine} />
        <DocumentHistoryPanel scope={{ documentType: "report", documentId: data.report.id, cycleId: data.session.cycle!.id }} title="보고서" history={data.report.history} canRestore={data.team.leaderUserId === currentUserId} onRestore={restore} />
      </aside>
    </div>
  );
}

function ReportFieldHeading({ fieldKey, label, lockMap, currentUserId, editing }: {
  fieldKey: string;
  label: string;
  lockMap: Map<string, InquiryData["report"]["locks"][number]>;
  currentUserId: string;
  editing: string | null;
}) {
  const lockItem = lockMap.get(fieldKey);
  const lockedByOther = lockItem && lockItem.userId !== currentUserId;
  return <div className="field-heading"><label className="label" htmlFor={`report-${fieldKey}`}>{label}</label>{lockedByOther ? <span className="lock-label">🔒 {lockItem.userName} 작성 중</span> : editing === fieldKey ? <span className="save-state">작성 중</span> : null}</div>;
}
