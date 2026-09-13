import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getPastRecordDay, listPastRecordDays, PastRecordAccessError } from "@/lib/past-records";
import { userFacingMessage } from "@/lib/user-facing-error";

const id = z.string().trim().min(1).max(200);
const listSchema = z.object({
  mode: z.literal("list"),
  q: z.string().max(100),
  type: z.enum(["all", "conversation", "journal"]),
  teamId: id.optional(),
  offset: z.coerce.number().int().min(0).max(10000),
});
const detailSchema = z.object({
  mode: z.literal("detail"),
  teamId: id,
  cycleId: id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
});

export async function GET(request: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const raw = Object.fromEntries(params.entries());
  const mode = params.get("mode") === "detail" ? "detail" : "list";
  const parsed = mode === "detail"
    ? detailSchema.safeParse({ ...raw, mode })
    : listSchema.safeParse({ mode, q: params.get("q") ?? "", type: params.get("type") ?? "all", teamId: params.get("teamId") ?? undefined, offset: params.get("offset") ?? "0" });
  if (!parsed.success) return Response.json({ message: "검색 조건을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.mode === "detail") return Response.json(await getPastRecordDay(actor, parsed.data));
    return Response.json(await listPastRecordDays(actor, {
      query: parsed.data.q,
      filter: parsed.data.type,
      teamId: parsed.data.teamId,
      offset: parsed.data.offset,
    }));
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "지난 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.") }, {
      status: error instanceof PastRecordAccessError ? error.status : 400,
    });
  }
}
