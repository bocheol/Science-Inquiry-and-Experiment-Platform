import { ACADEMIC_YEAR } from "@/lib/constants";
import { getDb } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { UserFacingError } from "@/lib/user-facing-error";

export type PastRecordFilter = "all" | "conversation" | "journal";

export type PastRecordDay = {
  teamId: string;
  cycleId: string;
  date: string;
  activityName: string;
  teamName: string;
  cycleTitle: string;
  cycleStatus: string;
  conversationCount: number;
  journalCount: number;
  representativeTitle: string;
  representativeText: string;
};

export type PastRecordDetail = {
  day: Omit<PastRecordDay, "conversationCount" | "journalCount" | "representativeTitle" | "representativeText">;
  conversations: Array<{
    id: string;
    kind: "ai_question" | "ai_answer" | "peer" | "meeting" | "supplement";
    authorName: string;
    content: string;
    createdAt: string;
  }>;
  journals: Array<{
    id: string;
    studentName: string | null;
    sessionNumber: number;
    activities: string;
    observations: string;
    reflections: string;
    updatedAt: string;
  }>;
};

export class PastRecordAccessError extends UserFacingError {
  constructor(message: string, public readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

const STUDENT_ALLOWED_TEAMS = `
  actor_user AS (
    SELECT id FROM users
     WHERE id = $1 AND role = 'student' AND status = 'active'
       AND must_change_password = FALSE AND academic_year = $2
  ),
  allowed_teams AS (
    SELECT DISTINCT t.id, COALESCE(c.name, cl.name) AS activity_name, t.name AS team_name
      FROM actor_user au
      JOIN team_members tm ON tm.user_id = au.id AND tm.status = 'active'
      JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
      LEFT JOIN classes c ON c.id = t.class_id
      LEFT JOIN clubs cl ON cl.id = t.club_id
     WHERE COALESCE(c.academic_year, cl.academic_year) = $2
       AND ($3::text IS NULL OR t.id = $3)
  )`;

const TEACHER_ALLOWED_TEAMS = `
  actor_user AS (
    SELECT id, is_master FROM users
     WHERE id = $1 AND role = 'teacher' AND status = 'active'
       AND must_change_password = FALSE AND academic_year = $2
  ),
  allowed_teams AS (
    SELECT DISTINCT t.id, COALESCE(c.name, cl.name) AS activity_name, t.name AS team_name
      FROM actor_user au
      JOIN teams t ON TRUE
      LEFT JOIN classes c ON c.id = t.class_id
      LEFT JOIN clubs cl ON cl.id = t.club_id
      LEFT JOIN club_teacher_assignments cta ON cta.club_id = cl.id AND cta.teacher_id = au.id
     WHERE ($3::text IS NULL OR t.id = $3)
       AND (
         (c.id IS NOT NULL AND c.academic_year = $2)
         OR (cl.id IS NOT NULL AND cl.academic_year = $2 AND (au.is_master OR cta.teacher_id IS NOT NULL))
       )
  )`;

function allowedTeamsSql(actor: Pick<SessionUser, "role">) {
  return actor.role === "student" ? STUDENT_ALLOWED_TEAMS : TEACHER_ALLOWED_TEAMS;
}

function asIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asDateOnly(value: Date | string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? new Date(value).toISOString().slice(0, 10);
}

function asSeoulDateOnly(value: Date | string) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function firstSentence(value: string, maxLength = 100) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "내용 없음";
  const sentence = compact.match(/^.*?(?:[.!?。！？](?=\s|$)|$)/u)?.[0] ?? compact;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength).trimEnd()}…` : sentence;
}

export async function listPastRecordDays(
  actor: SessionUser,
  options: { query?: string; filter?: PastRecordFilter; teamId?: string; offset?: number; limit?: number } = {},
) {
  const query = options.query?.trim() ?? "";
  const filter = options.filter ?? "all";
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const db = await getDb();
  type GroupRow = {
    team_id: string; cycle_id: string; activity_date: Date | string; activity_name: string; team_name: string;
    cycle_title: string; cycle_status: string; record_count: string;
    representative_title: string; representative_body: string;
  };
  const params = [actor.id, ACADEMIC_YEAR, options.teamId ?? null];
  const empty = Promise.resolve({ rows: [] as GroupRow[] });
  const [messageGroups, discussionGroups, journalGroups] = await Promise.all([
    filter === "journal" ? empty : db.query<GroupRow>(`WITH ${allowedTeamsSql(actor)}
      SELECT at.id AS team_id, at.activity_name, at.team_name, ic.id AS cycle_id, ic.title AS cycle_title,
             ic.status AS cycle_status, m.created_at AS activity_date,
             '1'::text AS record_count,
             CASE WHEN m.role = 'assistant' THEN 'AI 답변' ELSE '팀 AI 대화' END AS representative_title,
             m.content AS representative_body
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id
        JOIN messages m ON m.session_id = s.id AND m.cycle_id = ic.id
       WHERE m.role IN ('user', 'assistant')`, params),
    filter === "journal" ? empty : db.query<GroupRow>(`WITH ${allowedTeamsSql(actor)}
      SELECT at.id AS team_id, at.activity_name, at.team_name, ic.id AS cycle_id, ic.title AS cycle_title,
             ic.status AS cycle_status, CAST(e.activity_date AS DATE) AS activity_date,
             '1'::text AS record_count,
             CASE e.kind WHEN 'peer' THEN '우리끼리 대화' WHEN 'meeting' THEN '대면 기록' ELSE '보완 기록' END AS representative_title,
             e.content AS representative_body
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id
        JOIN discussion_entries e ON e.session_id = s.id AND e.cycle_id = ic.id
      `, params),
    filter === "conversation" ? empty : db.query<GroupRow>(`WITH ${allowedTeamsSql(actor)}
      SELECT at.id AS team_id, at.activity_name, at.team_name, ic.id AS cycle_id, ic.title AS cycle_title,
             ic.status AS cycle_status, j.journal_date AS activity_date,
             '1'::text AS record_count, j.session_number::text || '차시 개인 일지' AS representative_title,
             j.activities || E'\n' || j.observations || E'\n' || j.reflections AS representative_body
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id
        JOIN experiment_journals j ON j.session_id = s.id AND j.cycle_id = ic.id
       WHERE ${actor.role === "student" ? "j.student_id = $1" : "TRUE"}`, params),
  ]);

  const grouped = new Map<string, PastRecordDay>();
  const merge = (row: GroupRow, recordType: "conversation" | "journal", timestamp = false) => {
    const date = timestamp ? asSeoulDateOnly(row.activity_date) : asDateOnly(row.activity_date);
    const key = `${row.team_id}:${row.cycle_id}:${date}`;
    const previous = grouped.get(key);
    if (previous) {
      if (recordType === "conversation") previous.conversationCount += Number(row.record_count);
      else previous.journalCount += Number(row.record_count);
      return;
    }
    grouped.set(key, {
      teamId: row.team_id, cycleId: row.cycle_id, date, activityName: row.activity_name,
      teamName: row.team_name, cycleTitle: row.cycle_title, cycleStatus: row.cycle_status,
      conversationCount: recordType === "conversation" ? Number(row.record_count) : 0,
      journalCount: recordType === "journal" ? Number(row.record_count) : 0,
      representativeTitle: row.representative_title,
      representativeText: firstSentence(row.representative_body),
    });
  };
  const normalizedQuery = query.toLocaleLowerCase("ko-KR");
  const matches = (row: GroupRow) => !normalizedQuery
    || `${row.representative_title}\n${row.representative_body}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
  for (const row of messageGroups.rows) if (matches(row)) merge(row, "conversation", true);
  for (const row of discussionGroups.rows) if (matches(row)) merge(row, "conversation");
  for (const row of journalGroups.rows) if (matches(row)) merge(row, "journal");
  const allRows = [...grouped.values()].sort((left, right) => right.date.localeCompare(left.date)
    || left.activityName.localeCompare(right.activityName, "ko") || left.teamName.localeCompare(right.teamName, "ko")
    || left.cycleTitle.localeCompare(right.cycleTitle, "ko"));
  const rows = allRows.slice(offset, offset + limit);
  return {
    days: rows,
    hasMore: allRows.length > offset + limit,
  };
}

