import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  changeEvaluationRoundStatus,
  createEvaluationRound,
  EvaluationServiceError,
  getEvaluationManagementData,
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
    classNumber: z.number().int().min(1).max(9),
    title: z.string().min(1).max(100),
    optionalItem: z.enum(["none", "safety", "theory"]),
  }),
  z.object({ action: z.literal("updateTemplate"), roundId: z.string().min(1).max(200), title: z.string().min(1).max(100), items: z.array(itemSchema).min(4).max(5) }),
  z.object({ action: z.enum(["open", "close", "reopen"]), roundId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("publish"), roundId: z.string().min(1).max(200) }),
  z.object({
    action: z.literal("reviewComment"),
    evaluationId: z.string().min(1).max(200),
    status: z.enum(["approved", "hidden"]),
    redactedPublicComment: z.string().max(200),
  }),
  z.object({
    action: z.literal("saveSummary"),
    roundId: z.string().min(1).max(200),
    studentId: z.string().min(1).max(200),
    teacherSummary: z.string().max(2_000),
  }),
]);

function errorResponse(error: unknown) {
  if (error instanceof EvaluationServiceError) return Response.json({ message: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ message: "평가 처리 중 오류가 발생했습니다." }, { status: 500 });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const classNumber = Number(params.get("classNumber") || 9);
  const roundId = params.get("roundId") || undefined;
  try {
    return Response.json(await getEvaluationManagementData(classNumber, roundId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ message: "평가 입력 내용을 확인해 주세요." }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "create") {
      const roundId = await createEvaluationRound(user.id, input);
      return Response.json({ ok: true, roundId });
    }
    if (input.action === "updateTemplate") await updateEvaluationTemplate(user.id, input);
    if (input.action === "open" || input.action === "close" || input.action === "reopen") {
      await changeEvaluationRoundStatus(user.id, input.roundId, input.action);
    }
    if (input.action === "publish") await publishEvaluationRound(user.id, input.roundId);
    if (input.action === "reviewComment") await reviewPeerComment(user.id, input);
    if (input.action === "saveSummary") await saveEvaluationTeacherSummary(user.id, input);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
