"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat-panel";
import { MaterialForm } from "@/components/material-form";
import { JournalPanel } from "@/components/journal-panel";
import { PlanEditor } from "@/components/plan-editor";
import { ReportEditor } from "@/components/report-editor";
import { ExamResultPanel } from "@/components/exam-result-panel";
import { EvaluationPanel } from "@/components/evaluation-panel";
import { useToast } from "@/components/toast-provider";
import type { InquiryData } from "@/lib/inquiry-data";
import { getStudentStageAccess } from "@/lib/student-stage-access";

type Tab = "chat" | "plan" | "materials" | "journal" | "report" | "exam" | "evaluation";

export function InquiryWorkspace({ initialData, currentUserId }: { initialData: InquiryData; currentUserId: string }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<Tab>("chat");
  const { showToast } = useToast();
  const stageAccess = getStudentStageAccess(data.plan.reviewStatus, Boolean(data.materials));
  const { journalAvailable, reportAvailable } = stageAccess;

  function openStudentTab(nextTab: Tab, available = true) {
    if (available) {
      setTab(nextTab);
      return;
    }
    if (nextTab === "journal") {
      showToast(stageAccess.journalLockedMessage ?? "실험 일지를 열 수 없습니다.", "info");
      return;
    }
    showToast(stageAccess.reportLockedMessage ?? "팀 보고서를 열 수 없습니다.", "info");
  }
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
  useEffect(() => {
    const openHash = () => {
      const requested = window.location.hash.slice(1);
      if (requested === "plan" || requested === "report") setTab(requested);
    };
    openHash();
    window.addEventListener("hashchange", openHash);
    return () => window.removeEventListener("hashchange", openHash);
  }, []);

  return (
    <div className="stack">
      <section className="team-banner">
        <div><h1>{data.team.classNumber}반 {data.team.name}</h1><p>{data.session.selectedTopic || "AI와 탐구 주제를 찾고 있어요"}</p></div>
        <div className="member-list">{data.members.map((member) => <span className="member-pill" key={member.id}>{member.isLeader ? "⭐ " : ""}{member.name}</span>)}</div>
      </section>
      <nav className="tabs" aria-label="탐구 메뉴">
        <a className="tab notice-tab-link" href="/notices">📢 공지·일정</a>
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>💬 이론 탐구</button>
        <button className={`tab ${tab === "plan" ? "active" : ""}`} onClick={() => setTab("plan")}>📝 탐구 계획</button>
        <button className={`tab ${tab === "materials" ? "active" : ""}`} onClick={() => setTab("materials")}>🧪 준비물 신청</button>
        <button className={`tab ${tab === "journal" ? "active" : ""}`} onClick={() => openStudentTab("journal", journalAvailable)} data-locked={!journalAvailable || undefined} aria-label={journalAvailable ? "실험 일지" : "실험 일지, 잠김, 눌러서 필요한 조건 확인"} title={journalAvailable ? "" : "필요한 조건을 안내받으려면 누르세요"}>📋 실험 일지</button>
        <button className={`tab ${tab === "report" ? "active" : ""}`} onClick={() => openStudentTab("report", reportAvailable)} data-locked={!reportAvailable || undefined} aria-label={reportAvailable ? "보고서" : "보고서, 잠김, 눌러서 필요한 조건 확인"} title={reportAvailable ? "" : "필요한 조건을 안내받으려면 누르세요"}>📄 보고서</button>
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
