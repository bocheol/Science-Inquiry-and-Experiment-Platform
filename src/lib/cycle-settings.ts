import { audit, getDb } from "@/lib/db";
import { UserFacingError } from "@/lib/user-facing-error";

function dateAtSchoolMidnight(value: string | null) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UserFacingError("회차 날짜를 확인해 주세요.");
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new UserFacingError("회차 날짜를 확인해 주세요.");
  return date;
}

export async function updateCycleSettings(input: {
  cycleId: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  teacherId: string;
}) {
  const title = input.title.trim();
  if (!title || title.length > 60) throw new UserFacingError("회차 이름을 60자 이내로 입력해 주세요.");
  const startedAt = dateAtSchoolMidnight(input.startDate);
  const endedAt = dateAtSchoolMidnight(input.endDate);
  if (startedAt && endedAt && endedAt < startedAt) throw new UserFacingError("종료일은 시작일보다 빠를 수 없습니다.");
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const access = await client.query<{ club_id: string | null; is_master: boolean; assigned: number | string }>(
      `SELECT t.club_id, u.is_master, COUNT(a.teacher_id) AS assigned
         FROM inquiry_cycles c
         JOIN inquiry_sessions s ON s.id = c.session_id
         JOIN teams t ON t.id = s.team_id
         JOIN users u ON u.id = $2 AND u.role = 'teacher' AND u.status = 'active'
         LEFT JOIN club_teacher_assignments a ON a.club_id = t.club_id AND a.teacher_id = u.id
        WHERE c.id = $1 AND t.status = 'active'
        GROUP BY t.club_id, u.is_master`,
      [input.cycleId, input.teacherId],
    );
    const row = access.rows[0];
    if (!row || (row.club_id && !row.is_master && Number(row.assigned) === 0)) {
      throw new UserFacingError("이 탐구 회차를 설정할 권한이 없습니다.");
    }
    const updated = await client.query(
      `UPDATE inquiry_cycles
          SET title = $2, origin = 'configured',
              started_at = $3, ended_at = $4, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'active'`,
      [input.cycleId, title, startedAt, endedAt],
    );
    if (updated.rowCount !== 1) throw new UserFacingError("현재 진행 중인 탐구 회차를 찾을 수 없습니다.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(input.teacherId, "inquiry_cycle_settings_updated", "inquiry_cycle", input.cycleId, {
    title,
    hasStartDate: Boolean(startedAt),
    hasEndDate: Boolean(endedAt),
  });
}
