import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  getPushPublicConfiguration,
  removePushSubscription,
  savePushSubscription,
} from "@/lib/push-notifications";

const endpointSchema = z.string().url().max(4000).refine((value) => value.startsWith("https://"), "안전한 구독 주소가 아닙니다.");
const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(1000),
    auth: z.string().min(8).max(500),
  }),
});
const deleteSchema = z.object({ endpoint: endpointSchema });

async function requireStudent() {
  const user = await getCurrentUser();
  return user?.role === "student" && !user.mustChangePassword ? user : null;
}

export async function GET() {
  const user = await requireStudent();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  return NextResponse.json(getPushPublicConfiguration());
}

export async function POST(request: Request) {
  const user = await requireStudent();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = subscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "기기 알림 정보를 확인해 주세요." }, { status: 400 });
  try {
    await savePushSubscription(user, parsed.data, request.headers.get("user-agent") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "기기 알림을 켜지 못했습니다." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = await requireStudent();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "해제할 기기 알림을 확인해 주세요." }, { status: 400 });
  await removePushSubscription(user, parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
