import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getInquiryDataForUser } from "@/lib/inquiry-data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "student") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const data = await getInquiryDataForUser(user.id);
  return NextResponse.json({ data });
}

