import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { ExperimentJournal, Role, SessionUser } from "@/lib/types";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { UserFacingError } from "@/lib/user-facing-error";

export const JOURNAL_MAX_IMAGES = 5;
export const JOURNAL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const JOURNAL_ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const journalIdFor = (cycleId: string, studentId: string, sessionNumber: number) =>
  `journal_${createHash("sha256").update(JSON.stringify([cycleId, studentId, sessionNumber])).digest("hex")}`;

export function detectJournalImageType(data: Buffer): JournalPhotoInput["contentType"] | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export class JournalAccessError extends UserFacingError {
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
  cycleId?: string;
  sessionNumber: number;
  date: string;
  activities: string;
  observations: string;
  reflections: string;
  expectedVersion: number | null;
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
  cycle_id: string;
  student_id: string;
  session_number: number;
  journal_date: Date | string;
  activities: string;
  observations: string;
  reflections: string;
  write_version: number;
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
    cycleId: row.cycle_id,
    studentId: row.student_id,
    sessionNumber: row.session_number,
    date: isoDate(row.journal_date),
    activities: row.activities,
    observations: row.observations,
    reflections: row.reflections,
    version: row.write_version,
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
  const result = await client.query<{ cycle_id: string }>(
    `SELECT c.id AS cycle_id
       FROM inquiry_sessions s
       JOIN inquiry_cycles c ON c.session_id = s.id AND c.status = 'active'
       JOIN team_members tm ON tm.team_id = s.team_id
       JOIN teams t ON t.id = s.team_id
       JOIN investigation_plans p ON p.session_id = s.id AND p.cycle_id = c.id
       LEFT JOIN material_requests mr ON mr.session_id = s.id AND mr.cycle_id = c.id
      WHERE s.id = $1
        AND tm.user_id = $2
        AND tm.status = 'active'
        AND t.status = 'active'
        AND p.review_status = 'approved'
        AND (mr.id IS NOT NULL OR t.club_id IS NOT NULL)
        AND s.stage IN ('EXPERIMENTING', 'REPORTING', 'EXAMINING', 'EVALUATING', 'COMPLETED')
      LIMIT 1`,
    [sessionId, studentId],
  );
  if (!result.rows[0]) throw new JournalAccessError("계획 승인과 준비물 신청을 완료한 현재 팀만 실험 일지에 접근할 수 있습니다.", 403);
  return result.rows[0].cycle_id;
}

