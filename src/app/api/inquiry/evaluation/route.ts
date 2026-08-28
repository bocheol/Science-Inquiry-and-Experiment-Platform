import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  EvaluationServiceError,
  getStudentEvaluationData,
  savePeerEvaluation,
  saveSelfEvaluation,
} from "@/lib/evaluation-service";

const selfResponse = z.object({
  itemId: z.string().min(1).max(60),
  value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal("activity_unavailable")]),
  reason: z.string().max(500),
});
const peerResponse = z.object({
  itemId: z.string().min(1).max(60),
  value: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal("unable_to_judge")]),
  reason: z.string().max(500),
});
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveSelf"),
    roundId: z.string().min(1).max(200),
    responses: z.array(selfResponse).min(4).max(5),
    reflections: z.tuple([z.string().min(1).max(1_000), z.string().min(1).max(1_000)]),
  }),
  z.object({
    action: z.literal("savePeer"),
    roundId: z.string().min(1).max(200),
    evaluateeId: z.string().min(1).max(200),
    responses: z.array(peerResponse).min(4).max(5),
    privateEvidence: z.string().max(1_000),
    publicComment: z.string().max(200),
    confirmed: z.boolean(),
  }),
]);

function errorResponse(error: unknown) {
  if (error instanceof EvaluationServiceError) return Response.json({ message: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ message: "평가 처리 중 오류가 발생했습니다." }, { status: 500 });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  try {
    return Response.json({ data: await getStudentEvaluationData(user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ message: "평가 응답을 모두 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "saveSelf") await saveSelfEvaluation(user.id, parsed.data);
    if (parsed.data.action === "savePeer") await savePeerEvaluation(user.id, parsed.data);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
