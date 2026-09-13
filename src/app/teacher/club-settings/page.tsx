import { AppHeader } from "@/components/app-header";
import { ClubSettingsManager } from "@/components/club-settings-manager";
import { requireUser } from "@/lib/auth";
import { getClubSettingsData } from "@/lib/club-settings";

export const dynamic = "force-dynamic";

export default async function ClubSettingsPage() {
  const user = await requireUser("teacher");
  const data = await getClubSettingsData(user.id);
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="page-title">
          <div>
            <h1>동아리 운영 설정</h1>
            <p>동아리별 양식과 평가·시험·Google Sheet 연결을 버전으로 관리합니다.</p>
          </div>
          <a className="button secondary" href="/teacher">대시보드로</a>
        </div>
        <ClubSettingsManager initialData={data} />
      </main>
    </>
  );
}