async function readJournals(client: PoolClient, sessionId: string, cycleId: string, studentIds?: string[]) {
  if (studentIds && studentIds.length === 0) return [];
  const journalsResult = await client.query<JournalRow>(
    `SELECT id, session_id, cycle_id, student_id, session_number, journal_date, activities,
            observations, reflections, write_version, created_at, updated_at
       FROM experiment_journals
      WHERE session_id = $1 AND cycle_id = $2
      ORDER BY student_id, session_number DESC`,
    [sessionId, cycleId],
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
      WHERE j.session_id = $1 AND j.cycle_id = $2
      ORDER BY i.created_at`,
    [sessionId, cycleId],
  );
  return journals.map((row) => toJournal(row, imagesResult.rows));
}

async function assertStudentReadCycle(client: PoolClient, studentId: string, sessionId: string, cycleId: string) {
  const result = await client.query<{status: string}>(`SELECT c.status FROM inquiry_cycles c
    JOIN inquiry_sessions s ON s.id = c.session_id
    JOIN teams t ON t.id = s.team_id
    JOIN team_members tm ON tm.team_id = t.id
    JOIN users u ON u.id = tm.user_id
    WHERE c.id = $1 AND s.id = $2 AND tm.user_id = $3
      AND tm.status = 'active' AND t.status = 'active' AND u.status = 'active'`, [cycleId, sessionId, studentId]);
  const cycle = result.rows[0];
  if (!cycle) throw new JournalAccessError("이 회차의 일지를 볼 권한이 없습니다.", 403);
  if (cycle.status === "active") await assertActiveStudentSession(client, studentId, sessionId);
  return cycleId;
}

export async function listStudentJournals(actor: SessionUser, sessionId: string, requestedCycleId?: string) {
  assertRole(actor, "student");
  const db = await getDb();
  const client = await db.connect();
  try {
    const cycleId = requestedCycleId
      ? await assertStudentReadCycle(client, actor.id, sessionId, requestedCycleId)
      : await assertActiveStudentSession(client, actor.id, sessionId);
    return await readJournals(client, sessionId, cycleId, [actor.id]);
  } finally {
    client.release();
  }
}

export async function saveStudentJournal(actor: SessionUser, input: SaveJournalInput) {
  assertRole(actor, "student");
  const db = await getDb();
  const client = await db.connect();
  let journalId = "";
  let savedJournal: ExperimentJournal | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [input.sessionId]);
    const cycleId = await assertActiveStudentSession(client, actor.id, input.sessionId);
    if (input.cycleId !== undefined && input.cycleId !== cycleId) {
      throw new JournalAccessError("탐구 회차가 변경되었습니다. 이전 회차의 일지는 새 회차에 저장할 수 없습니다.", 400);
    }
    // Serializes first creation too; the journal row does not exist yet then.
    // PostgreSQL holds this lock until commit across all service instances.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [actor.id]);
    const found = await client.query<JournalRow>(
      `SELECT id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations,
              reflections, write_version, created_at, updated_at
         FROM experiment_journals
        WHERE session_id = $1 AND cycle_id = $2 AND student_id = $3 AND session_number = $4
        FOR UPDATE`, [input.sessionId, cycleId, actor.id, input.sessionNumber],
    );
    let journal = found.rows[0];
    const currentImages = journal ? await client.query<{
      id: string; journal_id: string; client_id: string; content_type: string; file_name: string; byte_size: number; image_data: Buffer; created_at: Date | string;
    }>(`SELECT id, journal_id, client_id, content_type, file_name, byte_size, image_data, created_at
          FROM experiment_journal_images WHERE journal_id = $1 ORDER BY created_at, id`, [journal.id]) : { rows: [] };
    if (new Set(input.existingImageIds).size !== input.existingImageIds.length
      || new Set(input.photos.map(photo => photo.clientId)).size !== input.photos.length) {
      throw new JournalAccessError("같은 사진이 중복되어 있습니다. 사진 목록을 다시 확인해 주세요.");
    }
    const byId = new Map(currentImages.rows.map(image => [image.id, image]));
    const byClientId = new Map(currentImages.rows.map(image => [image.client_id, image]));
    if (input.existingImageIds.some(id => !byId.has(id))) throw new FormWriteConflict("다른 기기에서 사진 목록을 변경했습니다. 최신 내용과 내 초안을 비교해 주세요.");
    for (const photo of input.photos) {
      const stored = byClientId.get(photo.clientId);
      if (stored && (stored.content_type !== photo.contentType || stored.file_name !== photo.fileName
        || stored.byte_size !== photo.data.length || !stored.image_data.equals(photo.data))) {
        throw new FormWriteConflict("같은 사진 식별자의 내용이 다릅니다. 최신 내용과 내 초안을 비교해 주세요.");
      }
    }
    const keepIds = new Set(input.existingImageIds);
    for (const photo of input.photos) {
      const stored = byClientId.get(photo.clientId);
      if (stored) keepIds.add(stored.id);
    }
    const desiredCount = keepIds.size + input.photos.filter(photo => !byClientId.has(photo.clientId)).length;
    if (desiredCount > JOURNAL_MAX_IMAGES) {
      throw new JournalAccessError(`사진은 차시당 ${JOURNAL_MAX_IMAGES}장까지 첨부할 수 있습니다.`);
    }
    const sameText = journal && isoDate(journal.journal_date) === input.date
      && journal.activities === input.activities && journal.observations === input.observations && journal.reflections === input.reflections;
    const sameImages = journal && currentImages.rows.length === desiredCount && currentImages.rows.every(image => keepIds.has(image.id));
    if (sameText && sameImages) {
      journalId = journal!.id;
      await client.query("COMMIT");
      return toJournal(journal!, currentImages.rows);
    }
    if (journal) {
      if (input.expectedVersion !== journal.write_version) throw new FormWriteConflict();
      const updated = await client.query<JournalRow>(
        `UPDATE experiment_journals SET journal_date = $1, activities = $2, observations = $3,
             reflections = $4, write_version = write_version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $5 AND write_version = $6
          RETURNING id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations,
                    reflections, write_version, created_at, updated_at`,
        [input.date, input.activities, input.observations, input.reflections, journal.id, input.expectedVersion],
      );
      if (!updated.rows[0]) throw new FormWriteConflict();
      journal = updated.rows[0];
    } else {
      if (input.expectedVersion !== null || input.existingImageIds.length) throw new FormWriteConflict();
      const inserted = await client.query<JournalRow>(
        `INSERT INTO experiment_journals
           (id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations, reflections, write_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
         ON CONFLICT (cycle_id, student_id, session_number) DO NOTHING
         RETURNING id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations,
                   reflections, write_version, created_at, updated_at`,
        [journalIdFor(cycleId, actor.id, input.sessionNumber), input.sessionId, cycleId, actor.id, input.sessionNumber, input.date, input.activities, input.observations, input.reflections],
      );
      if (!inserted.rows[0]) throw new FormWriteConflict();
      journal = inserted.rows[0];
    }
    journalId = journal.id;
    for (const photo of input.photos) {
      if (byClientId.has(photo.clientId)) continue;
      await client.query(
        `INSERT INTO experiment_journal_images
           (id, journal_id, client_id, content_type, file_name, byte_size, image_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (journal_id, client_id) DO NOTHING`,
        [createId("journal_image"), journalId, photo.clientId, photo.contentType, photo.fileName, photo.data.length, photo.data],
      );
    }

    const afterUpload = await client.query<{ id: string; client_id: string }>(
      "SELECT id, client_id FROM experiment_journal_images WHERE journal_id = $1",
      [journalId],
    );
    for (const image of afterUpload.rows) if (input.photos.some(photo => photo.clientId === image.client_id)) keepIds.add(image.id);
    for (const image of afterUpload.rows) {
      if (!keepIds.has(image.id)) {
        await client.query("DELETE FROM experiment_journal_images WHERE id = $1 AND journal_id = $2", [image.id, journalId]);
      }
    }
    const savedImages = await client.query<ImageRow>(
      "SELECT id, journal_id, client_id, created_at FROM experiment_journal_images WHERE journal_id = $1 ORDER BY created_at, id",
      [journalId],
    );
    savedJournal = toJournal(journal, savedImages.rows);
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
  return savedJournal!;
}

export async function listTeacherTeamJournals(actor: SessionUser, teamId: string, requestedCycleId?: string): Promise<TeacherJournalData> {
  assertRole(actor, "teacher");
  const db = await getDb();
  const client = await db.connect();
  try {
    const sessionResult = await client.query<{ id: string; cycle_id: string }>(`SELECT s.id, c.id AS cycle_id FROM inquiry_sessions s
      JOIN inquiry_cycles c ON c.session_id = s.id WHERE s.team_id = $1 AND ($2::text IS NULL OR c.id = $2)
      ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.ordinal DESC LIMIT 1`, [teamId, requestedCycleId ?? null]);
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
    const journals = await readJournals(client, sessionId, sessionResult.rows[0]!.cycle_id, [...members.keys()]);
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
    cycle_id: string;
  }>(
    `SELECT i.image_data, i.content_type, i.file_name, j.student_id, j.session_id, j.cycle_id
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
      await assertStudentReadCycle(client, actor.id, image.session_id, image.cycle_id);
    } finally {
      client.release();
    }
  }
  return { data: image.image_data, contentType: image.content_type, fileName: image.file_name };
}
