"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InquiryData } from "@/lib/inquiry-data";
import { useToast } from "@/components/toast-provider";

function dateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

export function TeacherCycleSettings({ cycle }: { cycle: NonNullable<InquiryData["session"]["cycle"]> }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [title, setTitle] = useState(cycle.title);
  const [startDate, setStartDate] = useState(dateInput(cycle.startedAt));
  const [endDate, setEndDate] = useState(dateInput(cycle.endedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/teacher/cycles", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: cycle.id, title, startDate: startDate || null, endDate: endDate || null }),
    });
    const result = (await response.json()) as { message?: string };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "회차 설정을 저장하지 못했습니다.";
      setError(message);
      showToast(message, "error");
      return;
    }
    showToast("탐구 회차 안내를 저장했습니다.");
    router.refresh();
  }

  return (
    <section className="card card-body">
      <div className="toolbar"><div><h2 className="section-heading">탐구 회차 안내</h2><p className="section-subtitle">과탐실과 동아리에서 같은 구조를 사용합니다. 기존 자료는 선생님이 의미를 확인하기 전 자동으로 최종본 처리하지 않습니다.</p></div><span className="badge">{cycle.ordinal}번째 회차</span></div>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="grid three">
        <label className="label">회차 이름<input className="input" value={title} maxLength={60} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="label">시작일<input className="input" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label className="label">종료일<input className="input" type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label>
      </div>
      <button className="button secondary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "저장 중…" : "회차 안내 저장"}</button>
    </section>
  );
}
