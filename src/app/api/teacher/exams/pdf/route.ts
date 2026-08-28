import { getCurrentUser } from "@/lib/auth";
import { ExamServiceError, getExamSetForPdf } from "@/lib/exam-service";
import { buildExamPdf } from "@/lib/exam-pdf";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const examSetId = params.get("examSetId");
  if (!examSetId) return Response.json({ message: "시험을 선택해 주세요." }, { status: 400 });
  try {
    const studentId = params.get("studentId") || undefined;
    const answers = params.get("answers") === "true";
    const data = await getExamSetForPdf(examSetId, studentId);
    const pdf = await buildExamPdf(data, answers);
    const suffix = answers ? "answer-key" : "papers";
    const filename = `science-exam-class-${data.classNumber}-${suffix}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`${data.classNumber}반-${data.title}-${answers ? "교사용답안" : "시험지"}.pdf`)}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof ExamServiceError ? error.status : 400;
    return Response.json({ message: error instanceof Error ? error.message : "PDF를 만들지 못했습니다." }, { status });
  }
}
