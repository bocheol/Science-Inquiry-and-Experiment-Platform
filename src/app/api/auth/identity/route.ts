import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json({ userId: user?.id ?? null, sessionMarker: user?.sessionMarker ?? null, mustChangePassword: user?.mustChangePassword ?? false }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
