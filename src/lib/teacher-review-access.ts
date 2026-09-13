import type { PoolClient } from "pg";

// The caller already holds the document's session/cycle locks. Preserve each
// review service's existing club scope while serializing account/team changes.
export async function lockTeacherReviewAccess(db: PoolClient, kind: "plan" | "report", documentId: string, teacherId: string) {
  const table = kind === "plan" ? "investigation_plans" : "reports";
  const target = (await db.query<{ team_id: string }>(
    `SELECT s.team_id FROM ${table} d JOIN inquiry_sessions s ON s.id = d.session_id WHERE d.id = $1`, [documentId],
  )).rows[0];
  if (!target) throw new Error("검토할 문서를 찾을 수 없습니다.");
  const actor = (await db.query<{ role: string; status: string; must_change_password: boolean; is_master: boolean }>(
    "SELECT role, status, must_change_password, is_master FROM users WHERE id = $1 FOR UPDATE", [teacherId],
  )).rows[0];
  if (!actor || actor.role !== "teacher" || actor.status !== "active" || actor.must_change_password) throw new Error("문서를 검토할 권한이 없습니다.");
  const team = (await db.query<{ status: string; club_id: string | null }>(
    "SELECT status, club_id FROM teams WHERE id = $1 FOR UPDATE", [target.team_id],
  )).rows[0];
  if (!team || team.status !== "active") throw new Error("활성 팀의 문서만 검토할 수 있습니다.");
  // Plan approvals already require a club assignment (or master). Report
  // reviews retain their existing shared-teacher scope; do not narrow it here.
  if (kind === "plan" && team.club_id && !actor.is_master) {
    const assignment = await db.query("SELECT teacher_id FROM club_teacher_assignments WHERE club_id = $1 AND teacher_id = $2 FOR UPDATE", [team.club_id, teacherId]);
    if (!assignment.rows.length) throw new Error("이 동아리 계획서를 검토할 권한이 없습니다.");
  }
}
