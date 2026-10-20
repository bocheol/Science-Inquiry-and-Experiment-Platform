import { journalTeacherClasses } from "@/lib/journal-access";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { AppHeader } from "@/components/app-header";
import { TeacherExamManager } from "@/components/teacher-exam-manager";
import { requireUser } from "@/lib/auth";
import { getExamManagementData } from "@/lib/exam-service";

export const dynamic = "force-dynamic";

export default async function TeacherExamsPage() {
  const user = await requireUser("teacher");
  const allowed = await journalTeacherClasses(await getDb(), user.id);
  const db = await getDb();
  const club = !allowed.length ? (await db.query<{ id: string }>("SELECT c.id FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id WHERE c.academic_year = $2 AND a.teacher_id = $1 ORDER BY c.id LIMIT 1", [user.id, ACADEMIC_YEAR])).rows[0] : undefined;
  if (!allowed.length && !club) return <><AppHeader name={user.name} role="teacher" /><main className="page-shell"><p>개인 기록을 포함한 시험 운영을 위해 마스터에게 담당반 권한을 요청해 주세요.</p><a href="/teacher">대시보드로</a></main></>;
  const data = await getExamManagementData(allowed.some(c => c.class_number === 9) ? 9 : allowed[0]?.class_number ?? 9, undefined, user.id, club?.id);
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
