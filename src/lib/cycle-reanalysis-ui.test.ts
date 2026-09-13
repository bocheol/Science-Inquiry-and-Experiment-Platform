import { expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CycleAnalysisPanel } from "@/components/cycle-analysis-panel";
import { getInquiryDataForUser } from "@/lib/inquiry-data";
import type { CycleAnalysisView } from "@/lib/cycle-analysis";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/toast-provider", () => ({ useToast: () => ({ showToast() {} }) }));
Object.assign(globalThis, { React });

it.each(["intermediate", "final"] as const)("offers reanalysis of stale %s evidence without enabling completion", async analysisType => {
  const data = (await getInquiryDataForUser("demo_student_1", "demo_team_1"))!;
  const cycle = data.session.cycles.find(cycle => cycle.status === "active")!;
  cycle.analysis = {
    id: "synthetic-analysis", analysisType, isCurrent: false, decisions: [],
    result: { overview: "합성 검토", inquiryField: "화학", researchType: "비교", strengths: [], findings: [], suggestions: [], cycleComparison: [], limitations: [] },
    documents: { plan: {formData: {}, configDefinition: {}}, report: {formData: {}, configDefinition: {}, memberRoles: []}, materialRequests: [] },
  } as unknown as CycleAnalysisView;
  const render = (audience: "teacher" | "student") => renderToStaticMarkup(React.createElement(CycleAnalysisPanel, {data, audience, currentUserId: "synthetic-user"}));
  const html = render("teacher");
  expect(html).toContain('class="button secondary">최신 자료로 다시 분석</button>');
  expect(html).toContain(`disabled="">${analysisType === "final" ? "전체 탐구 완료" : "다음 회차 시작"}</button>`);
  expect(render("student")).not.toContain("최신 자료로 다시 분석</button>");
  if (analysisType === "intermediate") expect(html).toContain("이 회차에서 최종 분석</button>");
  else expect(html).not.toContain("이 회차에서 최종 분석</button>");
  cycle.analysisHistory = [{...cycle.analysis, id:"previous", analysisType:"intermediate", createdAt:"2026-09-08T00:00:00Z", decisions:[]}];
  expect(render("teacher")).toContain("이전 분석과 학생 판단 보기");
  cycle.analysis.isCurrent = true;
  expect(render("teacher")).not.toContain("최신 자료로 다시 분석</button>");
});
