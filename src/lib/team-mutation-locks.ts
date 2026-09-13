import type { PoolClient } from "pg";

// Every membership/leadership writer locks the student first, then all affected
// teams in the same order. Old membership rows are retained for historical use.
export async function lockStudentTeams(client: PoolClient, studentId: string, extraTeamIds: string[] = []) {
  return lockStudentsTeams(client, [studentId], extraTeamIds);
}

export async function lockStudentsTeams(client: PoolClient, studentIds: string[], extraTeamIds: string[] = []) {
  const related = new Set(extraTeamIds);
  for (const studentId of [...new Set(studentIds)].sort()) {
    const student = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [studentId]);
    if (!student.rows.length) throw new Error("학생을 찾을 수 없습니다.");
    const memberships = await client.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active'", [studentId]);
    const leaderships = await client.query<{ id: string }>("SELECT id FROM teams WHERE leader_user_id = $1", [studentId]);
    for (const row of memberships.rows) related.add(row.team_id);
    for (const row of leaderships.rows) related.add(row.id);
  }
  const ids = [...related].sort();
  for (const id of ids) await client.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [id]);
}
