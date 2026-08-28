import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = await getDb();
  await db.query("SELECT 1");
  return NextResponse.json({ ok: true, service: "science-inquiry-platform" });
}

