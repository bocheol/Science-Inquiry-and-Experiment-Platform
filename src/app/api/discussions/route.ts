import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertDiscussionAccess, confirmMeeting, DiscussionError, getDiscussionData, markDiscussionDay, saveDiscussionEntry, seoulDate } from "@/lib/discussions";
import { summarizeDiscussionDay } from "@/lib/discussion-summary";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), id: z.string(), sessionId: z.string(), kind: z.enum(["peer","meeting","supplement"]), date: z.string().optional(), content: z.string().max(16000), participantIds: z.array(z.string()).max(30).optional(), parentId: z.string().optional() }),
  z.object({ action: z.literal("confirm"), sessionId: z.string(), entryId: z.string() }),
  z.object({ action: z.literal("summarize"), sessionId: z.string(), date: z.string() }),
]);
function failure(error: unknown) {
  return Response.json({ message: error instanceof DiscussionError ? error.message : "기록을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: error instanceof DiscussionError ? error.status : 500 });
}
export async function GET(request: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const url = new URL(request.url);
  try { return Response.json(await getDiscussionData(actor, url.searchParams.get("sessionId") ?? "", url.searchParams.get("date") ?? seoulDate())); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "입력 내용을 확인해 주세요." }, { status: 400 });
  const input = parsed.data;
  try {
    if (input.action === "save") {
      const saved = await saveDiscussionEntry(actor, input);
      const summarized = input.kind !== "peer" ? await summarizeDiscussionDay(input.sessionId, saved.date) : false;
      return Response.json({ ok: true, ...saved, summarized, message: input.kind === "peer" ? "메시지를 보냈습니다." : summarized ? "원문과 AI 정리를 저장했습니다." : "원문을 저장했습니다. AI 정리는 대기 중이며 자동으로 재시도합니다." });
    }
    if (input.action === "confirm") { await confirmMeeting(actor, input.sessionId, input.entryId); return Response.json({ ok: true }); }
    await assertDiscussionAccess(actor, input.sessionId);
    // Only teachers explicitly regenerate; students use automatic daily/meeting summaries.
    if (actor.role !== "teacher") throw new DiscussionError("즉시 정리는 교사가 실행할 수 있습니다.", 403);
    const data = await getDiscussionData(actor, input.sessionId, input.date);
    if (!data.sources.length) throw new DiscussionError("이 날짜에는 정리할 기록이 없습니다.");
    if (!data.jobs.some(j => j.activity_date === input.date)) await markDiscussionDay(input.sessionId, input.date);
    const summarized = await summarizeDiscussionDay(input.sessionId, input.date);
    return Response.json({ ok: true, summarized, message: summarized ? "날짜별 정리를 저장했습니다." : "기존 정리가 최신이거나 처리·재시도 대기 중입니다." });
  } catch (error) { return failure(error); }
}
