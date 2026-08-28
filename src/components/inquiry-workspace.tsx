"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat-panel";
import { MaterialForm } from "@/components/material-form";
import { JournalPanel } from "@/components/journal-panel";
import { PlanEditor } from "@/components/plan-editor";
import { ReportEditor } from "@/components/report-editor";
import { ExamResultPanel } from "@/components/exam-result-panel";
import { EvaluationPanel } from "@/components/evaluation-panel";
import type { InquiryData } from "@/lib/inquiry-data";

type Tab = "chat" | "plan" | "materials" | "journal" | "report" | "exam" | "evaluation";

export function InquiryWorkspace({ initialData, currentUserId }: { initialData: InquiryData; currentUserId: string }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<Tab>("chat");
  const journalAvailable = ["EXPERIMENTING", "REPORTING", "EXAMINING", "EVALUATING", "COMPLETED"].includes(data.session.stage);
  const reportAvailable = journalAvailable;
  const refresh = useCallback(async () => {
    const response = await fetch("/api/inquiry", { cache: "no-store" });
    if (!response.ok) return;
    const result = (await response.json()) as { data: InquiryData | null };
    if (result.data) setData(result.data);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="stack">
      <section className="team-banner">
        <div><h1>{data.team.classNumber}반 {data.team.name}</h1><p>{data.session.selectedTopic || "AI와 탐구 주제를 찾고 있어요"}</p></div>
        <div className="member-list">{data.members.map((member) => <span className="member-pill" key={member.id}>{member.isLeader ? "⭐ " : ""}{member.name}</span>)}</div>
      </section>
      <nav className="tabs" aria-label="탐구 메뉴">
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>💬 이론 탐구</button>
        <button className={`tab ${tab === "plan" ? "active" : ""}`} onClick={() => setTab("plan")}>📝 탐구 계획</button>
        <button className={`tab ${tab === "materials" ? "active" : ""}`} onClick={() => setTab("materials")}>🧪 준비물 신청</button>
        <button className={`tab ${tab === "journal" ? "active" : ""}`} onClick={() => setTab("journal")} disabled={!journalAvailable} title={journalAvailable ? "" : "탐구 계획 승인 후 열립니다"}>📋 실험 일지</button>
        <button className={`tab ${tab === "report" ? "active" : ""}`} onClick={() => setTab("report")} disabled={!reportAvailable} title={reportAvailable ? "" : "탐구 계획 승인 후 열립니다"}>📄 보고서</button>
        <button className={`tab ${tab === "exam" ? "active" : ""}`} onClick={() => setTab("exam")}>🎤 시험 결과</button>
        <button className={`tab ${tab === "evaluation" ? "active" : ""}`} onClick={() => setTab("evaluation")}>⭐ 자기·동료평가</button>
      </nav>
      <div className="card workspace-panel">
        {tab === "chat" ? <ChatPanel data={data} onRefresh={refresh} /> : null}
        {tab === "plan" ? <PlanEditor data={data} currentUserId={currentUserId} onRefresh={refresh} /> : null}
        {tab === "materials" ? <MaterialForm data={data} onRefresh={refresh} /> : null}
        {tab === "journal" ? <JournalPanel sessionId={data.session.id} currentUserId={currentUserId} /> : null}
        {tab === "report" ? <ReportEditor data={data} currentUserId={currentUserId} onRefresh={refresh} /> : null}
        {tab === "exam" ? <ExamResultPanel /> : null}
        {tab === "evaluation" ? <EvaluationPanel /> : null}
      </div>
    </div>
  );
}
