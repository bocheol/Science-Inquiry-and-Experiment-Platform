import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { audit } from "@/lib/db";
import { getOpenAIClient, safetyIdentifier, userFacingAiError } from "@/lib/ai";
import { DiscussionError } from "@/lib/discussions";
import { buildLiveAiSessionContext } from "@/lib/live-ai";
import { readJsonBody } from "@/lib/request-body";

const schema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  cycleId: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "student" || actor.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "현재 탐구 회차를 확인해 주세요." }, { status: 400 });
  try {
    const { teamId, instructions } = await buildLiveAiSessionContext(actor, parsed.data.sessionId, parsed.data.cycleId);
    const model = process.env.OPENAI_LIVE_AI_MODEL?.trim() || "gpt-realtime-2.1-mini";
    const transcriptionModel = process.env.OPENAI_LIVE_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe";
    const secret = await getOpenAIClient().realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        instructions,
        max_output_tokens: 180,
        reasoning: { effort: "low" },
        truncation: { type: "retention_ratio", retention_ratio: 0.8 },
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            transcription: { model: transcriptionModel, language: "ko" },
            turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: false },
          },
          output: { voice: "marin", speed: 1 },
        },
      },
    }, { headers: { "OpenAI-Safety-Identifier": safetyIdentifier(teamId) } });
    await audit(actor.id, "live_ai_session_started", "inquiry_cycle", parsed.data.cycleId, { model, transcriptionModel });
    return NextResponse.json({ clientSecret: secret.value, expiresAt: secret.expires_at });
  } catch (error) {
    if (error instanceof DiscussionError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: userFacingAiError(error) }, { status: 500 });
  }
}
