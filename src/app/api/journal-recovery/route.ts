import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { requestMatchesUser } from "@/lib/session-bound-request";
import { readJsonBody } from "@/lib/request-body";
import { getJournalRecoveryKey, getLegacyRecoverySeal, listRecoveryDrafts, retireRecoveryDraft, saveRecoveryDraft, unlockLegacyRecoveryKey, RecoveryAccessError } from "@/lib/journal-recovery-service";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { userFacingMessage } from "@/lib/user-facing-error";

const identifier = z.string().min(1).max(200);
const scope = z.object({ sessionId: identifier, cycleId: identifier });
const base = scope.extend({ id: z.string().uuid(), revision: z.number().int().min(1).max(2_000_000_000) });
const bodySchema = z.discriminatedUnion("action", [
  base.extend({ action: z.literal("save"), data: z.string().max(220_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), assetIds: z.array(z.string().uuid()).max(5) }),
  base.extend({ action: z.literal("retire"), onlyIfRevision: z.number().int().min(1).optional() }),
  z.object({ action: z.literal("unlock-legacy"), sealedKey: z.string().min(1).max(600) }),
]);
const headers = { "Cache-Control": "private, no-store, max-age=0" };
function failure(error: unknown) { return NextResponse.json({ message: userFacingMessage(error, "복구 사본을 처리하지 못했습니다.") }, { status: error instanceof RecoveryAccessError ? 403 : error instanceof FormWriteConflict ? 409 : 400, headers }); }
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword || !requestMatchesUser(request, user)) return NextResponse.json({ message: "다시 로그인해 주세요." }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  try {
    // Public encryption key can seal old local drafts for their original owner.
    if (params.get("kind") === "legacy-seal") return NextResponse.json({ publicKey: (await getLegacyRecoverySeal()).public_key }, { headers });
    if (user.role !== "student") throw new RecoveryAccessError();
    if (params.get("kind") === "key") return NextResponse.json({ key: (await getJournalRecoveryKey(user.id)).toString("base64") }, { headers });
    const input = scope.parse({ sessionId: params.get("sessionId"), cycleId: params.get("cycleId") });
    const rows = await listRecoveryDrafts(user.id, input.sessionId, input.cycleId);
    return NextResponse.json({ drafts: rows.map(row => ({ id: row.id, revision: row.revision, data: row.encrypted_data!.toString("base64"), assetIds: row.asset_ids, savedAt: new Date(row.updated_at).toISOString() })) }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword || !requestMatchesUser(request, user)) return NextResponse.json({ message: "다시 로그인해 주세요." }, { status: 403, headers });
  try {
    const input = bodySchema.parse(await readJsonBody(request, 256 * 1024));
    if (input.action === "unlock-legacy") return NextResponse.json({ key: await unlockLegacyRecoveryKey(user.id, input.sealedKey) }, { headers });
    if (input.action === "save") await saveRecoveryDraft(user.id, { ...input, data: Buffer.from(input.data, "base64") });
    else await retireRecoveryDraft(user.id, input);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) { return failure(error); }
}
