"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MaterialRequestView } from "@/lib/inquiry-data";
import { PRACTICE_MATERIAL_LABEL } from "@/lib/material-practice";
import { useToast } from "@/components/toast-provider";

// Use identical text on the server and browser; locale formatting differs
// between Node and browser ICU versions even with an explicit time zone.
function submittedTime(value: string) {
  return `${new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")} (한국 시간)`;
}

export function TeacherMaterialReview({ latest, pending = [], readOnly }: {
  latest: MaterialRequestView | null; pending?: MaterialRequestView[]; readOnly: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const older = pending.filter(item => item.id !== latest?.id && item.syncStatus !== "synced" && !item.isPractice);

  async function retry(item: MaterialRequestView) {
    if (request.current || readOnly || item.isPractice || item.syncStatus === "synced") return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(item.id); setError("");
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("/api/teacher/materials/retry", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ requestId: item.id }),
      });
      const result = await response.json() as { ok?: boolean; message?: string; syncStatus?: string; syncError?: string };
      if (!mounted.current) return;
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? "재전송 결과를 확인하지 못했습니다.");
      if (result.syncStatus !== "synced") throw new Error(result.syncError ?? "신청은 보존되어 있습니다. 전송 상태를 확인한 뒤 다시 시도해 주세요.");
      showToast("Google Sheet에 반영했습니다.");
      router.refresh();
    } catch (caught) {
      if (!mounted.current) return;
      const message = caught instanceof TypeError || caught instanceof SyntaxError || (caught instanceof Error && caught.name === "AbortError")
        ? "연결이 끊겼거나 응답을 확인하지 못했습니다. 신청은 보존되어 있습니다. 같은 신청의 전송 상태를 다시 확인해 주세요."
        : caught instanceof Error ? caught.message : "재전송하지 못했습니다.";
      setError(message); showToast(message, "error");
    } finally {
      window.clearTimeout(timer);
      request.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  function content(item: MaterialRequestView) {
    return <>
      <span className={`badge ${item.syncStatus === "failed" ? "feedback" : ""}`}>{item.isPractice ? PRACTICE_MATERIAL_LABEL : item.syncStatus === "synced" ? "시트 반영" : item.syncStatus === "failed" ? "전송 실패" : "전송 대기"}</span>
      {item.submittedAt ? <p className="section-subtitle">신청 시각: {submittedTime(item.submittedAt)}</p> : null}
      <p>합계 <b>{item.totalAmount.toLocaleString()}원</b></p>
      <ul>{item.items.map((value, index) => <li key={index}>{value.name}{value.specification ? ` (${value.specification})` : ""} · {value.quantity}개 · {(value.unitPrice * value.quantity + value.shipping).toLocaleString()}원{value.link ? <p style={{ overflowWrap: "anywhere" }}>{value.link}</p> : null}</li>)}</ul>
      {item.syncError ? <div className="warning-box">{item.syncError}</div> : null}
      {!readOnly && !item.isPractice && item.syncStatus !== "synced" ? <button className="button ghost" onClick={() => retry(item)} disabled={busy !== null}>{busy === item.id ? "전송 확인 중…" : "Google Sheet 재전송"}</button> : null}
    </>;
  }

  return <article className="card card-body" aria-label="준비물 신청 검토">
    <h2 className="section-heading">준비물 신청</h2>
    {error ? <div className="warning-box" role="alert">{error}</div> : null}
    {latest ? <section aria-label="최근 준비물 신청">{content(latest)}</section> : <div className="empty-state">신청 내용이 없습니다.</div>}
    {older.length ? <section aria-label="이전 미전송 신청">
      <h3>이전 미전송 신청 {older.length}건</h3>
      <p className="section-subtitle">현재 회차에 남아 있는 신청입니다. 신청 당시 내용과 시트 기록을 대조한 뒤 각 신청의 전송 상태를 확인해 주세요.</p>
      {older.map((item, index) => <details key={item.id}>
        <summary>미전송 신청 {index + 1} · {item.items[0]?.name ?? "품목 확인"} · {item.totalAmount.toLocaleString()}원</summary>
        {content(item)}
      </details>)}
    </section> : null}
  </article>;
}
