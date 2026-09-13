import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { getCurrentUser } from "@/lib/auth";
import { getCustomTabResponse, saveCustomTabResponse } from "@/lib/club-custom-tabs";
import { userFacingMessage } from "@/lib/user-facing-error";

const querySchema = z.object({ sessionId: z.string().min(1), configVersionId: z.string().min(1) });
const saveSchema = querySchema.extend({ responseData: z.record(z.string(), z.unknown()), submit: z.boolean(), expectedVersion: z.number().int().nonnegative().nullable() });

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({ sessionId: params.get("sessionId"), configVersionId: params.get("configVersionId") });
  if (!parsed.success) return Response.json({ message: "탭 정보를 확인해 주세요." }, { status: 400 });
  try { return Response.json(await getCustomTabResponse(user.id, parsed.data.sessionId, parsed.data.configVersionId)); }
  catch (error) { return Response.json({ message: userFacingMessage(error, "탭을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 }); }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = saveSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "작성 내용을 확인해 주세요." }, { status: 400 });
  try { return Response.json({ ok: true, ...await saveCustomTabResponse(user.id, parsed.data) }); }
  catch (error) { return Response.json({ message: userFacingMessage(error, "내용을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: error instanceof FormWriteConflict ? 409 : 400 }); }
}
