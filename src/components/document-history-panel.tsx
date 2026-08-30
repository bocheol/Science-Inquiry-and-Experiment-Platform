"use client";

import { useState } from "react";
import { useToast } from "@/components/toast-provider";

type HistoryItem = { id: string; action: string; actorName: string; createdAt: string };

const actionLabels: Record<string, string> = {
  submit: "제출 전 상태",
  teacher_approve: "교사 승인 전 상태",
  teacher_feedback: "교사 피드백 전 상태",
  teacher_review: "교사 확인 전 상태",
  restore_previous_state: "이전 복원 전 상태",
};

function actionLabel(action: string) {
  if (action.startsWith("field:")) return "항목 수정 전 상태";
  if (action.startsWith("role:")) return "팀원 역할 수정 전 상태";
  return actionLabels[action] ?? "변경 전 상태";
}

export function DocumentHistoryPanel({
  title,
  history,
  canRestore,
  onRestore,
}: {
  title: string;
  history: HistoryItem[];
  canRestore: boolean;
  onRestore: (revisionId: string) => Promise<void>;
}) {
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function restore(item: HistoryItem) {
    if (!window.confirm(`${item.actorName}님의 ${actionLabel(item.action)}로 복원할까요? 복원 직전 상태도 이력에 남습니다.`)) return;
    setBusyId(item.id);
    setError("");
    try { await onRestore(item.id); }
    catch (caught) {
      const text = caught instanceof Error ? caught.message : "복원하지 못했습니다.";
      setError(text); showToast(text, "error");
    }
    finally { setBusyId(null); }
  }

  return <section className="document-history">
    <div className="toolbar"><h3 className="section-heading">{title} 변경 이력</h3><span className="badge">최근 {history.length}건</span></div>
    <p className="section-subtitle">각 항목을 저장하기 직전의 전체 문서 상태입니다. 복원 직전 상태도 새 이력으로 남습니다.</p>
    {!canRestore ? <div className="notice-box">이력은 볼 수 있지만 복원은 현재 팀장과 교사만 할 수 있습니다.</div> : null}
    {error ? <div className="error-box" role="alert">{error}</div> : null}
    <div className="history-list">
      {history.map((item) => <div className="history-item" key={item.id}>
        <div><strong>{actionLabel(item.action)}</strong><span>{item.actorName} · {new Date(item.createdAt).toLocaleString("ko-KR")}</span></div>
        {canRestore ? <button className="button ghost" disabled={Boolean(busyId)} onClick={() => void restore(item)}>{busyId === item.id ? "복원 중…" : "이 상태로 복원"}</button> : null}
      </div>)}
      {!history.length ? <div className="empty-state">아직 복원할 변경 이력이 없습니다.</div> : null}
    </div>
  </section>;
}
