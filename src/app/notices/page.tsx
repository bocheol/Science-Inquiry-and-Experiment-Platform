import { AppHeader } from "@/components/app-header";
import { NoticeCenter } from "@/components/notice-center";
import { requireUser } from "@/lib/auth";
import { listStudentNotices } from "@/lib/notices";

export const dynamic = "force-dynamic";

export default async function NoticesPage() {
  const user = await requireUser("student");
  const feed = await listStudentNotices(user);
  return (
    <>
      <AppHeader name={user.name} role="student" />
      <main className="page-shell">
        <div className="page-title"><div><h1>공지·알림</h1><p>선생님 공지, 처리 요청과 일정을 확인합니다.</p></div><a className="button secondary" href="/inquiry">탐구 화면으로</a></div>
        <NoticeCenter initialFeed={feed} />
      </main>
    </>
  );
}
