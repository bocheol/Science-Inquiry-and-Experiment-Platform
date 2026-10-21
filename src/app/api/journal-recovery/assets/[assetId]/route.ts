import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requestMatchesUser } from "@/lib/session-bound-request";
import { getRecoveryAsset, putRecoveryAsset, RECOVERY_ASSET_BYTES, RecoveryAccessError } from "@/lib/journal-recovery-service";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { userFacingMessage } from "@/lib/user-facing-error";
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ assetId: string }> };
async function access(request: Request, context: Context) {
  const user = await getCurrentUser(); const { assetId } = await context.params;
  if (!user || user.role !== "student" || user.mustChangePassword || !requestMatchesUser(request, user) || !/^[0-9a-f-]{36}$/i.test(assetId)) throw new RecoveryAccessError();
  return { user, assetId };
}
function failure(error: unknown) { return NextResponse.json({ message: userFacingMessage(error, "복구 사진을 전송하지 못했습니다.") }, { status: error instanceof RecoveryAccessError ? 403 : error instanceof FormWriteConflict ? 409 : 400 }); }
export async function GET(request: Request, context: Context) {
  try { const { user, assetId } = await access(request, context); return new NextResponse(new Uint8Array(await getRecoveryAsset(user.id, assetId)), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { user, assetId } = await access(request, context);
    if (Number(request.headers.get("content-length")) > RECOVERY_ASSET_BYTES) { await request.body?.cancel(); return NextResponse.json({ message: "복구 사진이 너무 큽니다." }, { status: 413 }); }
    const reader = request.body?.getReader(); if (!reader) return NextResponse.json({ message: "사진을 확인해 주세요." }, { status: 400 });
    const chunks: Buffer[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > RECOVERY_ASSET_BYTES) { await reader.cancel(); return NextResponse.json({ message: "복구 사진이 너무 큽니다." }, { status: 413 }); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    await putRecoveryAsset(user.id, assetId, Buffer.concat(chunks));
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
