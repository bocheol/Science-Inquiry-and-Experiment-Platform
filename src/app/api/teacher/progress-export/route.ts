import { getCurrentUser } from "@/lib/auth";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { buildTeacherProgressExport } from "@/lib/teacher-export";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return Response.json({ message: "권한이 없습니다." }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "csv" ? "csv" : "xlsx";
  const parsedClass = Number(params.get("classNumber"));
  const classNumber = Number.isInteger(parsedClass) && parsedClass >= 1 && parsedClass <= 9 ? parsedClass : undefined;
  const data = await getTeacherDashboardData();
  const body = buildTeacherProgressExport(data, format, classNumber);
  const scope = classNumber ? `${classNumber}반` : "전체";
  const filename = `science-progress-${classNumber ? `class-${classNumber}` : "all"}.${format}`;

  return new Response(new Uint8Array(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(`과학탐구-${scope}-진척.${format}`)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
