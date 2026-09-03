import { AppHeader } from "@/components/app-header";
import { InquiryWorkspace } from "@/components/inquiry-workspace";
import { requireUser } from "@/lib/auth";
import { getInquiryDataForUser } from "@/lib/inquiry-data";
import { getStudentActivities } from "@/lib/clubs";

export const dynamic = "force-dynamic";

export default async function InquiryPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const user = await requireUser("student");
  const { team } = await searchParams;
  const data = await getInquiryDataForUser(user.id, team);
  const activities = await getStudentActivities(user.id);
  return (
    <>
      <AppHeader name={user.name} role="student" />
      <main className="page-shell">
        {activities.length > 1 ? <nav className="toolbar-group activity-picker" aria-label="참여 활동 선택">{activities.map(a => <a className={`button ${a.id === data?.team.id ? "" : "secondary"}`} key={a.id} href={`/inquiry?team=${encodeURIComponent(a.id)}`}>{a.activity_name} · {a.name}</a>)}</nav> : null}
        {data ? <InquiryWorkspace key={data.team.id} initialData={data} currentUserId={user.id} /> : <section className="card empty-state"><div style={{ fontSize: 38 }}>👥</div><h1>현재 선택한 팀에 접근할 수 없습니다.</h1><p>선생님이 팀을 편성하면 이곳에서 탐구를 시작할 수 있습니다.</p></section>}
      </main>
    </>
  );
}
