import { AppHeader } from "@/components/app-header";
import { TeacherNoticeManager } from "@/components/teacher-notice-manager";
import { requireUser } from "@/lib/auth";
import { getNoticeTargetOptions } from "@/lib/notices";

export const dynamic = "force-dynamic";

export default async function TeacherNoticesPage() {
  const user = await requireUser("teacher");
  const targets = await getNoticeTargetOptions(user);
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="page-title"><div><h1>공지 관리</h1><p>전체·반·팀 공지와 학생 캘린더 일정을 관리합니다.</p></div><a className="button secondary" href="/teacher">교사 대시보드로</a></div>
        <TeacherNoticeManager targets={targets} />
      </main>
    </>
  );
}
