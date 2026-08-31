import type { PoolClient } from "pg";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { SessionUser } from "@/lib/types";

type Queryable = Pick<PoolClient, "query">;

export const NOTICE_AUDIENCES = ["all", "class", "team"] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];
export type NoticePriority = "normal" | "important";
export type NoticeKind = "announcement" | "action_request";

export type NoticeItem = {
  id: string;
  kind: NoticeKind;
  authorName: string | null;
  title: string;
  content: string;
  audienceType: NoticeAudience;
  targetLabel: string;
  classNumber: number | null;
  teamId: string | null;
  priority: NoticePriority;
  calendarStart: string | null;
  calendarEnd: string | null;
  actionPath: string | null;
  isRead: boolean;
  isResolved: boolean;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type NoticeFeed = {
  notices: NoticeItem[];
  unreadCount: number;
  actionRequiredCount: number;
  unreadImportantCount: number;
  popupNotice: NoticeItem | null;
};

type NoticeRow = {
  id: string;
  kind: NoticeKind;
  author_name: string | null;
  title: string;
  content: string;
  audience_type: NoticeAudience;
  class_number: number | null;
  team_id: string | null;
  team_name: string | null;
  priority: NoticePriority;
  calendar_start: Date | string | null;
  calendar_end: Date | string | null;
  action_path: string | null;
  is_read: boolean;
  is_resolved: boolean;
  status: "active" | "archived";
  created_at: Date | string;
  updated_at: Date | string;
};

export type AnnouncementInput = {
  title: string;
  content: string;
  audienceType: NoticeAudience;
  classNumber?: number | null;
  teamId?: string | null;
  priority: NoticePriority;
  calendarStart?: string | null;
  calendarEnd?: string | null;
};

function assertTeacher(actor: Pick<SessionUser, "role">) {
  if (actor.role !== "teacher") throw new Error("권한이 없습니다.");
}

function assertStudent(actor: Pick<SessionUser, "role">) {
  if (actor.role !== "student") throw new Error("학생만 공지함을 확인할 수 있습니다.");
}

function dateOnly(value: Date | string | null) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function targetLabel(row: Pick<NoticeRow, "audience_type" | "class_number" | "team_name">) {
  if (row.audience_type === "all") return "전체 학생";
  if (row.audience_type === "class") return `${row.class_number ?? "?"}반`;
  return `${row.class_number ?? "?"}반 ${row.team_name ?? "팀"}`;
}

function toNotice(row: NoticeRow): NoticeItem {
  return {
    id: row.id,
    kind: row.kind,
    authorName: row.author_name,
    title: row.title,
    content: row.content,
    audienceType: row.audience_type,
    targetLabel: targetLabel(row),
    classNumber: row.class_number,
    teamId: row.team_id,
    priority: row.priority,
    calendarStart: dateOnly(row.calendar_start),
    calendarEnd: dateOnly(row.calendar_end),
    actionPath: row.action_path,
    isRead: Boolean(row.is_read),
    isResolved: Boolean(row.is_resolved),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function assertSafeAnnouncement(title: string, content: string) {
  const text = `${title}\n${content}`;
  if (/(비밀\s*번호|패스워드|password|api\s*key|secret)/i.test(text) || /(^|\D)1\d{4}(?=\D|$)/.test(text)) {
    throw new Error("공지에는 학생 학번·비밀번호·비밀값을 입력할 수 없습니다.");
  }
}

function normalizeCalendarDate(value: string | null | undefined, label: string) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}을 확인해 주세요.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}을 확인해 주세요.`);
  }
  return value;
}

async function resolveTarget(db: Queryable, input: AnnouncementInput) {
  if (input.audienceType === "all") return { classId: null, teamId: null };
  if (input.audienceType === "class") {
    const result = await db.query<{ id: string }>(
      "SELECT id FROM classes WHERE academic_year = $1 AND class_number = $2",
      [ACADEMIC_YEAR, input.classNumber],
    );
    if (!result.rows[0]) throw new Error("공지할 학급을 확인해 주세요.");
    return { classId: result.rows[0].id, teamId: null };
  }
  const result = await db.query<{ class_id: string }>(
    "SELECT class_id FROM teams WHERE id = $1 AND status = 'active'",
    [input.teamId],
  );
  if (!result.rows[0]) throw new Error("공지할 활성 팀을 확인해 주세요.");
  return { classId: result.rows[0].class_id, teamId: input.teamId! };
}

function normalizeAnnouncement(input: AnnouncementInput) {
  const title = input.title.trim();
  const content = input.content.trim();
  if (title.length < 2 || title.length > 120) throw new Error("공지 제목은 2자 이상 120자 이하로 입력해 주세요.");
  if (content.length < 2 || content.length > 5000) throw new Error("공지 내용은 2자 이상 5000자 이하로 입력해 주세요.");
  assertSafeAnnouncement(title, content);
  const calendarStart = normalizeCalendarDate(input.calendarStart, "일정 시작일");
  const calendarEnd = normalizeCalendarDate(input.calendarEnd, "일정 종료일");
  if (calendarEnd && !calendarStart) throw new Error("일정 종료일을 사용하려면 시작일도 입력해 주세요.");
  if (calendarStart && calendarEnd && calendarEnd < calendarStart) throw new Error("일정 종료일은 시작일보다 빠를 수 없습니다.");
  return { title, content, calendarStart, calendarEnd };
}

export async function listStudentNotices(actor: SessionUser): Promise<NoticeFeed> {
  assertStudent(actor);
  const db = await getDb();
  const result = await db.query<NoticeRow>(
    `SELECT DISTINCT n.id, n.kind, author.name AS author_name, n.title, n.content, n.audience_type,
            c.class_number, n.team_id, t.name AS team_name, n.priority,
            n.calendar_start, n.calendar_end, n.action_path,
            (nr.user_id IS NOT NULL) AS is_read, (n.resolved_at IS NOT NULL) AS is_resolved,
            n.status, n.created_at, n.updated_at,
            CASE WHEN n.kind = 'action_request' AND n.resolved_at IS NULL THEN 0 ELSE 1 END AS action_rank,
            CASE WHEN nr.user_id IS NULL THEN 0 ELSE 1 END AS unread_rank
       FROM notices n
       LEFT JOIN users author ON author.id = n.author_id
       LEFT JOIN classes c ON c.id = n.class_id
       LEFT JOIN teams t ON t.id = n.team_id
       LEFT JOIN team_members recipient ON recipient.team_id = n.team_id AND recipient.user_id = $1 AND recipient.status = 'active'
       LEFT JOIN notice_reads nr ON nr.notice_id = n.id AND nr.user_id = $1
      WHERE n.status = 'active'
        AND (
          n.audience_type = 'all'
          OR (n.audience_type = 'class' AND n.class_id = $2)
          OR (n.audience_type = 'team' AND recipient.user_id IS NOT NULL AND t.status = 'active')
        )
      ORDER BY action_rank, unread_rank, n.created_at DESC, n.id DESC`,
    [actor.id, actor.classId],
  );
  const notices = result.rows.map(toNotice);
  const unread = notices.filter((notice) => !notice.isRead);
  return {
    notices,
    unreadCount: unread.length,
    actionRequiredCount: notices.filter((notice) => notice.kind === "action_request" && !notice.isResolved).length,
    unreadImportantCount: unread.filter((notice) => notice.priority === "important").length,
    popupNotice: unread.find((notice) => notice.priority === "important") ?? null,
  };
}

export async function markNoticeRead(actor: SessionUser, noticeId: string) {
  assertStudent(actor);
  const db = await getDb();
  const accessible = await db.query<{ id: string }>(
    `SELECT n.id FROM notices n
       LEFT JOIN teams t ON t.id = n.team_id
       LEFT JOIN team_members recipient ON recipient.team_id = n.team_id AND recipient.user_id = $2 AND recipient.status = 'active'
      WHERE n.id = $1 AND n.status = 'active'
        AND (
          n.audience_type = 'all'
          OR (n.audience_type = 'class' AND n.class_id = $3)
          OR (n.audience_type = 'team' AND recipient.user_id IS NOT NULL AND t.status = 'active')
        )`,
    [noticeId, actor.id, actor.classId],
  );
  if (!accessible.rows[0]) throw new Error("확인할 수 있는 공지를 찾지 못했습니다.");
  await db.query(
    `INSERT INTO notice_reads (notice_id, user_id) VALUES ($1, $2)
     ON CONFLICT (notice_id, user_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP`,
    [noticeId, actor.id],
  );
}

export async function listTeacherAnnouncements(actor: SessionUser) {
  assertTeacher(actor);
  const db = await getDb();
  const result = await db.query<NoticeRow>(
    `SELECT n.id, n.kind, author.name AS author_name, n.title, n.content, n.audience_type,
            c.class_number, n.team_id, t.name AS team_name, n.priority,
            n.calendar_start, n.calendar_end, n.action_path,
            FALSE AS is_read, (n.resolved_at IS NOT NULL) AS is_resolved,
            n.status, n.created_at, n.updated_at
       FROM notices n
       LEFT JOIN users author ON author.id = n.author_id
       LEFT JOIN classes c ON c.id = n.class_id
       LEFT JOIN teams t ON t.id = n.team_id
      WHERE n.kind = 'announcement'
      ORDER BY CASE WHEN n.status = 'active' THEN 0 ELSE 1 END, n.created_at DESC, n.id DESC`,
  );
  return result.rows.map(toNotice);
}

export async function getNoticeTargetOptions(actor: SessionUser) {
  assertTeacher(actor);
  const db = await getDb();
  const [classes, teams] = await Promise.all([
    db.query<{ class_number: number }>(
      "SELECT class_number FROM classes WHERE academic_year = $1 ORDER BY class_number",
      [ACADEMIC_YEAR],
    ),
    db.query<{ id: string; name: string; class_number: number }>(
      `SELECT t.id, t.name, c.class_number
         FROM teams t JOIN classes c ON c.id = t.class_id
        WHERE t.status = 'active' AND c.academic_year = $1
        ORDER BY c.class_number, t.team_number`,
      [ACADEMIC_YEAR],
    ),
  ]);
  return {
    classes: classes.rows.map((row) => row.class_number),
    teams: teams.rows.map((row) => ({ id: row.id, name: row.name, classNumber: row.class_number })),
  };
}

export async function createAnnouncement(actor: SessionUser, input: AnnouncementInput) {
  assertTeacher(actor);
  const normalized = normalizeAnnouncement(input);
  const db = await getDb();
  const target = await resolveTarget(db, input);
  const id = createId("notice");
  await db.query(
    `INSERT INTO notices
      (id, kind, author_id, title, content, audience_type, class_id, team_id, priority, calendar_start, calendar_end)
     VALUES ($1, 'announcement', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, actor.id, normalized.title, normalized.content, input.audienceType, target.classId, target.teamId,
      input.priority, normalized.calendarStart, normalized.calendarEnd],
  );
  await audit(actor.id, "notice_created", "notice", id, { audienceType: input.audienceType, priority: input.priority });
  return id;
}

