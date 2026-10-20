import { requireUser } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { StudentRecordsWorkspace } from "@/components/student-records/workspace";
import "./records.css";

export const dynamic = "force-dynamic";
export default async function RecordsPage() {
  const user = await requireUser();
  return <><AppHeader name={user.name} role={user.role} /><main className="page-shell records-shell"><StudentRecordsWorkspace user={{ id: user.id, role: user.role }} /></main></>;
}
