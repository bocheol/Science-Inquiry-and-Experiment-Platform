import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";

export async function POST() {
  await clearSession();
  // Keep the browser's origin when the server sits behind a port-forwarding proxy.
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