export async function updateAnnouncement(actor: SessionUser, noticeId: string, input: AnnouncementInput) {
  assertTeacher(actor);
  const normalized = normalizeAnnouncement(input);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const target = await resolveTarget(client, input);
    const updated = await client.query(
      `UPDATE notices
          SET title = $1, content = $2, audience_type = $3, class_id = $4, team_id = $5,
              priority = $6, calendar_start = $7, calendar_end = $8, updated_at = CURRENT_TIMESTAMP
        WHERE id = $9 AND kind = 'announcement'
        RETURNING id`,
      [normalized.title, normalized.content, input.audienceType, target.classId, target.teamId,
        input.priority, normalized.calendarStart, normalized.calendarEnd, noticeId],
    );
    if (!updated.rows[0]) throw new Error("수정할 공지를 찾지 못했습니다.");
    await client.query("DELETE FROM notice_reads WHERE notice_id = $1", [noticeId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor.id, "notice_updated", "notice", noticeId, { audienceType: input.audienceType, priority: input.priority });
}

export async function setAnnouncementArchived(actor: SessionUser, noticeId: string, archived: boolean) {
  assertTeacher(actor);
  const db = await getDb();
  const result = await db.query(
    `UPDATE notices SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND kind = 'announcement' RETURNING id`,
    [archived ? "archived" : "active", noticeId],
  );
  if (!result.rows[0]) throw new Error("변경할 공지를 찾지 못했습니다.");
  await audit(actor.id, archived ? "notice_archived" : "notice_restored", "notice", noticeId);
}

export async function createActionNotice(
  db: Queryable,
  input: { teacherId: string; teamId: string; sourceType: "plan" | "report"; sourceId: string; content: string },
) {
  await db.query(
    `UPDATE notices SET resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE kind = 'action_request' AND source_type = $1 AND source_id = $2 AND resolved_at IS NULL`,
    [input.sourceType, input.sourceId],
  );
  const team = await db.query<{ class_id: string }>("SELECT class_id FROM teams WHERE id = $1", [input.teamId]);
  if (!team.rows[0]) throw new Error("알림을 보낼 팀을 찾지 못했습니다.");
  const label = input.sourceType === "plan" ? "탐구 계획서" : "팀 최종보고서";
  await db.query(
    `INSERT INTO notices
      (id, kind, author_id, title, content, audience_type, class_id, team_id, priority,
       source_type, source_id, action_path)
     VALUES ($1, 'action_request', $2, $3, $4, 'team', $5, $6, 'important', $7, $8, $9)`,
    [createId("notice"), input.teacherId, `${label} 수정 요청`, input.content.trim(), team.rows[0].class_id,
      input.teamId, input.sourceType, input.sourceId, `/inquiry#${input.sourceType}`],
  );
}

export async function resolveActionNotices(db: Queryable, sourceType: "plan" | "report", sourceId: string) {
  await db.query(
    `UPDATE notices SET resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE kind = 'action_request' AND source_type = $1 AND source_id = $2 AND resolved_at IS NULL`,
    [sourceType, sourceId],
  );
}
