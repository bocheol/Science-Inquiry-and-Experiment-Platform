import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { ExperimentJournal, Role, SessionUser } from "@/lib/types";

export const JOURNAL_MAX_IMAGES = 5;
export const JOURNAL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const JOURNAL_ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function detectJournalImageType(data: Buffer): JournalPhotoInput["contentType"] | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export class JournalAccessError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

export type JournalPhotoInput = {
  clientId: string;
  contentType: (typeof JOURNAL_ALLOWED_IMAGE_TYPES)[number];
  fileName: string;
  data: Buffer;
};

export type SaveJournalInput = {
  sessionId: string;
  sessionNumber: number;
  date: string;
  activities: string;
  observations: string;
  reflections: string;
  existingImageIds: string[];
  photos: JournalPhotoInput[];
};

export type TeacherJournalData = {
  members: Array<{
    id: string;
    name: string;
    loginId: string;
    isActive: boolean;
    journals: ExperimentJournal[];
  }>;
};

type JournalRow = {
  id: string;
  session_id: string;
  student_id: string;
  session_number: number;
  journal_date: Date | string;
  activities: string;
  observations: string;
  reflections: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ImageRow = { id: string; journal_id: string; client_id: string; created_at: Date | string };

function isoDate(value: Date | string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toJournal(row: JournalRow, images: ImageRow[]): ExperimentJournal {
  return {
    id: row.id,
    sessionId: row.session_id,
    studentId: row.student_id,
    sessionNumber: row.session_number,
    date: isoDate(row.journal_date),
    activities: row.activities,
    observations: row.observations,
    reflections: row.reflections,
    images: images
      .filter((image) => image.journal_id === row.id)
      .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
      .map((image) => ({ id: image.id, clientId: image.client_id, url: `/api/journal-images/${image.id}` })),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function assertRole(actor: Pick<SessionUser, "role">, role: Role) {
  if (actor.role !== role) throw new JournalAccessError("권한이 없습니다.", 403);
}

async function assertActiveStudentSession(client: PoolClient, studentId: string, sessionId: string) {
  const result = await client.query(
    `SELECT 1
       FROM inquiry_sessions s
       JOIN team_members tm ON tm.team_id = s.team_id
       JOIN teams t ON t.id = s.team_id
       JOIN investigation_plans p ON p.session_id = s.id
       LEFT JOIN material_requests mr ON mr.session_id = s.id
      WHERE s.id = $1
        AND tm.user_id = $2
        AND tm.status = 'active'
        AND t.status = 'active'
        AND p.review_status = 'approved'
        AND mr.id IS NOT NULL
        AND s.stage IN ('EXPERIMENTING', 'REPORTING', 'EXAMINING', 'EVALUATING', 'COMPLETED')
      LIMIT 1`,
    [sessionId, studentId],
  );
  if (!result.rows[0]) throw new JournalAccessError("계획 승인과 준비물 신청을 완료한 현재 팀만 실험 일지에 접근할 수 있습니다.", 403);
}

async function readJournals(client: PoolClient, sessionId: string, studentIds?: string[]) {
  if (studentIds && studentIds.length === 0) return [];
  const journalsResult = await client.query<JournalRow>(
    `SELECT id, session_id, student_id, session_number, journal_date, activities,
            observations, reflections, created_at, updated_at
       FROM experiment_journals
      WHERE session_id = $1
      ORDER BY student_id, session_number DESC`,
    [sessionId],
  );
  const allowedStudentIds = studentIds ? new Set(studentIds) : null;
  const journals = allowedStudentIds
    ? journalsResult.rows.filter((row) => allowedStudentIds.has(row.student_id))
    : journalsResult.rows;
  if (!journals.length) return [];
  const imagesResult = await client.query<ImageRow>(
    `SELECT i.id, i.journal_id, i.client_id, i.created_at
       FROM experiment_journal_images i
       JOIN experiment_journals j ON j.id = i.journal_id
      WHERE j.session_id = $1
      ORDER BY i.created_at`,
    [sessionId],
  );
  return journals.map((row) => toJournal(row, imagesResult.rows));
}

export async function listStudentJournals(actor: SessionUser, sessionId: string) {
  assertRole(actor, "student");
  const db = await getDb();
  const client = await db.connect();
  try {
    await assertActiveStudentSession(client, actor.id, sessionId);
    return await readJournals(client, sessionId, [actor.id]);
  } finally {
    client.release();
  }
}

export async function saveStudentJournal(actor: SessionUser, input: SaveJournalInput) {
  assertRole(actor, "student");
  const db = await getDb();
  const client = await db.connect();
  let journalId = "";
  try {
    await client.query("BEGIN");
    await assertActiveStudentSession(client, actor.id, input.sessionId);
    const journalResult = await client.query<{ id: string }>(
      `INSERT INTO experiment_journals
         (id, session_id, student_id, session_number, journal_date, activities, observations, reflections)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, student_id, session_number) DO UPDATE SET
         journal_date = EXCLUDED.journal_date,
         activities = EXCLUDED.activities,
         observations = EXCLUDED.observations,
         reflections = EXCLUDED.reflections,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        createId("journal"), input.sessionId, actor.id, input.sessionNumber, input.date,
        input.activities, input.observations, input.reflections,
      ],
    );
    journalId = journalResult.rows[0]!.id;

    const currentImages = await client.query<{ id: string; client_id: string }>(
      "SELECT id, client_id FROM experiment_journal_images WHERE journal_id = $1",
      [journalId],
    );
    const validExistingIds = new Set(
      currentImages.rows.filter((image) => input.existingImageIds.includes(image.id)).map((image) => image.id),
    );
    const incomingClientIds = new Set(input.photos.map((photo) => photo.clientId));
    const desiredCount = validExistingIds.size + incomingClientIds.size;
    if (desiredCount > JOURNAL_MAX_IMAGES) {
      throw new JournalAccessError(`사진은 차시당 ${JOURNAL_MAX_IMAGES}장까지 첨부할 수 있습니다.`);
    }

    for (const photo of input.photos) {
      await client.query(
        `INSERT INTO experiment_journal_images
           (id, journal_id, client_id, content_type, file_name, byte_size, image_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (journal_id, client_id) DO UPDATE SET
           content_type = EXCLUDED.content_type,
           file_name = EXCLUDED.file_name,
           byte_size = EXCLUDED.byte_size,
           image_data = EXCLUDED.image_data`,
        [createId("journal_image"), journalId, photo.clientId, photo.contentType, photo.fileName, photo.data.length, photo.data],
      );
    }

    const keepIds = new Set([...validExistingIds]);
    const afterUpload = await client.query<{ id: string; client_id: string }>(
      "SELECT id, client_id FROM experiment_journal_images WHERE journal_id = $1",
      [journalId],
    );
    for (const image of afterUpload.rows) {
      if (incomingClientIds.has(image.client_id)) keepIds.add(image.id);
    }
    for (const image of afterUpload.rows) {
      if (!keepIds.has(image.id)) {
        await client.query("DELETE FROM experiment_journal_images WHERE id = $1 AND journal_id = $2", [image.id, journalId]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await audit(actor.id, "journal.save", "experiment_journal", journalId, {
    sessionId: input.sessionId,
    sessionNumber: input.sessionNumber,
    imageCount: input.existingImageIds.length + input.photos.length,
  });
  const journals = await listStudentJournals(actor, input.sessionId);
  return journals.find((journal) => journal.id === journalId)!;
}

export async function listTeacherTeamJournals(actor: SessionUser, teamId: string): Promise<TeacherJournalData> {
  assertRole(actor, "teacher");
  const db = await getDb();
  const client = await db.connect();
  try {
    const sessionResult = await client.query<{ id: string }>("SELECT id FROM inquiry_sessions WHERE team_id = $1", [teamId]);
    const sessionId = sessionResult.rows[0]?.id;
    if (!sessionId) throw new JournalAccessError("탐구 팀을 찾을 수 없습니다.", 404);
    const memberResult = await client.query<{
      id: string;
      name: string;
      login_id: string;
      status: "active" | "inactive";
      joined_at: Date | string;
    }>(
      `SELECT u.id, u.name, u.login_id, tm.status, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1
        ORDER BY tm.joined_at, u.login_id`,
      [teamId],
    );
    const members = new Map<string, { id: string; name: string; loginId: string; isActive: boolean }>();
    for (const row of memberResult.rows) {
      const previous = members.get(row.id);
      members.set(row.id, {
        id: row.id,
        name: row.name,
        loginId: row.login_id,
        isActive: row.status === "active" || previous?.isActive === true,
      });
    }
    const journals = await readJournals(client, sessionId, [...members.keys()]);
    return {
      members: [...members.values()].map((member) => ({
        ...member,
        journals: journals.filter((journal) => journal.studentId === member.id),
      })),
    };
  } finally {
    client.release();
  }
}

export async function getJournalImage(
  actor: SessionUser,
  imageId: string,
): Promise<{ data: Buffer; contentType: string; fileName: string }> {
  const db = await getDb();
  const result = await db.query<{
    image_data: Buffer;
    content_type: string;
    file_name: string;
    student_id: string;
    session_id: string;
  }>(
    `SELECT i.image_data, i.content_type, i.file_name, j.student_id, j.session_id
       FROM experiment_journal_images i
       JOIN experiment_journals j ON j.id = i.journal_id
      WHERE i.id = $1`,
    [imageId],
  );
  const image = result.rows[0];
  if (!image) throw new JournalAccessError("사진을 찾을 수 없습니다.", 404);
  if (actor.role === "student") {
    if (image.student_id !== actor.id) throw new JournalAccessError("다른 학생의 사진을 볼 수 없습니다.", 403);
    const client = await db.connect();
    try {
      await assertActiveStudentSession(client, actor.id, image.session_id);
    } finally {
      client.release();
    }
  }
  return { data: image.image_data, contentType: image.content_type, fileName: image.file_name };
}
