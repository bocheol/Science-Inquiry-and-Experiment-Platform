import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { TeacherTeamReview } from "@/components/teacher-team-review";
import { requireUser } from "@/lib/auth";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";

export const dynamic = "force-dynamic";

export default async function TeamReviewPage({ params }: { params: Promise<{ teamId: string }> }) {
  const user = await requireUser("teacher");
  const { teamId } = await params;
  const data = await getInquiryDataForTeam(teamId);
  if (!data) notFound();
  return <><AppHeader name={user.name} role="teacher" /><main className="page-shell"><div className="toolbar no-print"><a className="button secondary" href="/teacher">← 대시보드</a></div><TeacherTeamReview data={data} currentUserId={user.id} /></main></>;
}
