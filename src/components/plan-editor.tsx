"use client";

import { useEffect, useMemo, useState } from "react";
import { INQUIRY_FIELDS, PLAN_FIELDS } from "@/lib/constants";
import type { InquiryData } from "@/lib/inquiry-data";
import { DocumentHistoryPanel } from "@/components/document-history-panel";

type ScheduleRow = { period: string; location: string; content: string; materials: string };

const statusText: Record<string, string> = { draft: "작성 중", pending: "승인 대기", feedback: "수정 요청", approved: "승인됨", reapproval_required: "재승인 필요" };

export function PlanEditor({ data, currentUserId, onRefresh }: { data: InquiryData; currentUserId: string; onRefresh: () => Promise<void> }) {
  const [form, setForm] = useState<Record<string, unknown>>(data.plan.formData);
  const [editing, setEditing] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { if (!editing) setForm(data.plan.formData); }, [data.plan.updatedAt, data.plan.formData, editing]);
  useEffect(() => {
    if (!editing) return;
    const timer = window.setInterval(() => void lock(editing, "acquire", true), 15_000);
    return () => window.clearInterval(timer);
  }, [editing]);

  const lockMap = useMemo(() => new Map(data.plan.locks.map((lock) => [lock.fieldKey, lock])), [data.plan.locks]);
  const schedule = Array.isArray(form.schedule) ? form.schedule as ScheduleRow[] : [];

  async function lock(fieldKey: string, action: "acquire" | "release", silent = false) {
    const response = await fetch("/api/inquiry/plan/lock", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: data.plan.id, fieldKey, action }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) { if (!silent) setError(result.message ?? "이 항목을 편집할 수 없습니다."); return false; }
    if (action === "acquire") setEditing(fieldKey);
    return true;
  }

  async function save(fieldKey: string, value: unknown) {
    setState("저장 중…"); setError("");
    const response = await fetch("/api/inquiry/plan", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: data.plan.id, fieldKey, value }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) { setState(""); return setError(result.message ?? "저장하지 못했습니다."); }
    setState("저장됨");
    await lock(fieldKey, "release", true);
    setEditing(null);
    await onRefresh();
  }

  function change(fieldKey: string, value: unknown) { setForm((current) => ({ ...current, [fieldKey]: value })); }

  async function submit() {
    setError("");
    const response = await fetch("/api/inquiry/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: data.plan.id, action: "submit" }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) return setError(result.message ?? "제출하지 못했습니다.");
    await onRefresh();
  }

  async function restore(revisionId: string) {
    setError(""); setState("복원 중…");
    const response = await fetch("/api/inquiry/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: data.plan.id, action: "restore", revisionId }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) { setState(""); throw new Error(result.message ?? "복원하지 못했습니다."); }
    setState("복원됨");
    await onRefresh();
  }

  function updateSchedule(index: number, key: keyof ScheduleRow, value: string) {
    const next = schedule.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row);
    change("schedule", next);
  }

  return (
    <div className="plan-layout">
      <section className="card plan-form">
        <div className="page-title" style={{ marginBottom: 8 }}><div><h1 style={{ fontSize: 26 }}>팀 탐구 계획서</h1><p>{data.team.classNumber}반 {data.team.name} · 팀원 정보는 자동으로 포함됩니다.</p></div><span className={`badge ${data.plan.reviewStatus}`}>{statusText[data.plan.reviewStatus]}</span></div>
        {data.plan.teacherFeedback ? <div className="warning-box"><b>선생님 피드백</b><br />{data.plan.teacherFeedback}</div> : null}
        {error ? <div className="error-box">{error}</div> : null}
        {PLAN_FIELDS.map((field) => {
          const otherLock = lockMap.get(field.key);
          const lockedByOther = otherLock && otherLock.userId !== currentUserId;
          if (field.kind === "schedule") return (
            <div className="plan-field" key={field.key}>
              <div className="field-heading"><span className="label">{field.label}</span>{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : null}</div>
              <div className="table-wrap">
                <table className="schedule-table"><thead><tr><th>수행기간</th><th>장소</th><th>탐구내용</th><th>준비물</th><th></th></tr></thead>
                  <tbody>{schedule.map((row, index) => <tr key={index}>{(["period", "location", "content", "materials"] as const).map((key) => <td key={key}><input className="input" value={row[key]} disabled={Boolean(lockedByOther)} onFocus={() => lock("schedule", "acquire")} onChange={(event) => updateSchedule(index, key, event.target.value)} onBlur={() => save("schedule", schedule)} /></td>)}<td><button className="button ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => { const next = schedule.filter((_, rowIndex) => rowIndex !== index); change("schedule", next); void save("schedule", next); }}>삭제</button></td></tr>)}</tbody>
                </table>
              </div>
              <button className="button ghost" style={{ marginTop: 10 }} disabled={Boolean(lockedByOther)} onClick={async () => { if (await lock("schedule", "acquire")) change("schedule", [...schedule, { period: "", location: "", content: "", materials: "" }]); }}>+ 일정 추가</button>
            </div>
          );
          return (
            <div className="plan-field" key={field.key}>
              <div className="field-heading"><label className="label" htmlFor={`plan-${field.key}`}>{field.label}</label>{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : editing === field.key ? <span className="save-state">작성 중</span> : null}</div>
              {field.kind === "select" ? <select id={`plan-${field.key}`} className="select" value={String(form[field.key] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => lock(field.key, "acquire")} onChange={(event) => change(field.key, event.target.value)} onBlur={() => save(field.key, form[field.key] ?? "")}><option value="">분야 선택</option>{INQUIRY_FIELDS.map((value) => <option key={value}>{value}</option>)}</select> : field.kind === "text" ? <input id={`plan-${field.key}`} className="input" value={String(form[field.key] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => lock(field.key, "acquire")} onChange={(event) => change(field.key, event.target.value)} onBlur={() => save(field.key, form[field.key] ?? "")} /> : <textarea id={`plan-${field.key}`} className="textarea" value={String(form[field.key] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => lock(field.key, "acquire")} onChange={(event) => change(field.key, event.target.value)} onBlur={() => save(field.key, form[field.key] ?? "")} />}
            </div>
          );
        })}
      </section>
      <aside className="card plan-side">
        <h3 className="section-heading">작성 안내</h3>
        <p className="section-subtitle">연락처와 이메일은 수집하지 않습니다. 항목에서 나가면 자동 저장됩니다.</p>
        <div className="notice-box">{state || "팀원이 같은 항목을 열면 작성자 표시와 잠금이 적용됩니다."}</div>
        <button className="button full" onClick={submit} disabled={data.plan.reviewStatus === "pending"}>{data.plan.reviewStatus === "pending" ? "선생님 확인 중" : data.plan.reviewStatus === "approved" ? "승인 완료" : "선생님께 제출"}</button>
        <DocumentHistoryPanel title="계획서" history={data.plan.history} canRestore={data.team.leaderUserId === currentUserId} onRestore={restore} />
      </aside>
    </div>
  );
}
