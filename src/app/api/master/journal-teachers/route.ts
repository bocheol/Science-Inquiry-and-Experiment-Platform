import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { readJsonBody } from "@/lib/request-body";
import { getJournalTeacherSettings, setJournalTeacherClasses } from "@/lib/journal-teacher-settings";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { userFacingMessage } from "@/lib/user-facing-error";

const schema = z.object({ teacherId: z.string().min(1).max(200), classIds: z.array(z.string().max(200)).max(9), expectedClassIds: z.array(z.string().max(200)).max(9) });
export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isMaster || user.mustChangePassword) return NextResponse.json({ message: "마스터 권한이 필요합니다." }, { status: 403 });
  return NextResponse.json(await getJournalTeacherSettings(user.id), { headers: { "Cache-Control": "private, no-store" } });
}
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isMaster || user.mustChangePassword) return NextResponse.json({ message: "마스터 권한이 필요합니다." }, { status: 403 });
  try {
    const input = schema.parse(await readJsonBody(request));
    await setJournalTeacherClasses(user.id, input.teacherId, input.classIds, input.expectedClassIds);
    return NextResponse.json(await getJournalTeacherSettings(user.id));
  } catch (error) {
    return NextResponse.json({ message: userFacingMessage(error, "교사 권한을 저장하지 못했습니다.") }, { status: error instanceof FormWriteConflict ? 409 : 400 });
  }
}
