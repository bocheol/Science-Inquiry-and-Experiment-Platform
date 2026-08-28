export const ACADEMIC_YEAR = Number(process.env.ACADEMIC_YEAR ?? 2026);
export const SESSION_COOKIE = "science_inquiry_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
export const MATERIAL_BUDGET_WON = 50_000;

export const PLAN_FIELDS = [
  { key: "field", label: "탐구 분야", kind: "select" },
  { key: "topic", label: "탐구 주제", kind: "text" },
  { key: "motivation", label: "연구 동기", kind: "textarea" },
  { key: "purpose", label: "연구 목적", kind: "textarea" },
  { key: "theory", label: "이론적 배경과 출처", kind: "textarea" },
  { key: "priorResearch", label: "선행 연구 조사와 참고문헌", kind: "textarea" },
  { key: "method", label: "구체적인 탐구 방법", kind: "textarea" },
  { key: "differentiation", label: "선행 연구와 차별화된 점", kind: "textarea" },
  { key: "schedule", label: "연구 실행 일정", kind: "schedule" },
  { key: "expectedResult", label: "예상 연구 결과 및 기대효과", kind: "textarea" },
  { key: "references", label: "참고문헌", kind: "textarea" },
] as const;

export const INQUIRY_FIELDS = [
  "물리",
  "화학",
  "식물",
  "동물",
  "지구과학",
  "농림수산",
  "공학",
  "에너지",
  "환경",
  "발명",
  "빅데이터",
  "기타",
] as const;

export const REPORT_FIELDS = [
  { key: "purpose", label: "Ⅰ-1. 연구목적" },
  { key: "terms", label: "Ⅰ-2. 용어정의" },
  { key: "background", label: "Ⅰ-3. 이론적 배경(선행연구)" },
  { key: "researchPlanSchedule", label: "Ⅱ-1. 연구 계획 및 일정" },
  { key: "experimentMethod", label: "Ⅱ-2. 실험 과정 및 방법" },
  { key: "data", label: "Ⅲ-1. 자료정리" },
  { key: "analysis", label: "Ⅲ-2. 결과분석 및 고찰" },
  { key: "conclusion", label: "Ⅳ. 결론" },
  { key: "references", label: "Ⅴ. 참고문헌" },
  { key: "appendix", label: "Ⅵ. 부록" },
] as const;
