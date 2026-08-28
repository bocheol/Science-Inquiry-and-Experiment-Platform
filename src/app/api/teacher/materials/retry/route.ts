import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { retryMaterialSync } from "@/lib/materials";

const schema = z.object({ requestId: z.string().min(1) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "신청 기록을 확인해 주세요." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await retryMaterialSync(parsed.data.requestId, user.id)) });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "재전송하지 못했습니다." }, { status: 400 });
  }
}

