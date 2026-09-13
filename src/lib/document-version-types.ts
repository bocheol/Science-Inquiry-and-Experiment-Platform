import type { FormFieldDefinition } from "@/lib/club-settings";

export type DocumentScope = { documentType: "plan" | "report"; documentId: string; cycleId: string };
export type VersionRef = { kind: "current" | "revision" | "cycle_final"; id?: string };
export type VersionOption = { ref: VersionRef; label: string; eventAt: string | null; actorName?: string };
export type DocumentVersion = VersionOption & {
  sourceKey: string;
  fingerprint: string;
  capturedAt: string;
  fields: FormFieldDefinition[];
  definitionVerified: boolean;
  values: Record<string, unknown>;
  roles: Array<{ userId: string; label: string; description: string }>;
  status: string | null;
  feedback: string | null;
  issues: string[];
  valid: boolean;
  unreadableSource?: unknown;
};
export type VersionList = {
  scope: DocumentScope;
  teamName: string;
  cycleTitle: string;
  fixed: VersionOption[];
  history: VersionOption[];
  nextCursor: string | null;
};
export type VersionComparison = { scope: DocumentScope; a: DocumentVersion; b: DocumentVersion };
export function versionKey(ref: VersionRef) { return `${ref.kind}:${ref.id ?? ""}`; }
export function versionActionLabel(action: string) {
  if (action.startsWith("field:")) return "항목 수정 직전";
  if (action.startsWith("role:")) return "팀원 역할 수정 직전";
  return ({ submit: "제출 직전", teacher_approve: "교사 승인 직전", teacher_feedback: "교사 피드백 직전",
    teacher_review: "교사 확인 직전", restore_previous_state: "이전 복원 직전",
    cycle_completed: "이 회차 최종 보존본", exam_evidence_capture: "시험 근거로 고정한 확인 보고서" } as Record<string, string>)[action] ?? "변경 직전";
}
export function versionTime(value: string | null) {
  if (!value) return "시각 확인 불가";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "시각 확인 불가";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}
