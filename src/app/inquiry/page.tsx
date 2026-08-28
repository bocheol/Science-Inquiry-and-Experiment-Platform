import { AppHeader } from "@/components/app-header";
import { InquiryWorkspace } from "@/components/inquiry-workspace";
import { requireUser } from "@/lib/auth";
import { getInquiryDataForUser } from "@/lib/inquiry-data";

export const dynamic = "force-dynamic";

export default async function InquiryPage() {
  const user = await requireUser("student");
  const data = await getInquiryDataForUser(user.id);
  return (
    <>
      <AppHeader name={user.name} role="student" />
      <main className="page-shell">
        {data ? <InquiryWorkspace initialData={data} currentUserId={user.id} /> : <section className="card empty-state"><div style={{ fontSize: 38 }}>👥</div><h1>아직 팀이 배정되지 않았습니다.</h1><p>선생님이 팀을 편성하면 이곳에서 탐구를 시작할 수 있습니다.</p></section>}
      </main>
    </>
  );
}

