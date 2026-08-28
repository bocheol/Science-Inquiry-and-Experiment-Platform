import { getCurrentUser } from "@/lib/auth";
import { getPublishedStudentExamResult } from "@/lib/exam-service";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "student") return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  return Response.json({ result: await getPublishedStudentExamResult(user.id) });
}
