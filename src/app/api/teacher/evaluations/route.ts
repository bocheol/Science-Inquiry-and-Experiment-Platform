import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { getCurrentUser } from "@/lib/auth";
import {
  changeEvaluationRoundStatus,
  createClubEvaluationRound,
  createEvaluationRound,
  EvaluationServiceError,
  getEvaluationManagementData,
  getClubEvaluationManagementData,
  publishEvaluationRound,
  reviewPeerComment,
  saveEvaluationTeacherSummary,
  updateEvaluationTemplate,
} from "@/lib/evaluation-service";

const levelTexts = z.object({
  "1": z.string().min(1).max(500),
  "2": z.string().min(1).max(500),
  "3": z.string().min(1).max(500),
  "4": z.string().min(1).max(500),
});
const itemSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,60}$/i),
  prompt: z.string().min(1).max(160),
  levels: levelTexts,
  optional: z.boolean().optional(),
});
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    classNumber: z.number().int().min(1).max(9).optional(),
    clubId: z.string().min(1).optional(),
    title: z.string().min(1).max(100),
    optionalItem: z.enum(["none", "safety", "theory"]),
  }),
  z.object({ action: z.literal("updateTemplate"), roundId: z.string().min(1).max(200), title: z.string().min(1).max(100), items: z.array(itemSchema).min(4).max(5) }),
  z.object({ action: z.enum(["open", "close", "reopen"]), roundId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("publish"), roundId: z.string().min(1).max(200) }),
  z.object({
    action: z.literal("reviewComment"),
    expectedVersion: z.number().int().nonnegative(),
    evaluationId: z.string().min(1).max(200),
    status: z.enum(["approved", "hidden"]),
    redactedPublicComment: z.string().max(200),
  }),
  z.object({
    action: z.literal("saveSummary"),
    roundId: z.string().min(1).max(200),
    studentId: z.string().min(1).max(200),
    teacherSummary: z.string().max(2_000),
    expectedVersion: z.number().int().nonnegative().nullable(),
  }),
]);

function errorResponse(error: unknown) {
  if (error instanceof FormWriteConflict) return Response.json({ message: error.message }, { status: 409 });
  if (error instanceof EvaluationServiceError) return Response.json({ message: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ message: "평가 처리 중 오류가 발생했습니다." }, { status: 500 });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const classNumber = Number(params.get("classNumber") || 9);
  const clubId = params.get("clubId") || undefined;
  const roundId = params.get("roundId") || undefined;
  try {
    return Response.json(clubId ? await getClubEvaluationManagementData(user.id, clubId, roundId) : await getEvaluationManagementData(classNumber, roundId, user.id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "평가 입력 내용을 확인해 주세요." }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "create") {
      if (!input.clubId && input.classNumber == null) throw new EvaluationServiceError("학급 또는 동아리를 선택해 주세요.");
      const roundId = input.clubId
        ? await createClubEvaluationRound(user.id, { clubId: input.clubId, title: input.title })
        : await createEvaluationRound(user.id, { classNumber: input.classNumber!, title: input.title, optionalItem: input.optionalItem });
      return Response.json({ ok: true, roundId });
    }
    if (input.action === "updateTemplate") await updateEvaluationTemplate(user.id, input);
    if (input.action === "open" || input.action === "close" || input.action === "reopen") {
      await changeEvaluationRoundStatus(user.id, input.roundId, input.action);
    }
    if (input.action === "publish") await publishEvaluationRound(user.id, input.roundId);
    if (input.action === "reviewComment") return Response.json({ ok: true, ...await reviewPeerComment(user.id, input) });
    if (input.action === "saveSummary") return Response.json({ ok: true, ...await saveEvaluationTeacherSummary(user.id, input) });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
