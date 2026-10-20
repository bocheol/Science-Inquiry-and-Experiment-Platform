import { z } from "zod";

export const RECORD_BYTE_LIMIT = 1500;
export const ACTIVITY_CHAR_LIMIT = 300;
export const RECORD_ACTIVITIES = [
  { id: "individual_plan", label: "개별 탐구 계획", course: 1 },
  { id: "microscope", label: "현미경", course: 1 },
  { id: "egg", label: "달걀", course: 1 },
  { id: "spectrum", label: "스펙트럼", course: 1 },
  { id: "neutralization", label: "중화열", course: 1 },
  { id: "team_plan", label: "팀 계획서", course: 2 },
  { id: "journal", label: "개별 일지", course: 2 },
  { id: "team_report", label: "팀 보고서·나의 역할", course: 2 },
  { id: "exam", label: "개별 시험", course: 2 },
] as const;
export const ACTIVITY_IDS = RECORD_ACTIVITIES.map(a => a.id);
export type ActivityId = typeof RECORD_ACTIVITIES[number]["id"];
export const COURSE_TWO_GROUPS = ["team_plan", "journal", "team_report", "exam"] as const;
export const activitySchema = z.enum(["individual_plan", "microscope", "egg", "spectrum", "neutralization", "team_plan", "journal", "team_report", "exam"]);
export const text300 = z.string().refine(s => Array.from(s).length <= ACTIVITY_CHAR_LIMIT, "활동별 설명은 300자까지 적을 수 있습니다.");
export const submissionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  selected: z.array(activitySchema).max(3).refine(ids => new Set(ids).size === ids.length && ids.every(id => RECORD_ACTIVITIES.find(a => a.id === id)?.course === 1), "과탐실 1 활동만 중복 없이 선택해 주세요."),
  comments: z.partialRecord(activitySchema, text300),
  submit: z.boolean(),
}).refine(s => !s.submit || s.selected.length >= 2, "제출할 때 과탐실 1 활동을 2~3개 선택해 주세요.");

export const normalizeRecordText = (text: string) => text.replace(/\r\n?/g, "\n");
export const recordBytes = (text: string) => new TextEncoder().encode(normalizeRecordText(text)).length;
export const combinedRecordBytes = (one: string, two: string) => recordBytes(one) + recordBytes(two);
export const draftSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  expectedSubmissionRevision: z.number().int().nonnegative(),
  expectedEvidenceHash: z.string().length(64),
  course1: z.string().max(8000).transform(normalizeRecordText),
  course2: z.string().max(8000).transform(normalizeRecordText),
  notes: z.string().max(10000),
  checkedGroups: z.array(z.enum(COURSE_TWO_GROUPS)).max(4),
  finalize: z.boolean(),
}).refine(d => !d.finalize || combinedRecordBytes(d.course1, d.course2) <= RECORD_BYTE_LIMIT, "두 과목 합계가 1,500바이트를 넘습니다.")
  .refine(d => !d.finalize || COURSE_TWO_GROUPS.every(g => d.checkedGroups.includes(g)), "과탐실 2의 네 자료 묶음을 모두 확인해 주세요. 자료가 없으면 미확인 사유를 교사 메모에 남겨 주세요.");

export type RecordSubmission = { studentId: string; revision: number; selected: ActivityId[]; comments: Partial<Record<ActivityId, string>>; status: string; returnedNote: string; reopenedUntil: string | null };
export type RecordFile = { id: string; activity: ActivityId; course: 1 | 2; name: string; mime: string; size: number; revision: number; extractionStatus: string; text: string; extractionNote: string; driveStatus: string; createdAt: string; included: boolean };
export type RecordSettings = { revision: number; style: string; opensAt: string | null; deadlineAt: string | null; spreadsheetId: string; folderId: string };
export type RecordStudent = { id: string; name: string; loginId: string; classNumber: number; status: string; submissionStatus: string; draftStatus: string };
export type RecordEvidence = { id: string; course: 1 | 2; activity: ActivityId; label: string; text: string; kind: "plan" | "student_statement" | "team_document" | "individual_record" | "exam_feedback" | "discussion"; sourceUrl: string; confirmed: boolean; attachments?: { label: string; url: string }[] };
export type EvidenceBundle = { sources: RecordEvidence[]; missing: string[]; hash: string; collectedAt: string };
export type RecordDraft = { revision: number; course1: string; course2: string; notes: string; checkedGroups: string[]; status: string; sourceRevision: number; evidence: EvidenceBundle | null; ai: RecordAiResult | null };
export type RecordAiResult = { course1: string; course2: string; claims: { course: 1 | 2; text: string; evidenceIds: string[] }[]; warnings: string[] };
export type RecordWorkspace = { student: RecordStudent; submission: RecordSubmission; files: RecordFile[]; settings: RecordSettings; draft?: RecordDraft; evidence?: EvidenceBundle };

// A suggestion only. The uploader must confirm the student before any file is saved.
export function suggestStudentFromFilename(filename: string, students: Pick<RecordStudent, "id" | "name" | "loginId">[]) {
  const normalized = filename.normalize("NFKC");
  const numberMatches = students.filter(s => new RegExp("(?:^|[^0-9])" + s.loginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9])").test(normalized));
  if (numberMatches.length === 1) return numberMatches[0].id;
  const names = students.filter(s => s.name.length >= 2 && normalized.includes(s.name));
  return names.length === 1 ? names[0].id : "";
}
