import { AppHeader } from "@/components/app-header";
import { TeacherActivities } from "@/components/teacher-activities";
import { requireUser } from "@/lib/auth";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { TeacherHelpChatbot } from "@/components/teacher-help-chatbot";
import { TeacherRequestBoard } from "@/components/teacher-request-board";
import { getClubManagement } from "@/lib/clubs";

export const dynamic = "force-dynamic";

export default async function TeacherPage() {
  const user = await requireUser("teacher");
  const data = await getTeacherDashboardData();
  const clubs = await getClubManagement(user.id);
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="page-title no-print">
          <div><h1>교사 대시보드</h1><p>과탐실과 동아리의 탐구 진척과 활동 기록을 한곳에서 확인합니다.</p></div>
          <div className="toolbar-group"><a className="button secondary" href="/teacher/notices">공지 관리</a><a className="button secondary" href="/teacher/evaluations">자기·동료평가 관리</a><a className="button" href="/teacher/exams">시험 문제 관리</a><span className="badge">2026학년도</span></div>
        </div>
        <TeacherActivities classes={data} clubs={clubs} />
        <TeacherRequestBoard />
        <TeacherHelpChatbot />
      </main>
    </>
  );
}
