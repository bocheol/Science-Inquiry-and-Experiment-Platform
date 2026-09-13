import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { userFacingAiError } from "@/lib/ai";
import {
  addCommonExamQuestion,
  confirmExamSet,
  createCorrectionExamSet,
  deleteExamQuestionSlot,
  ExamServiceError,
  generateExamSet,
  getExamManagementData,
  publishExamResult,
  saveExamResult,
  updateExamQuestion,
} from "@/lib/exam-service";

const difficulty = z.enum(["basic", "standard", "advanced"]);
const rubric = z.array(z.object({ criterion: z.string().max(300), points: z.number().int().min(1).max(100) })).min(1).max(6);
const generateSchema = z.object({
  action: z.literal("generate"),
  classNumber: z.number().int().min(1).max(9).optional(),
  clubId: z.string().min(1).optional(),
  configVersionId: z.string().min(1).optional(),
  title: z.string().min(1).max(100),
  commonCount: z.number().int().min(0).max(5),
  teamCount: z.number().int().min(0).max(5),
  individualCount: z.number().int().min(0).max(3),
  totalScore: z.number().int().min(1).max(200),
  commonScope: z.string().max(1_000),
  requestId: z.string().uuid().optional(),
});
const postSchema = z.discriminatedUnion("action", [
  generateSchema,
  z.object({ action: z.literal("confirm"), examSetId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("correction"), examSetId: z.string().min(1).max(200), reason: z.string().min(1).max(500) }),
  z.object({
    action: z.literal("grade"), examId: z.string().min(1).max(200),
    questionScores: z.record(z.string(), z.number()), teacherFeedback: z.string().max(2_000),
  }),
  z.object({ action: z.literal("publish"), examId: z.string().min(1).max(200) }),
  z.object({
    action: z.literal("addCommon"), examSetId: z.string().min(1).max(200), stimulus: z.string().max(2_000),
    question: z.string().min(1).max(2_000), competency: z.string().min(1).max(100), difficulty,
    maxScore: z.number().int().min(1).max(100), modelAnswer: z.string().min(1).max(4_000), scoringRubric: rubric,
  }),
]);
const patchSchema = z.object({
  questionId: z.string().min(1).max(200), stimulus: z.string().max(2_000),
  question: z.string().min(1).max(2_000), competency: z.string().min(1).max(100), difficulty,
  modelAnswer: z.string().min(1).max(4_000), scoringRubric: rubric,
});

function errorResponse(error: unknown) {
  if (error instanceof ExamServiceError) return Response.json({ message: error.message }, { status: error.status });
  return Response.json({ message: userFacingAiError(error) }, { status: 400 });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const classNumber = Number(params.get("classNumber") || 9);
  const clubId = params.get("clubId") || undefined;
  const setId = params.get("setId") || undefined;
  if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > 9) return Response.json({ message: "학급을 확인해 주세요." }, { status: 400 });
  try {
    return Response.json(await getExamManagementData(classNumber, setId, user.id, clubId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = postSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "입력 내용을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "generate") {
      const { action: _action, ...input } = parsed.data;
      const { requestId, ...examInput } = input;
      const examSetId = await generateExamSet(user.id, examInput, undefined, requestId);
      return Response.json({ ok: true, examSetId });
    }
    if (parsed.data.action === "confirm") await confirmExamSet(user.id, parsed.data.examSetId);
    if (parsed.data.action === "correction") {
      const examSetId = await createCorrectionExamSet(user.id, parsed.data.examSetId, parsed.data.reason);
      return Response.json({ ok: true, examSetId });
    }
    if (parsed.data.action === "grade") await saveExamResult(user.id, parsed.data);
    if (parsed.data.action === "publish") await publishExamResult(user.id, parsed.data.examId);
    if (parsed.data.action === "addCommon") await addCommonExamQuestion(user.id, parsed.data);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = patchSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "문항 내용을 확인해 주세요." }, { status: 400 });
  try {
    await updateExamQuestion(user.id, parsed.data);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const questionId = new URL(request.url).searchParams.get("questionId");
  if (!questionId) return Response.json({ message: "문항을 선택해 주세요." }, { status: 400 });
  try {
    await deleteExamQuestionSlot(user.id, questionId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
