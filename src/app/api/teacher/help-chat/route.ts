import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { answerPlatformGuideQuestion } from "@/lib/platform-guide";
import { userFacingMessage } from "@/lib/user-facing-error";

const schema = z.object({ question: z.string().trim().min(1).max(500) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "질문은 500자 이내로 입력해 주세요." }, { status: 400 });
  try {
    return Response.json(answerPlatformGuideQuestion(parsed.data.question));
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "안내를 찾지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}
