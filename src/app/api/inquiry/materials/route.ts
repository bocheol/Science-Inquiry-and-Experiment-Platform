import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { normalizeMaterialLink } from "@/lib/material-links";
import { saveAndSyncMaterials } from "@/lib/materials";
import { UserFacingError, userFacingMessage } from "@/lib/user-facing-error";

const itemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  specification: z.string().trim().max(500),
  unitPrice: z.number().int().min(0).max(100_000_000),
  quantity: z.number().int().min(1).max(10_000),
  shipping: z.number().int().min(0).max(10_000_000),
  link: z.string().trim().max(5000),
});
const schema = z.object({
  submissionId: z.string().min(10).max(100),
  sessionId: z.string(),
  cycleId: z.string().trim().min(1).max(200),
  items: z.array(itemSchema).min(1).max(20),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: parsed.error.issues[0]?.message ?? "준비물 내용을 확인해 주세요." }, { status: 400 });
  try {
    const teamId = await assertActiveTeamMember(user.id, parsed.data.sessionId);
    const normalizedItems = parsed.data.items.map((item, index) => {
      const result = normalizeMaterialLink(item.link);
      if (!result.ok) throw new UserFacingError(`${index + 1}번째 품목: ${result.message}`);
      return { ...item, link: result.link };
    });
    const result = await saveAndSyncMaterials({
      submissionId: parsed.data.submissionId,
      sessionId: parsed.data.sessionId,
      cycleId: parsed.data.cycleId,
      teamId,
      actorId: user.id,
      items: normalizedItems,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: userFacingMessage(error, "준비물을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}
