"use client";

import { useEffect, useMemo, useState } from "react";
import { REPORT_FIELDS } from "@/lib/constants";
import type { InquiryData } from "@/lib/inquiry-data";
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
  const [form, setForm] = useState<Record<string, unknown>>({ title: data.session.selectedTopic ?? "", ...data.report.formData });
  const [roles, setRoles] = useState(() => new Map(data.report.roles.map((role) => [role.userId, role.description])));
  const [editing, setEditing] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (editing) return;
    setForm({ title: data.session.selectedTopic ?? "", ...data.report.formData });
    setRoles(new Map(data.report.roles.map((role) => [role.userId, role.description])));
  }, [data.report.formData, data.report.roles, data.report.updatedAt, data.session.selectedTopic, editing]);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setInterval(() => void lock(editing, "acquire", true), 15_000);
    return () => window.clearInterval(timer);
  }, [editing]);

  const lockMap = useMemo(() => new Map(data.report.locks.map((lockItem) => [lockItem.fieldKey, lockItem])), [data.report.locks]);

  async function lock(fieldKey: string, action: "acquire" | "release", silent = false) {
    const response = await fetch("/api/inquiry/report/lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportId: data.report.id, fieldKey, action }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      if (!silent) {
        const text = result.message ?? "이 항목을 편집할 수 없습니다.";
        setError(text); showToast(text, "error");
      }
      return false;
    }
    if (action === "acquire") setEditing(fieldKey);
    return true;
  }

  async function saveField(fieldKey: string, value: string) {
    setState("저장 중…"); setError("");
    const response = await fetch("/api/inquiry/report", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "field", reportId: data.report.id, fieldKey, value }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const text = result.message ?? "저장하지 못했습니다.";
      setState(""); setError(text); showToast(text, "error"); return;
    }
    setState("저장됨");
    await lock(fieldKey, "release", true);
    setEditing(null);
    await onRefresh();
  }

  async function saveRole(userId: string, value: string) {
    const fieldKey = `role:${userId}`;
    setState("저장 중…"); setError("");
    const response = await fetch("/api/inquiry/report", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "role", reportId: data.report.id, userId, value }),
    });
    const result = (await response.json()) as { message?: string };
    if (!response.ok) {
      const text = result.message ?? "역할을 저장하지 못했습니다.";
      setState(""); setError(text); showToast(text, "error"); return;
    }
    setState("저장됨");
    await lock(fieldKey, "release", true);
    setEditing(null);
    await onRefresh();
  }

  async function submit() {
    setError(""); setState("제출 중…");
    const response = await fetch("/api/inquiry/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportId: data.report.id, action: "submit" }),
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
    setError(""); setState("복원 중…");
    const response = await fetch("/api/inquiry/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportId: data.report.id, action: "restore", revisionId }),
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
          <div><h1>팀 최종보고서</h1><p>학교 최종보고서 양식의 목차 순서로 함께 작성합니다.</p></div>
          <span className={`badge ${data.report.status === "feedback" ? "feedback" : data.report.status === "submitted" ? "pending" : ""}`}>{statusText[data.report.status] ?? data.report.status}</span>
        </div>
        {data.report.teacherFeedback ? <div className="warning-box"><b>선생님 피드백</b><br />{data.report.teacherFeedback}</div> : null}
        {error ? <div className="error-box" role="alert">{error}</div> : null}

        <div className="report-cover">
          <div className="plan-field">
            <ReportFieldHeading fieldKey="title" label="연구주제" lockMap={lockMap} currentUserId={currentUserId} editing={editing} />
            <input className="input" value={String(form.title ?? "")} disabled={Boolean(lockMap.get("title") && lockMap.get("title")!.userId !== currentUserId)} onFocus={() => lock("title", "acquire")} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} onBlur={() => saveField("title", String(form.title ?? ""))} maxLength={500} />
          </div>
          <div className="report-cover-meta"><div><span>팀명</span><b>{data.team.name}</b></div><div><span>학급</span><b>{data.team.classNumber}반</b></div></div>
          <div className="table-wrap">
            <table className="data-table report-role-table">
              <thead><tr><th>학번</th><th>이름</th><th>구분</th><th>팀원별 역할</th></tr></thead>
              <tbody>{data.report.roles.filter((role) => role.isActive).map((role) => {
                const fieldKey = `role:${role.userId}`;
                const otherLock = lockMap.get(fieldKey);
                const lockedByOther = otherLock && otherLock.userId !== currentUserId;
                return <tr key={role.userId}><td>{role.loginId}</td><td>{role.name}</td><td>{role.isLeader ? "팀장" : "팀원"}</td><td><div className="field-heading role-heading">{lockedByOther ? <span className="lock-label">🔒 {otherLock.userName} 작성 중</span> : null}</div><input className="input" value={roles.get(role.userId) ?? ""} disabled={Boolean(lockedByOther)} onFocus={() => lock(fieldKey, "acquire")} onChange={(event) => setRoles((current) => new Map(current).set(role.userId, event.target.value))} onBlur={() => saveRole(role.userId, roles.get(role.userId) ?? "")} maxLength={2_000} placeholder="담당한 역할" /></td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>

        {REPORT_FIELDS.map((field) => {
          const otherLock = lockMap.get(field.key);
          const lockedByOther = otherLock && otherLock.userId !== currentUserId;
          return <div className="plan-field" key={field.key}>
            <ReportFieldHeading fieldKey={field.key} label={field.label} lockMap={lockMap} currentUserId={currentUserId} editing={editing} />
            <textarea className="textarea report-textarea" value={String(form[field.key] ?? "")} disabled={Boolean(lockedByOther)} onFocus={() => lock(field.key, "acquire")} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} onBlur={() => saveField(field.key, String(form[field.key] ?? ""))} maxLength={30_000} />
          </div>;
        })}
      </section>
      <aside className="card plan-side">
        <h3 className="section-heading">작성 안내</h3>
        <p className="section-subtitle">부록은 선택 항목입니다. 다른 항목과 팀원별 역할을 모두 작성한 뒤 제출하세요.</p>
        <div className="notice-box">{state || "항목에서 나가면 저장되며, 같은 항목은 한 명씩 편집할 수 있습니다."}</div>
        <button className="button full" onClick={submit} disabled={data.report.status === "submitted" || data.report.status === "reviewed"}>{data.report.status === "submitted" ? "선생님 확인 중" : data.report.status === "reviewed" ? "확인 완료" : "선생님께 제출"}</button>
        <DocumentHistoryPanel title="보고서" history={data.report.history} canRestore={data.team.leaderUserId === currentUserId} onRestore={restore} />
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
  return <div className="field-heading"><span className="label">{label}</span>{lockedByOther ? <span className="lock-label">🔒 {lockItem.userName} 작성 중</span> : editing === fieldKey ? <span className="save-state">작성 중</span> : null}</div>;
}
