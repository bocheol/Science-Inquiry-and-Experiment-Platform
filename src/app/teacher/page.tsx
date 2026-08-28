import { AppHeader } from "@/components/app-header";
import { TeacherDashboard } from "@/components/teacher-dashboard";
import { requireUser } from "@/lib/auth";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { TeacherHelpChatbot } from "@/components/teacher-help-chatbot";

export const dynamic = "force-dynamic";

export default async function TeacherPage() {
  const user = await requireUser("teacher");
  const data = await getTeacherDashboardData();
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="page-title no-print">
          <div><h1>교사 대시보드</h1><p>9개 학급의 탐구 진척과 확인할 일을 한곳에서 관리합니다.</p></div>
          <div className="toolbar-group"><a className="button secondary" href="/teacher/evaluations">자기·동료평가 관리</a><a className="button" href="/teacher/exams">시험 문제 관리</a><span className="badge">2026학년도</span></div>
        </div>
        <TeacherDashboard initialData={data} />
        <TeacherHelpChatbot />
      </main>
    </>
  );
}