export async function getPastRecordDay(
  actor: SessionUser,
  input: { teamId: string; cycleId: string; date: string },
): Promise<PastRecordDetail> {
  const db = await getDb();
  const start = new Date(`${input.date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const params = [actor.id, ACADEMIC_YEAR, input.teamId, input.cycleId, input.date, start, end];
  const meta = await db.query<{
    team_id: string; cycle_id: string; activity_name: string; team_name: string; cycle_title: string; cycle_status: string;
  }>(`WITH ${allowedTeamsSql(actor)}
      SELECT at.id AS team_id, ic.id AS cycle_id, at.activity_name, at.team_name,
             ic.title AS cycle_title, ic.status AS cycle_status
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id
       WHERE ic.id = $4
       LIMIT 1`, params.slice(0, 4));
  const selected = meta.rows[0];
  if (!selected) throw new PastRecordAccessError("이 날짜의 기록을 볼 권한이 없습니다.", 403);

  const conversations = await db.query<{
    id: string; kind: PastRecordDetail["conversations"][number]["kind"]; author_name: string;
    content: string; created_at: Date | string;
  }>(`WITH ${allowedTeamsSql(actor)}, conversation_records AS (
      SELECT m.id, CASE WHEN m.role = 'assistant' THEN 'ai_answer' ELSE 'ai_question' END AS kind,
             CASE WHEN m.role = 'assistant' THEN 'AI 연구 조력자' ELSE COALESCE(u.name, '팀원') END AS author_name,
             m.content, m.created_at
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id AND ic.id = $4
        JOIN messages m ON m.session_id = s.id AND m.cycle_id = ic.id
        LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.role IN ('user', 'assistant')
         AND m.created_at >= $6 AND m.created_at < $7
      UNION ALL
      SELECT e.id, e.kind, u.name, e.content, e.created_at
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id AND ic.id = $4
        JOIN discussion_entries e ON e.session_id = s.id AND e.cycle_id = ic.id
        JOIN users u ON u.id = e.author_id
       WHERE e.activity_date = $5
    ) SELECT id, kind, author_name, content, created_at FROM conversation_records ORDER BY created_at, id`, params);

  const journals = await db.query<{
    id: string; student_name: string; session_number: number; activities: string; observations: string;
    reflections: string; updated_at: Date | string;
  }>(`WITH ${allowedTeamsSql(actor)}
      SELECT j.id, u.name AS student_name, j.session_number, j.activities, j.observations,
             j.reflections, j.updated_at
        FROM allowed_teams at
        JOIN inquiry_sessions s ON s.team_id = at.id
        JOIN inquiry_cycles ic ON ic.session_id = s.id AND ic.id = $4
        JOIN experiment_journals j ON j.session_id = s.id AND j.cycle_id = ic.id
        JOIN users u ON u.id = j.student_id
       WHERE j.journal_date = CAST($5 AS DATE)
         AND ${actor.role === "student" ? "j.student_id = $1" : "TRUE"}
       ORDER BY j.session_number DESC, u.login_id`, params.slice(0, 5));

  return {
    day: {
      teamId: selected.team_id,
      cycleId: selected.cycle_id,
      date: input.date,
      activityName: selected.activity_name,
      teamName: selected.team_name,
      cycleTitle: selected.cycle_title,
      cycleStatus: selected.cycle_status,
    },
    conversations: conversations.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      authorName: row.author_name,
      content: row.content,
      createdAt: asIso(row.created_at),
    })),
    journals: journals.rows.map((row) => ({
      id: row.id,
      studentName: actor.role === "teacher" ? row.student_name : null,
      sessionNumber: Number(row.session_number),
      activities: row.activities,
      observations: row.observations,
      reflections: row.reflections,
      updatedAt: asIso(row.updated_at),
    })),
  };
}
