import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { MasterAccountManager } from "@/components/master-account-manager";
import { requireUser } from "@/lib/auth";
import { getMasterAccountData } from "@/lib/master-accounts";

export const dynamic = "force-dynamic";

export default async function MasterAccountPage() {
  const user = await requireUser("teacher");
  if (!user.isMaster) redirect("/teacher");
  const data = await getMasterAccountData(user.id);
  return <><AppHeader name={user.name} role="teacher" /><main className="page-shell"><div className="page-title"><div><span className="eyebrow">마스터 관리자</span><h1>교사·체험 계정 관리</h1><p>개인 계정을 발급하고 비활성화·복원 이력을 안전하게 관리합니다.</p></div><a className="button secondary" href="/teacher">← 대시보드</a></div><MasterAccountManager initialData={data} /></main></>;
}
