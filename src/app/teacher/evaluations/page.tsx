import { AppHeader } from "@/components/app-header";
import { TeacherEvaluationManager } from "@/components/teacher-evaluation-manager";
import { requireUser } from "@/lib/auth";
import { getEvaluationManagementData } from "@/lib/evaluation-service";

export const dynamic = "force-dynamic";

export default async function TeacherEvaluationsPage() {
  const user = await requireUser("teacher");
  const data = await getEvaluationManagementData(9);
  return (
    <>
      <AppHeader name={user.name} role="teacher" />
      <main className="page-shell">
        <div className="toolbar no-print"><a className="button secondary" href="/teacher">← 대시보드</a></div>
        <div className="page-title">
          <div><h1>자기평가·동료평가 관리</h1><p>행동 기준 4단계로 평가하고, 익명 의견을 교사가 검토한 뒤 학생에게 공개합니다.</p></div>
        </div>
        <TeacherEvaluationManager initialData={data} />
      </main>
    </>
  );
}
