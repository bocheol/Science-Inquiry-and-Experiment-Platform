import { expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getInquiryDataForUser } from "@/lib/inquiry-data";
import { TeacherReportReview } from "@/components/teacher-report-review";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/toast-provider", () => ({ useToast: () => ({ showToast() {} }) }));
// Match the JSX runtime used by isolated Vite rendering.
Object.assign(globalThis, { React });

it("renders the report's saved custom field definitions, table columns and false values", async () => {
  const data = (await getInquiryDataForUser("demo_student_1", "demo_team_1"))!;
  data.report.fields = [
    { id: "custom_heading", label: "고정된 보고서 양식", kind: "heading" },
    { id: "custom_observation", label: "맞춤 관찰", kind: "long_text" },
    { id: "custom_table", label: "측정 표", kind: "table", columns: [{id:"time",label:"측정 시각",kind:"short_text"},{id:"value",label:"측정값",kind:"number"}] },
    { id: "custom_check", label: "확인 여부", kind: "checkbox" },
  ];
  data.report.formData = { custom_observation: "보존된 맞춤 본문", custom_table: '[{"value":7,"time":"오전"}]', custom_check: "false" };
  const html = renderToStaticMarkup(React.createElement(TeacherReportReview, {data, currentUserId:"teacher_bootstrap", readOnly:true}));
  for (const text of ["고정된 보고서 양식", "맞춤 관찰", "보존된 맞춤 본문", "측정 시각", "측정값", "오전", "아니요"]) expect(html).toContain(text);
  expect(html).toContain("<td>오전</td><td>7</td>");
  expect(html).not.toContain("[object Object]");
  expect(html).not.toContain('id="report-feedback"');
});
