import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { importRoster } from "@/lib/roster";
import {ROSTER_MAX_BYTES, RosterInputError} from "@/lib/roster-parser";
import { getTeacherDashboardData } from "@/lib/teacher-data";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  return NextResponse.json(await getTeacherDashboardData());
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const maxBodyBytes = ROSTER_MAX_BYTES + 64 * 1024;
  const tooLarge = () => NextResponse.json({ message: "명단 파일은 2MB 이하로 올려 주세요." }, { status: 413 });
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBodyBytes) return tooLarge();
  // Bound the actual multipart stream too: Content-Length may be missing or false.
  let formData: FormData | null = null;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          return tooLarge();
        }
        chunks.push(value);
      }
      formData = await new Response(Buffer.concat(chunks), { headers: request.headers }).formData();
    } catch {
      formData = null;
    } finally {
      reader.releaseLock();
    }
  }
  if(!formData) return NextResponse.json({message:"명단 업로드 형식을 확인해 주세요."},{status:400});
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ message: "엑셀 파일을 선택해 주세요." }, { status: 400 });
  if(file.size===0||file.size>ROSTER_MAX_BYTES) return NextResponse.json({message:"명단 파일은 2MB 이하로 올려 주세요."},{status:413});
  if (!/\.(xlsx|xls)$/i.test(file.name)) return NextResponse.json({ message: "xlsx 또는 xls 파일만 사용할 수 있습니다." }, { status: 400 });
  try {
    const result = await importRoster(await file.arrayBuffer(), user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: error instanceof RosterInputError ? error.message : "명단을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요." }, { status: 400 });
  }
}
