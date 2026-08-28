import * as XLSX from "xlsx";
import type { TeacherDashboardData } from "@/lib/teacher-data";

const planLabels: Record<string, string> = {
  draft: "작성 중", pending: "승인 대기", feedback: "수정 요청", approved: "승인", reapproval_required: "재승인 필요",
};
const reportLabels: Record<string, string> = {
  draft: "작성 중", submitted: "검토 대기", feedback: "수정 요청", reviewed: "확인 완료",
};
const materialLabels: Record<string, string> = { pending: "전송 대기", synced: "시트 반영", failed: "전송 실패" };
const teamHeaders = ["학급", "팀", "인원", "탐구주제", "질문수", "계획서", "일지작성학생", "일지전체학생", "일지건수", "보고서", "준비물", "확인필요", "최근활동"];
const studentHeaders = ["학급", "학번", "이름", "팀", "역할", "일지건수", "최근일지"];

function label(labels: Record<string, string>, value: string | null) {
  return value ? labels[value] ?? value : "시작 전";
}

function safeCell(value: string | number | null) {
  if (typeof value !== "string") return value ?? "";
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function localDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function teamProgressRows(data: TeacherDashboardData, classNumber?: number) {
  return data.teams
    .filter((team) => !classNumber || team.classNumber === classNumber)
    .map((team) => ({
      학급: team.classNumber,
      팀: safeCell(team.name),
      인원: team.memberCount,
      탐구주제: safeCell(team.topic || "주제 탐색 중"),
      질문수: team.messageCount,
      계획서: label(planLabels, team.planStatus),
      일지작성학생: team.journalStudentCount,
      일지전체학생: team.memberCount,
      일지건수: team.journalEntryCount,
      보고서: label(reportLabels, team.reportStatus),
      준비물: label(materialLabels, team.materialSyncStatus),
      확인필요: safeCell(team.attentionReasons.join(", ") || "없음"),
      최근활동: localDate(team.lastActivityAt),
    }));
}

export function studentProgressRows(data: TeacherDashboardData, classNumber?: number) {
  return data.students
    .filter((student) => !classNumber || student.classNumber === classNumber)
    .map((student) => ({
      학급: student.classNumber,
      학번: safeCell(student.loginId),
      이름: safeCell(student.name),
      팀: safeCell(student.teamNumber ? `${student.teamNumber}조` : "미배정"),
      역할: student.isLeader ? "팀장" : student.teamId ? "팀원" : "미배정",
      일지건수: student.journalCount,
      최근일지: localDate(student.lastJournalDate),
    }));
}

function sizeSheet(sheet: XLSX.WorkSheet, widths: number[]) {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] };
}

export function buildTeacherProgressExport(data: TeacherDashboardData, format: "xlsx" | "csv", classNumber?: number) {
  const teamSheet = XLSX.utils.json_to_sheet(teamProgressRows(data, classNumber), { header: teamHeaders });
  sizeSheet(teamSheet, [7, 12, 7, 34, 9, 12, 13, 13, 10, 12, 12, 30, 20]);

  if (format === "csv") return Buffer.from(`\uFEFF${XLSX.utils.sheet_to_csv(teamSheet)}`, "utf8");

  const studentSheet = XLSX.utils.json_to_sheet(studentProgressRows(data, classNumber), { header: studentHeaders });
  sizeSheet(studentSheet, [7, 13, 12, 10, 10, 10, 20]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, teamSheet, "팀 진척");
  XLSX.utils.book_append_sheet(workbook, studentSheet, "학생 일지 현황");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
