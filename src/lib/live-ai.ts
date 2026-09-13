import type { FormFieldDefinition } from "@/lib/club-settings";
import { getDiscussionData } from "@/lib/discussions";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";
import { studentTextRedactor } from "@/lib/student-privacy";
import type { SessionUser } from "@/lib/types";
import { assertDiscussionAccess, DiscussionError, seoulDate } from "@/lib/discussions";

const CONTEXT_MAX_CHARS = 48_000;

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "내용 없음";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(" | ");
  try { return JSON.stringify(value); } catch { return String(value); }
}

function documentText(title: string, fields: FormFieldDefinition[], formData: Record<string, unknown>, feedback: string | null) {
  const lines = fields
    .filter(field => field.kind !== "heading")
    .map(field => `${field.label}: ${valueText(formData[field.id])}`);
  return [`[${title}]`, ...lines, `교사 피드백: ${feedback?.trim() || "내용 없음"}`].join("\n");
}

export function composeLiveAiInstructions(reference: string) {
  return `당신은 고등학교 과학탐구실험 중 학생 조와 음성으로 대화하는 Live AI 조력자입니다.

절대 규칙:
1. 평소 답변은 한국어 1~3문장으로 짧게 하세요. 학생이 추가 설명을 요청하면 그때만 확장하세요.
2. 질문이나 상황이 불명확하면 추측하지 말고 한 가지 확인 질문을 하세요.
3. 학생이 말하는 중에는 끼어들지 마세요. 학생 발화가 완전히 끝난 뒤 답하세요.
4. 제공된 참고 자료에 없는 사실을 학생이 했다고 단정하지 마세요.
5. 계획서·보고서·교사 피드백·팀 공동 활동 정리만 참고하세요. 개인 일지는 제공되지 않으며 요청받아도 접근할 수 없다고 답하세요.
6. 완성된 계획서·보고서·결론을 대신 작성하지 말고, 관찰·측정·변인·안전 점검을 돕는 짧은 질문이나 힌트를 주세요.
7. 위험한 화학물질, 불꽃·폭발·고전압·고압, 병원성 미생물, 인체 섭취·적용이 관련되면 절차보다 위험을 먼저 말하고 교사 확인을 요청하세요.
8. 학생의 실명·학번·연락처를 요구하거나 반복하지 마세요.

아래는 현재 조에 공개된 참고 자료입니다.
${reference}`;
}

export async function buildLiveAiSessionContext(actor: SessionUser, sessionId: string, cycleId: string) {
  if (actor.role !== "student" || actor.mustChangePassword) throw new DiscussionError("권한이 없습니다.", 403);
  const teamId = await assertDiscussionAccess(actor, sessionId, true);
  const data = await getInquiryDataForTeam(teamId);
  if (!data || data.session.id !== sessionId || data.session.cycle?.id !== cycleId || data.session.cycle.status !== "active") {
    throw new DiscussionError("현재 진행 중인 탐구 회차를 확인해 주세요.", 409);
  }
  const discussion = await getDiscussionData(actor, sessionId, seoulDate(), cycleId);
  const sharedHistory = discussion.history.slice(0, 12).map(day => {
    const items = day.items.map(item => `${item.category}: ${item.text}`).join(" / ");
    return `${day.activityDate}: ${items || "정리 없음"}`;
  });
  const rawReference = [
    `[현재 탐구]\n회차: ${data.session.cycle.title}\n주제: ${data.session.selectedTopic || "내용 없음"}`,
    documentText("최신 팀 계획서", data.plan.fields, data.plan.formData, data.plan.teacherFeedback),
    documentText("최신 팀 보고서", data.report.fields, data.report.formData, data.report.teacherFeedback),
    `[팀 공동 활동 정리]\n${sharedHistory.length ? sharedHistory.join("\n") : "내용 없음"}`,
  ].join("\n\n");
  const { redact } = await studentTextRedactor();
  const reference = redact(rawReference).slice(0, CONTEXT_MAX_CHARS);
  return { teamId, instructions: composeLiveAiInstructions(reference) };
}
