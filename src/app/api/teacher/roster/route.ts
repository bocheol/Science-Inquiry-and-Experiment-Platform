import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { importRoster } from "@/lib/roster";
import { getTeacherDashboardData } from "@/lib/teacher-data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  return NextResponse.json(await getTeacherDashboardData());
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ message: "엑셀 파일을 선택해 주세요." }, { status: 400 });
  if (!/\.(xlsx|xls)$/i.test(file.name)) return NextResponse.json({ message: "xlsx 또는 xls 파일만 사용할 수 있습니다." }, { status: 400 });
  try {
    const result = await importRoster(await file.arrayBuffer(), user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "명단을 읽지 못했습니다." }, { status: 400 });
  }
}

