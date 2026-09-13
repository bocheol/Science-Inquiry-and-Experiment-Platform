"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { DiscussionPanel } from "@/components/discussion-panel";
import { ClubCustomTabPanel } from "@/components/club-custom-tab-panel";
import { CycleAnalysisPanel } from "@/components/cycle-analysis-panel";
import { ReadOnlyCycleDocument } from "@/components/read-only-cycle-document";
import { PastRecordsPanel } from "@/components/past-records-panel";

type Tab = "chat" | "records" | "plan" | "materials" | "journal" | "report" | "exam" | "evaluation" | `custom:${string}`;

export function InquiryWorkspace({ initialData, currentUserId }: { initialData: InquiryData; currentUserId: string }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<Tab>("chat");
  const [openedEditors, setOpenedEditors] = useState({ plan: false, report: false, journal: false });
  const refreshSequence = useRef(0);
  const { showToast } = useToast();
  const stageAccess = getStudentStageAccess(data.plan.reviewStatus, Boolean(data.materials) || Boolean(data.team.clubId));
  const { journalAvailable, reportAvailable } = stageAccess;
  const cycleReadOnly = Boolean(data.session.cycle && data.session.cycle.status !== "active");

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
    const sequence = ++refreshSequence.current;
    const response = await fetch(`/api/inquiry?team=${encodeURIComponent(initialData.team.id)}`, { cache: "no-store" });
    if (!response.ok) return;
    const result = (await response.json()) as { data: InquiryData | null };
    if (result.data && sequence === refreshSequence.current) setData(result.data);
  }, [initialData.team.id]);
  useEffect(() => {
    let refreshing = false;
    const timer = window.setInterval(async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try { await refresh(); } catch { /* Keep the current screen and drafts on a network failure. */ } finally { refreshing = false; }
    }, tab === 'records' ? 30_000 : 4_000);
    return () => window.clearInterval(timer);
  }, [refresh, tab]);
  useEffect(() => {
    if (tab === "plan" || tab === "report" || tab === "journal") setOpenedEditors((current) => ({ ...current, [tab]: true }));
  }, [tab]);
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
        <div><h1>{data.team.activityName ?? `${data.team.classNumber}반`} · {data.team.name}</h1><p>{data.session.selectedTopic || "AI와 탐구 주제를 찾고 있어요"}</p>{data.session.cycle ? <small>{data.session.cycle.origin === "legacy_unclassified" ? "기존 탐구 자료" : data.session.cycle.title}</small> : null}</div>
        <div className="member-list">{data.members.map((member) => <span className="member-pill" key={member.id}>{member.isLeader ? "⭐ " : ""}{member.name}</span>)}</div>
      </section>
      <PastRecordsPanel audience="student" teamId={data.team.id} />
      <CycleAnalysisPanel data={data} audience="student" currentUserId={currentUserId} />
      <nav className="tabs" aria-label="탐구 메뉴">
        <a className="tab notice-tab-link" href="/notices">📢 공지·일정</a>
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>💬 이론 탐구</button>
        <button className={`tab ${tab === "records" ? "active" : ""}`} onClick={() => setTab("records")}>🗨 대화·활동 기록</button>
        <button className={`tab ${tab === "plan" ? "active" : ""}`} onClick={() => setTab("plan")}>📝 탐구 계획</button>
        {!data.team.clubId || data.clubFeatures.materials ? <button className={`tab ${tab === "materials" ? "active" : ""}`} onClick={() => setTab("materials")}>🧪 준비물 신청</button> : null}
        <button className={`tab ${tab === "journal" ? "active" : ""}`} onClick={() => openStudentTab("journal", cycleReadOnly || journalAvailable)} data-locked={!cycleReadOnly && !journalAvailable || undefined} aria-label={cycleReadOnly || journalAvailable ? "실험 일지" : "실험 일지, 잠김, 눌러서 필요한 조건 확인"} title={cycleReadOnly || journalAvailable ? "" : "필요한 조건을 안내받으려면 누르세요"}>📋 실험 일지</button>
        <button className={`tab ${tab === "report" ? "active" : ""}`} onClick={() => openStudentTab("report", cycleReadOnly || reportAvailable)} data-locked={!cycleReadOnly && !reportAvailable || undefined} aria-label={cycleReadOnly || reportAvailable ? "보고서" : "보고서, 잠김, 눌러서 필요한 조건 확인"} title={cycleReadOnly || reportAvailable ? "" : "필요한 조건을 안내받으려면 누르세요"}>📄 보고서</button>
        {!data.team.clubId || data.clubFeatures.exam ? <button className={`tab ${tab === "exam" ? "active" : ""}`} onClick={() => setTab("exam")}>🎤 시험 결과</button> : null}
        {!data.team.clubId || (data.clubFeatures.selfEvaluation && data.clubFeatures.peerEvaluation) ? <button className={`tab ${tab === "evaluation" ? "active" : ""}`} onClick={() => setTab("evaluation")}>⭐ 자기·동료평가</button> : null}
        {data.customTabs.map((customTab) => <button key={customTab.id} className={`tab ${tab === `custom:${customTab.id}` ? "active" : ""}`} onClick={() => setTab(`custom:${customTab.id}`)}>📌 {customTab.title}</button>)}
      </nav>
      <div className="card workspace-panel">
        <div hidden={tab !== "records"}><DiscussionPanel key={data.session.cycle?.id ?? "uncategorized"} sessionId={data.session.id} cycleId={data.session.cycle?.id} currentUserId={currentUserId} members={data.members} readOnly={data.session.cycle?.status === "completed"} active={tab === "records"} /></div>
        {tab === "chat" ? <ChatPanel key={`${currentUserId}:${data.session.cycle?.id}`} data={data} currentUserId={currentUserId} onRefresh={refresh} /> : null}
        {tab === "plan" || openedEditors.plan ? <div hidden={tab !== "plan"}>{cycleReadOnly ? <ReadOnlyCycleDocument scope={{ documentType: "plan", documentId: data.plan.id, cycleId: data.session.cycle!.id }} title="팀 탐구 계획서" description={data.plan.description} fields={data.plan.fields} formData={data.plan.formData} /> : <PlanEditor key={`${currentUserId}:${data.plan.id}:${data.session.cycle?.id ?? "none"}:${data.plan.configVersionId ?? "default"}`} data={data} currentUserId={currentUserId} onRefresh={refresh} />}</div> : null}
        {tab === "materials" ? cycleReadOnly ? <div className="notice-box">완료된 회차의 준비물 신청은 위의 탐구 회차 기록에 고정되어 있습니다.</div> : <MaterialForm key={data.session.cycle?.id ?? data.session.id} data={data} currentUserId={currentUserId} onRefresh={refresh} /> : null}
        {tab === "journal" || openedEditors.journal ? <div hidden={tab !== "journal"}>{cycleReadOnly ? <div className="notice-box">완료된 회차의 실험 일지는 변경할 수 없습니다.</div> : data.session.cycle ? <JournalPanel key={data.session.cycle.id} sessionId={data.session.id} cycleId={data.session.cycle.id} currentUserId={currentUserId} /> : null}</div> : null}
        {tab === "report" || openedEditors.report ? <div hidden={tab !== "report"}>{cycleReadOnly ? <ReadOnlyCycleDocument scope={{ documentType: "report", documentId: data.report.id, cycleId: data.session.cycle!.id }} title="팀 최종보고서" description={data.report.description} fields={data.report.fields} formData={data.report.formData} roles={data.report.roles} /> : <ReportEditor key={`${currentUserId}:${data.report.id}:${data.session.cycle?.id ?? "none"}:${data.report.configVersionId ?? "default"}`} data={data} currentUserId={currentUserId} onRefresh={refresh} />}</div> : null}
        {tab === "exam" ? <ExamResultPanel teamId={data.team.id} /> : null}
        {tab === "evaluation" ? <EvaluationPanel key={`${currentUserId}:${data.team.id}`} teamId={data.team.id} currentUserId={currentUserId} /> : null}
        {data.customTabs.map((customTab) => tab === `custom:${customTab.id}` ? <ClubCustomTabPanel key={`${currentUserId}:${data.session.id}:${customTab.id}`} tab={customTab} sessionId={data.session.id} currentUserId={currentUserId} /> : null)}
      </div>
    </div>
  );
}
