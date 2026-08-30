import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { SessionUser } from "@/lib/types";

export const TEACHER_REQUEST_CATEGORIES = ["feature", "bug", "question", "other"] as const;
export const TEACHER_REQUEST_STATUSES = ["received", "reviewing", "planned", "resolved"] as const;

export type TeacherRequestCategory = (typeof TEACHER_REQUEST_CATEGORIES)[number];
export type TeacherRequestStatus = (typeof TEACHER_REQUEST_STATUSES)[number];

export type TeacherRequest = {
  id: string;
  authorId: string;
  authorName: string;
  category: TeacherRequestCategory;
  title: string;
  content: string;
  status: TeacherRequestStatus;
  createdAt: string;
  updatedAt: string;
};

export function containsRestrictedTeacherRequestData(value: string) {
  const sensitiveWords = /(비밀\s*번호|패스워드|password|api\s*key|secret|학생\s*(?:이름|성명|학번|실명|자료)|학생의\s*(?:이름|성명|학번|실명|자료)|일지\s*원문)/i;
  const likelyStudentLoginId = /(^|\D)1\d{4}(?=\D|$)/;
  return sensitiveWords.test(value) || likelyStudentLoginId.test(value);
}

function assertTeacher(actor: Pick<SessionUser, "role">) {
  if (actor.role !== "teacher") throw new Error("권한이 없습니다.");
}

function assertSafeText(title: string, content: string) {
  if (containsRestrictedTeacherRequestData(`${title}\n${content}`)) {
    throw new Error("학생 개인정보·학번·비밀번호·학생 자료는 게시판에 입력할 수 없습니다. 해당 내용을 제거해 주세요.");
  }
}

function toTeacherRequest(row: {
  id: string; author_id: string; author_name: string; category: TeacherRequestCategory;
  title: string; content: string; status: TeacherRequestStatus; created_at: Date | string; updated_at: Date | string;
}): TeacherRequest {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    category: row.category,
    title: row.title,
    content: row.content,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listTeacherRequests(actor: SessionUser) {
  assertTeacher(actor);
  const db = await getDb();
  const result = await db.query<{
    id: string; author_id: string; author_name: string; category: TeacherRequestCategory;
    title: string; content: string; status: TeacherRequestStatus; created_at: Date | string; updated_at: Date | string;
  }>(
    `SELECT tr.id, tr.author_id, u.name AS author_name, tr.category, tr.title, tr.content,
            tr.status, tr.created_at, tr.updated_at
       FROM teacher_requests tr JOIN users u ON u.id = tr.author_id
      ORDER BY tr.created_at DESC`,
  );
  return result.rows.map(toTeacherRequest);
}

export async function createTeacherRequest(
  actor: SessionUser,
  input: { category: TeacherRequestCategory; title: string; content: string },
) {
  assertTeacher(actor);
  const title = input.title.trim();
  const content = input.content.trim();
  assertSafeText(title, content);
  const db = await getDb();
  const id = createId("teacher_request");
  await db.query(
    `INSERT INTO teacher_requests (id, author_id, category, title, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, actor.id, input.category, title, content],
  );
  await audit(actor.id, "teacher_request_created", "teacher_request", id, { category: input.category });
  return id;
}

export async function updateTeacherRequestStatus(actor: SessionUser, requestId: string, status: TeacherRequestStatus) {
  assertTeacher(actor);
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    `UPDATE teacher_requests SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING id`,
    [status, requestId],
  );
  if (!result.rows[0]) throw new Error("건의·문의 글을 찾을 수 없습니다.");
  await audit(actor.id, "teacher_request_status_updated", "teacher_request", requestId, { status });
}
