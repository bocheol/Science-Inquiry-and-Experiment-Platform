import { AppHeader } from "@/components/app-header";
import { TeacherExamManager } from "@/components/teacher-exam-manager";
import { requireUser } from "@/lib/auth";
import { getExamManagementData } from "@/lib/exam-service";

export const dynamic = "force-dynamic";

export default async function TeacherExamsPage() {
  const user = await requireUser("teacher");
  const data = await getExamManagementData(9);
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="toolbar no-print"><a className="button secondary" href="/teacher">← 대시보드</a></div>
        <div className="page-title">
          <div><h1>시험 문제 관리</h1><p>플랫폼이 탐구 자료에서 공정한 문항을 만들고, 교사가 수정·확정·출력·채점합니다.</p></div>
        </div>
        <TeacherExamManager initialData={data} />
      </main>
    </>
  );
}
