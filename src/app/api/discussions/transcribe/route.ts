import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getOpenAIClient, userFacingAiError } from "@/lib/ai";
import { assertDiscussionAccess, discussionCycle, DiscussionError } from "@/lib/discussions";
import { readFormDataBody } from "@/lib/request-form-data";

const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
const BODY_MAX_BYTES = AUDIO_MAX_BYTES + 64 * 1024;
const allowedTypes = new Set([
  "audio/webm", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/m4a", "audio/ogg",
]);
const fieldsSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  cycleId: z.string().trim().min(1).max(200),
});

function failure(error: unknown) {
  if (error instanceof DiscussionError) return NextResponse.json({ message: error.message }, { status: error.status });
  return NextResponse.json({ message: userFacingAiError(error) }, { status: 500 });
}

export async function POST(request: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "student" || actor.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  try {
    const body = await readFormDataBody(request, BODY_MAX_BYTES);
    if (body.kind === "too-large") return NextResponse.json({ message: "녹음은 10MB 이하로 나누어 전사해 주세요." }, { status: 413 });
    if (body.kind !== "ok") return NextResponse.json({ message: "녹음 업로드 형식을 확인해 주세요." }, { status: 400 });
    const parsed = fieldsSchema.safeParse({ sessionId: body.data.get("sessionId"), cycleId: body.data.get("cycleId") });
    if (!parsed.success) return NextResponse.json({ message: "현재 탐구 회차를 확인해 주세요." }, { status: 400 });
    const audio = body.data.get("audio");
    const mediaType = audio instanceof File ? audio.type.toLowerCase().split(";", 1)[0] : "";
    if (!(audio instanceof File) || audio.size <= 0 || audio.size > AUDIO_MAX_BYTES || !allowedTypes.has(mediaType)) {
      return NextResponse.json({ message: "지원되는 10MB 이하의 음성 녹음을 확인해 주세요." }, { status: 400 });
    }

    await assertDiscussionAccess(actor, parsed.data.sessionId, true);
    const cycle = await discussionCycle(parsed.data.sessionId, parsed.data.cycleId);
    if (cycle.status !== "active") throw new DiscussionError("완료된 회차에는 음성 메모를 추가할 수 없습니다.", 409);

    const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe";
    const result = await getOpenAIClient().audio.transcriptions.create({
      file: audio,
      model,
      language: "ko",
      prompt: "고등학교 과학탐구실험 대면 활동 메모입니다. 과학 용어, 단위, 변인, 측정값을 정확히 적어 주세요.",
    });
    const text = result.text.trim();
    if (!text) return NextResponse.json({ message: "말소리를 글로 바꾸지 못했습니다. 조용한 곳에서 다시 녹음해 주세요." }, { status: 422 });
    await audit(actor.id, "meeting_audio_transcribed", "inquiry_cycle", cycle.id, { byteSize: audio.size, model });
    return NextResponse.json({ text });
  } catch (error) {
    return failure(error);
  }
}
