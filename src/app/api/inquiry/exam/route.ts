import { getCurrentUser } from "@/lib/auth";
import { getPublishedStudentExamResult } from "@/lib/exam-service";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  return Response.json({ data: await getPublishedStudentExamResult(user.id, new URL(request.url).searchParams.get("teamId") || undefined) });
}
