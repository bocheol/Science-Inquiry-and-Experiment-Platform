import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { FormWriteConflict, sameFormValue } from "@/lib/form-write-conflict";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";

export type EvaluationLevel = 1 | 2 | 3 | 4;
export type PeerEvaluationValue = EvaluationLevel | "unable_to_judge";
export type SelfEvaluationValue = EvaluationLevel | "activity_unavailable";

export type EvaluationItem = {
  id: string;
  prompt: string;
  levels: Record<"1" | "2" | "3" | "4", string>;
  optional?: boolean;
};

export type EvaluationTemplateSnapshot = {
  items: EvaluationItem[];
  selfReflectionQuestions: [string, string];
};

export type EvaluationResponse<T extends PeerEvaluationValue | SelfEvaluationValue = PeerEvaluationValue | SelfEvaluationValue> = {
  itemId: string;
  value: T;
  reason: string;
};

export type SelfEvaluationInput = {
  expectedVersion?: number | null;
  roundId: string;
  responses: EvaluationResponse<SelfEvaluationValue>[];
  reflections: [string, string];
};

export type PeerEvaluationInput = {
  expectedVersion?: number | null;
  roundId: string;
  evaluateeId: string;
  responses: EvaluationResponse<PeerEvaluationValue>[];
  privateEvidence: string;
  publicComment: string;
  confirmed: boolean;
};

export class EvaluationServiceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const CORE_EVALUATION_ITEMS: EvaluationItem[] = [
  {
    id: "role_commitment",
    prompt: "맡은 역할과 약속한 일을 수행했다",
    levels: {
      "4": "약속한 일을 기한 안에 꾸준히 완료하고, 문제가 예상되면 미리 알리고 조정했다.",
      "3": "대부분 완료했으며 가끔 안내나 작은 수정만 필요했다.",
      "2": "반복적인 재촉·지연이 있었고 팀 일정이나 다른 팀원의 부담에 영향을 주었다.",
      "1": "활동 기회가 있었지만 대부분 수행하지 않아 다른 팀원이 대신했다.",
    },
  },
  {
    id: "visible_output",
    prompt: "확인 가능한 결과물을 남겼다",
    levels: {
      "4": "측정값·사진·표·자료 조사·초안 등 정확하고 활용 가능한 결과물을 꾸준히 공유했다.",
      "3": "맡은 결과물을 제출했고 작은 수정 후 활용할 수 있었다.",
      "2": "결과물이 불완전하거나 불명확해 큰 수정이 필요했다.",
      "1": "확인할 수 있는 결과물을 거의 남기지 않았다.",
    },
  },
  {
    id: "problem_solving",
    prompt: "문제가 생겼을 때 해결에 참여했다",
    levels: {
      "4": "원인이나 제약을 찾고 근거 있는 해결책을 제안·실행했다.",
      "3": "해결 논의에 참여하고 합의한 조치를 수행했다.",
      "2": "여러 번 요청받은 뒤에만 참여했거나 제안 후 실행하지 않았다.",
      "1": "참여할 기회가 있었지만 문제 해결을 피하거나 방해했다.",
    },
  },
  {
    id: "collaboration",
    prompt: "팀원의 의견을 존중하고 정보를 공유했다",
    levels: {
      "4": "의견을 듣고 연결하며 필요한 정보를 제때 공유하고 의견 차이를 존중 있게 조정했다.",
      "3": "대체로 의견을 존중하고 의사결정과 정보 공유에 참여했다.",
      "2": "무시·말 끊기·정보 누락이 반복되어 중재가 필요했다.",
      "1": "조롱·배제·강요 등 협업을 해치는 행동이 반복되었다.",
    },
  },
];

export const OPTIONAL_EVALUATION_ITEMS = {
  safety: {
    id: "safety_and_integrity",
    prompt: "안전 수칙을 지키고 관찰 결과를 사실대로 기록했다",
    levels: {
      "4": "안전 수칙을 스스로 꾸준히 지키고 실제 관찰 결과를 빠짐없이 사실대로 기록하며 위험을 발견하면 바로 알렸다.",
      "3": "대체로 안전 수칙과 사실 기록을 지켰고 가끔 확인만 필요했다.",
      "2": "안전 또는 기록 원칙을 여러 번 안내받아야 했고 누락·부정확한 기록을 크게 수정했다.",
      "1": "반복적으로 안전 수칙을 어기거나 사실과 다른 기록을 남겨 교사의 개입이 필요했다.",
    },
    optional: true,
  },
  theory: {
    id: "theory_inquiry",
    prompt: "질문·자료 확인·개념 연결을 통해 이론 탐구에 기여했다",
    levels: {
      "4": "스스로 질문하고 출처를 확인하며 과학 개념을 실험 설계나 결과 해석에 꾸준히 연결했다.",
      "3": "질문·자료 확인·개념 연결 중 맡은 활동에 참여해 팀 탐구에 활용 가능한 내용을 제공했다.",
      "2": "안내를 여러 번 받은 뒤 제한적으로 참여했고 제공한 내용을 활용하려면 큰 보완이 필요했다.",
      "1": "참여할 기회가 있었지만 이론 탐구에 확인 가능한 기여를 거의 하지 않았다.",
    },
    optional: true,
  },
} satisfies Record<string, EvaluationItem>;

const DEFAULT_REFLECTIONS: [string, string] = [
  "이번 탐구에서 내가 실제로 한 가장 중요한 일 한 가지와 확인할 수 있는 근거는 무엇인가?",
  "다음 탐구에서 바꾸거나 더 잘하고 싶은 행동 한 가지는 무엇인가?",
];

function parseJson<T>(value: T | string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeItem(item: EvaluationItem): EvaluationItem {
  const prompt = item.prompt.trim();
  if (!/^[a-z0-9_]{2,60}$/i.test(item.id) || !prompt || prompt.length > 160) {
    throw new EvaluationServiceError("평가 문항의 제목과 식별자를 확인해 주세요.");
  }
  const levels = {} as EvaluationItem["levels"];
  for (const level of ["1", "2", "3", "4"] as const) {
    const text = item.levels[level]?.trim();
    if (!text || text.length > 500) throw new EvaluationServiceError("모든 단계에 관찰 가능한 행동 기준을 입력해 주세요.");
    levels[level] = text;
  }
  return { id: item.id, prompt, levels, optional: Boolean(item.optional) };
}

function normalizeItems(items: EvaluationItem[]) {
  if (items.length < 4 || items.length > 5) throw new EvaluationServiceError("평가 문항은 핵심 4개와 선택 문항 최대 1개로 구성해 주세요.");
  const normalized = items.map(normalizeItem);
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new EvaluationServiceError("평가 문항 식별자가 중복되었습니다.");
  return normalized;
}

function snapshotFrom(items: EvaluationItem[]): EvaluationTemplateSnapshot {
  return { items: normalizeItems(items), selfReflectionQuestions: DEFAULT_REFLECTIONS };
}

async function classIdForNumber(classNumber: number) {
  if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > 9) throw new EvaluationServiceError("학급을 확인해 주세요.");
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    "SELECT id FROM classes WHERE academic_year = $1 AND class_number = $2",
    [ACADEMIC_YEAR, classNumber],
  );
  if (!result.rows[0]) throw new EvaluationServiceError("학급을 찾을 수 없습니다.", 404);
  return result.rows[0].id;
}

async function roundRow(roundId: string, client?: PoolClient) {
  const db = client ?? await getDb();
  const result = await db.query<{
    id: string;
    class_id: string | null;
    club_id: string | null;
    template_id: string;
    title: string;
    status: "draft" | "open" | "closed" | "reviewing" | "published";
    template_snapshot: EvaluationTemplateSnapshot | string;
    peer_template_snapshot: EvaluationTemplateSnapshot | string | null;
  }>("SELECT id, class_id, club_id, template_id, title, status, template_snapshot, peer_template_snapshot FROM evaluation_rounds WHERE id = $1", [roundId]);
  const row = result.rows[0];
  if (!row) throw new EvaluationServiceError("평가 회차를 찾을 수 없습니다.", 404);
  const template = parseJson(row.template_snapshot, snapshotFrom(CORE_EVALUATION_ITEMS));
  return { ...row, template, peerTemplate: parseJson(row.peer_template_snapshot, template) };
}

async function assertClubEvaluationAccess(teacherId: string, clubId: string) {
  const db = await getDb();
  const actor = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1 AND role = 'teacher' AND status = 'active'", [teacherId]);
  if (!actor.rows[0]) throw new EvaluationServiceError("교사 권한이 없습니다.", 403);
  const allowed = actor.rows[0].is_master
    ? await db.query("SELECT 1 FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR])
    : await db.query(`SELECT 1 FROM club_teacher_assignments a JOIN clubs c ON c.id = a.club_id
        WHERE a.club_id = $1 AND a.teacher_id = $2 AND c.academic_year = $3`, [clubId, teacherId, ACADEMIC_YEAR]);
  if (!allowed.rows[0]) throw new EvaluationServiceError("이 동아리의 평가 운영 권한이 없습니다.", 403);
}

async function assertRoundTeacherAccess(teacherId: string, round: Awaited<ReturnType<typeof roundRow>>) {
  if (round.club_id) await assertClubEvaluationAccess(teacherId, round.club_id);
  else {
    const db = await getDb();
    const current = await db.query("SELECT id FROM classes WHERE id = $1 AND academic_year = $2", [round.class_id, ACADEMIC_YEAR]);
    if (!current.rows[0]) throw new EvaluationServiceError("현재 학년도 평가를 선택해 주세요.", 404);
  }
}

export async function createEvaluationRound(
  teacherId: string,
  input: { classNumber: number; title: string; optionalItem: "none" | "safety" | "theory" },
) {
  const classId = await classIdForNumber(input.classNumber);
  const title = input.title.trim();
  if (!title || title.length > 100) throw new EvaluationServiceError("평가 제목은 1~100자로 입력해 주세요.");
  const db = await getDb();
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM evaluation_rounds WHERE class_id = $1 AND status <> 'published' ORDER BY created_at DESC LIMIT 1",
    [classId],
  );
  if (existing.rows[0]) throw new EvaluationServiceError("이 학급에는 아직 완료되지 않은 평가 회차가 있습니다.");

  const items = [...CORE_EVALUATION_ITEMS];
  if (input.optionalItem !== "none") items.push(OPTIONAL_EVALUATION_ITEMS[input.optionalItem]);
  const snapshot = snapshotFrom(items);
  const templateId = createId("evaluation_template");
  const roundId = createId("evaluation_round");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO evaluation_templates (id, academic_year, items, self_reflection_questions, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [templateId, ACADEMIC_YEAR, JSON.stringify(snapshot.items), JSON.stringify(snapshot.selfReflectionQuestions), teacherId],
    );
    await client.query(
      `INSERT INTO evaluation_rounds (id, class_id, template_id, title, template_snapshot)
       VALUES ($1, $2, $3, $4, $5)`,
      [roundId, classId, templateId, title, JSON.stringify(snapshot)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, "evaluation.round.create", "evaluation_round", roundId, { classNumber: input.classNumber, itemCount: items.length });
  return roundId;
}

export async function createClubEvaluationRound(teacherId: string, input: { clubId: string; title: string }) {
  await assertClubEvaluationAccess(teacherId, input.clubId);
  const title = input.title.trim();
  if (!title || title.length > 100) throw new EvaluationServiceError("평가 제목은 1~100자로 입력해 주세요.");
  const db = await getDb();
  const configs = await db.query<{ id: string; config_type: "self_evaluation" | "peer_evaluation"; definition: EvaluationTemplateSnapshot | string }>(
    `SELECT id, config_type, definition FROM club_config_versions
      WHERE club_id = $1 AND config_key = 'default' AND status = 'published'
        AND config_type IN ('self_evaluation', 'peer_evaluation')`, [input.clubId],
  );
  const selfConfig = configs.rows.find((row) => row.config_type === "self_evaluation");
  const peerConfig = configs.rows.find((row) => row.config_type === "peer_evaluation");
  if (!selfConfig || !peerConfig) throw new EvaluationServiceError("자기평가와 동료평가 설정을 모두 발행한 뒤 평가를 만들어 주세요.");
  const existing = await db.query("SELECT 1 FROM evaluation_rounds WHERE club_id = $1 AND status <> 'published' LIMIT 1", [input.clubId]);
  if (existing.rows[0]) throw new EvaluationServiceError("이 동아리에는 아직 완료되지 않은 평가 회차가 있습니다.");
  const selfDefinition = parseJson(selfConfig.definition, snapshotFrom(CORE_EVALUATION_ITEMS));
  const peerDefinition = parseJson(peerConfig.definition, snapshotFrom(CORE_EVALUATION_ITEMS));
  const selfSnapshot: EvaluationTemplateSnapshot = {
    items: normalizeItems(selfDefinition.items),
    selfReflectionQuestions: Array.isArray(selfDefinition.selfReflectionQuestions) && selfDefinition.selfReflectionQuestions.length === 2
      ? selfDefinition.selfReflectionQuestions as [string, string] : DEFAULT_REFLECTIONS,
  };
  const peerSnapshot: EvaluationTemplateSnapshot = { items: normalizeItems(peerDefinition.items), selfReflectionQuestions: DEFAULT_REFLECTIONS };
  const templateId = createId("evaluation_template");
  const roundId = createId("evaluation_round");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO evaluation_templates (id, academic_year, items, self_reflection_questions, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [templateId, ACADEMIC_YEAR, JSON.stringify(selfSnapshot.items), JSON.stringify(selfSnapshot.selfReflectionQuestions), teacherId]);
    await client.query(`INSERT INTO evaluation_rounds
      (id, club_id, template_id, title, template_snapshot, peer_template_snapshot, config_version_id, peer_config_version_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [roundId, input.clubId, templateId, title, JSON.stringify(selfSnapshot), JSON.stringify(peerSnapshot), selfConfig.id, peerConfig.id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(teacherId, "evaluation.club_round.create", "evaluation_round", roundId, { clubId: input.clubId });
  return roundId;
}

export async function updateEvaluationTemplate(
  teacherId: string,
  input: { roundId: string; title: string; items: EvaluationItem[] },
) {
  const round = await roundRow(input.roundId);
  await assertRoundTeacherAccess(teacherId, round);
  if (round.status !== "draft") throw new EvaluationServiceError("평가를 연 뒤에는 문항과 행동 기준을 바꿀 수 없습니다.");
  if (round.club_id) throw new EvaluationServiceError("동아리 평가 문항은 동아리 설정에서 새 버전을 발행한 뒤 새 회차에 적용해 주세요.");
  const title = input.title.trim();
  if (!title || title.length > 100) throw new EvaluationServiceError("평가 제목은 1~100자로 입력해 주세요.");
  const snapshot = snapshotFrom(input.items);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE evaluation_templates SET items = $1, self_reflection_questions = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
      [JSON.stringify(snapshot.items), JSON.stringify(snapshot.selfReflectionQuestions), round.template_id],
    );
    await client.query(
      "UPDATE evaluation_rounds SET title = $1, template_snapshot = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
      [title, JSON.stringify(snapshot), round.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, "evaluation.template.update", "evaluation_round", round.id, { itemCount: snapshot.items.length });
}

export async function changeEvaluationRoundStatus(
  teacherId: string,
  roundId: string,
  action: "open" | "close" | "reopen",
) {
  const round = await roundRow(roundId);
  await assertRoundTeacherAccess(teacherId, round);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: typeof round.status }>("SELECT status FROM evaluation_rounds WHERE id = $1 FOR UPDATE", [roundId]);
    const status = locked.rows[0]?.status;
    const allowed = action === "open"
      ? status === "draft"
      : action === "close"
        ? status === "open"
        : status === "reviewing" || status === "closed";
    if (!allowed) throw new EvaluationServiceError("현재 상태에서는 요청한 평가 상태 변경을 할 수 없습니다.");
    if (action === "open" || action === "reopen") {
      await client.query(
        `UPDATE evaluation_rounds
            SET status = 'open', opened_by = COALESCE(opened_by, $1), opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP),
                closed_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [teacherId, roundId],
      );
      const column = round.club_id ? "club_id" : "class_id";
      await client.query(`UPDATE inquiry_sessions SET stage = 'EVALUATING', last_activity_at = CURRENT_TIMESTAMP
          WHERE team_id IN (SELECT id FROM teams WHERE ${column} = $1 AND status = 'active') AND stage <> 'COMPLETED'`, [round.club_id ?? round.class_id]);
    } else {
      await client.query(
        "UPDATE evaluation_rounds SET status = 'reviewing', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [roundId],
      );
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(teacherId, `evaluation.round.${action}`, "evaluation_round", roundId);
}

type MemberContext = {
  classId: string | null;
  clubId: string | null;
  teamId: string;
  sessionId: string;
};

async function activeMemberContext(studentId: string, teamId?: string, classId?: string | null, clubId?: string | null): Promise<MemberContext> {
  const db = await getDb();
  const result = await db.query<{ class_id: string | null; club_id: string | null; team_id: string; session_id: string }>(
    `SELECT t.class_id, t.club_id, t.id AS team_id, s.id AS session_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE tm.user_id = $1 AND ($2::text IS NULL OR t.id = $2)
        AND ($3::text IS NULL OR t.class_id = $3) AND ($4::text IS NULL OR t.club_id = $4)
        AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR} AND t.status = 'active'
        AND COALESCE(c.academic_year, cl.academic_year) = ${ACADEMIC_YEAR}
      ORDER BY tm.joined_at DESC LIMIT 1`,
    [studentId, teamId ?? null, classId ?? null, clubId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new EvaluationServiceError("현재 팀 평가에 접근할 수 없습니다.", 403);
  return { classId: row.class_id, clubId: row.club_id, teamId: row.team_id, sessionId: row.session_id };
}

function validateResponses<T extends PeerEvaluationValue | SelfEvaluationValue>(
  items: EvaluationItem[],
  responses: EvaluationResponse<T>[],
  mode: "self" | "peer",
) {
  const itemIds = new Set(items.map((item) => item.id));
  if (responses.length !== items.length || new Set(responses.map((response) => response.itemId)).size !== items.length) {
    throw new EvaluationServiceError("모든 평가 문항에 한 번씩 응답해 주세요.");
  }
  return responses.map((response) => {
    if (!itemIds.has(response.itemId)) throw new EvaluationServiceError("현재 평가 문항과 응답이 일치하지 않습니다.");
    const valid = mode === "self"
      ? [1, 2, 3, 4, "activity_unavailable"].includes(response.value)
      : [1, 2, 3, 4, "unable_to_judge"].includes(response.value);
    if (!valid) throw new EvaluationServiceError("평가 단계를 확인해 주세요.");
    const reason = response.reason.trim();
    if (typeof response.value === "string" && (!reason || reason.length > 500)) {
      throw new EvaluationServiceError(mode === "self" ? "활동 기회가 없었던 이유를 입력해 주세요." : "판단하기 어려운 이유를 입력해 주세요.");
    }
    if (reason.length > 500) throw new EvaluationServiceError("평가 사유는 500자 이내로 입력해 주세요.");
    return { itemId: response.itemId, value: response.value, reason };
  });
}

// The round lock serializes a student write with the teacher's closing UPDATE.
// No network calls occur in this short transaction. Column names are internal constants.
async function writeEvaluation(
  table: "self_evaluations" | "peer_evaluations", keys: Record<string, string>,
  authored: Record<string, unknown>, resets: Record<string, unknown>, expectedVersion?: number | null,
) {
  const client = await (await getDb()).connect();
  const columns = { ...keys, ...authored, ...resets };
  const names = Object.keys(columns);
  const encode = (value: unknown) => value !== null && typeof value === "object" ? JSON.stringify(value) : value;
  const values = Object.values(columns).map(encode);
  const where = Object.keys(keys).map((key, index) => `${key} = $${index + 1}`).join(" AND ");
  try {
    await client.query("BEGIN");
    const round = await client.query("SELECT status FROM evaluation_rounds WHERE id = $1 FOR UPDATE", [keys.round_id]);
    if (round.rows[0]?.status !== "open") throw new EvaluationServiceError("평가 입력이 마감되었습니다. 작성 초안은 유지됩니다.", 403);
    // The earlier UI/context checks can become stale during a team change.
    // Lock the session before students (also used by journal writes), then use
    // the membership writers' student/team order through the actual save.
    const session = await client.query<{ team_id: string }>(
      "SELECT team_id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [authored.session_id],
    );
    if (!session.rows[0]) throw new EvaluationServiceError("현재 팀 평가에 접근할 수 없습니다.", 403);
    const participants = table === "self_evaluations" ? [keys.student_id!] : [keys.evaluator_id!, keys.evaluatee_id!];
    await lockStudentsTeams(client, participants, [session.rows[0].team_id]);
    for (const participant of participants) {
      const membership = await client.query(
        `SELECT u.id FROM users u
          JOIN team_members tm ON tm.user_id = u.id
          JOIN teams t ON t.id = tm.team_id
          JOIN evaluation_rounds er ON er.id = $3
          LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
         WHERE u.id = $1 AND t.id = $2
           AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}
           AND tm.status = 'active' AND t.status = 'active'
           AND COALESCE(c.academic_year, cl.academic_year) = ${ACADEMIC_YEAR}
           AND ((er.club_id IS NOT NULL AND t.club_id = er.club_id)
             OR (er.club_id IS NULL AND t.club_id IS NULL AND t.class_id = er.class_id))`,
        [participant, session.rows[0].team_id, keys.round_id],
      );
      if (!membership.rows[0]) throw new EvaluationServiceError("팀 소속이나 계정 상태가 변경되었습니다. 현재 팀 평가를 다시 확인해 주세요.", 403);
    }
    const current = await client.query(`SELECT * FROM ${table} WHERE ${where}`, Object.values(keys));
    const row = current.rows[0];
    // A retry after a lost success response must not reset teacher comment review.
    if (row && Object.entries(authored).every(([name, value]) => sameFormValue(typeof value === "object" && value !== null ? parseJson(row[name], null) : row[name], value))) {
      await client.query("COMMIT");
      return { version: row.write_version as number };
    }
    if ((row?.write_version ?? null) !== (expectedVersion ?? null)) throw new FormWriteConflict();
    const result = row
      ? await client.query<{ write_version: number }>(`UPDATE ${table} SET ${names.filter((name) => !(name in keys)).map((name) => `${name} = $${names.indexOf(name) + 1}`).join(", ")},
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1
          WHERE ${where} AND write_version = $${values.length + 1} RETURNING write_version`, [...values, expectedVersion])
      : await client.query<{ write_version: number }>(`INSERT INTO ${table} (id, ${names.join(", ")}, write_version)
          VALUES ($${values.length + 1}, ${names.map((_, index) => `$${index + 1}`).join(", ")}, 1)
          ON CONFLICT DO NOTHING RETURNING write_version`, [...values, createId(table)]);
    if (!result.rows[0]) throw new FormWriteConflict();
    await client.query("COMMIT");
    return { version: result.rows[0].write_version };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function saveSelfEvaluation(studentId: string, input: SelfEvaluationInput) {
  const round = await roundRow(input.roundId);
  const context = await activeMemberContext(studentId, undefined, round.class_id, round.club_id);
  if ((round.class_id ? round.class_id !== context.classId : round.club_id !== context.clubId) || round.status !== "open") throw new EvaluationServiceError("현재 자기평가를 제출할 수 없습니다.", 403);
  const responses = validateResponses(round.template.items, input.responses, "self");
  const reflections = input.reflections.map((value) => value.trim()) as [string, string];
  if (reflections.some((value) => !value || value.length > 1_000)) throw new EvaluationServiceError("자기성찰 두 문항을 각각 1,000자 이내로 작성해 주세요.");
  const saved = await writeEvaluation("self_evaluations", { round_id: round.id, student_id: studentId },
    { session_id: context.sessionId, responses, reflections }, {}, input.expectedVersion);
  await audit(studentId, "evaluation.self.save", "evaluation_round", round.id);
  return saved;
}

function peerFlags(responses: EvaluationResponse<PeerEvaluationValue>[], publicComment: string) {
  const flags: string[] = [];
  const levels = responses.map((response) => response.value).filter((value): value is EvaluationLevel => typeof value === "number");
  if (levels.length >= 4 && new Set(levels).size === 1) flags.push("uniform_levels");
  if (levels.length >= 4 && levels.every((value) => value === 1 || value === 4)) flags.push("extreme_pattern");
  if (/(죽어|병신|멍청|꺼져|혐오|보복)/i.test(publicComment)) flags.push("suspect_language");
  return flags;
}

export async function savePeerEvaluation(studentId: string, input: PeerEvaluationInput) {
  if (!input.confirmed) throw new EvaluationServiceError("직접 본 행동만 평가한다는 확인이 필요합니다.");
  const round = await roundRow(input.roundId);
  const context = await activeMemberContext(studentId, undefined, round.class_id, round.club_id);
  if ((round.class_id ? round.class_id !== context.classId : round.club_id !== context.clubId) || round.status !== "open") throw new EvaluationServiceError("현재 동료평가를 제출할 수 없습니다.", 403);
  if (studentId === input.evaluateeId) throw new EvaluationServiceError("자기 자신은 동료평가 대상이 아닙니다.");
  const db = await getDb();
  const target = await db.query<{ session_id: string }>(
    `SELECT s.id AS session_id
       FROM team_members tm JOIN inquiry_sessions s ON s.team_id = tm.team_id JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}`,
    [context.teamId, input.evaluateeId],
  );
  if (!target.rows[0] || target.rows[0].session_id !== context.sessionId) throw new EvaluationServiceError("현재 함께 활동하는 팀원만 평가할 수 있습니다.", 403);
  const responses = validateResponses(round.peerTemplate.items, input.responses, "peer");
  const privateEvidence = input.privateEvidence.trim();
  const publicComment = input.publicComment.trim();
  if (privateEvidence.length > 1_000 || publicComment.length > 200) throw new EvaluationServiceError("교사용 근거는 1,000자, 공개 의견은 200자 이내로 입력해 주세요.");
  if (responses.some((response) => response.value === 1 || response.value === 2) && !privateEvidence) {
    throw new EvaluationServiceError("1·2단계를 선택한 경우 교사가 확인할 관찰 근거를 입력해 주세요.");
  }
  const flags = peerFlags(responses, publicComment);
  if (publicComment) {
    const candidates = await db.query<{ id: string; public_comment: string }>(
      `SELECT id, public_comment FROM peer_evaluations
        WHERE round_id = $1 AND evaluator_id = $2 AND evaluatee_id <> $3 AND public_comment <> ''`,
      [round.id, studentId, input.evaluateeId],
    );
    if (candidates.rows.some((row) => row.public_comment.trim().toLocaleLowerCase("ko-KR") === publicComment.toLocaleLowerCase("ko-KR"))) {
      flags.push("duplicate_comment");
    }
  }
  const saved = await writeEvaluation("peer_evaluations", { round_id: round.id, evaluator_id: studentId, evaluatee_id: input.evaluateeId },
    { session_id: context.sessionId, responses, private_evidence: privateEvidence, public_comment: publicComment },
    { comment_review_status: publicComment ? "pending" : "hidden", redacted_public_comment: "", flags, reviewed_by: null, reviewed_at: null }, input.expectedVersion);
  await audit(studentId, "evaluation.peer.save", "evaluation_round", round.id, { evaluateeId: input.evaluateeId, flags });
  return saved;
}

type PeerRow = {
  id: string;
  session_id: string;
  evaluator_id: string;
  evaluatee_id: string;
  responses: EvaluationResponse<PeerEvaluationValue>[] | string;
  private_evidence: string;
  public_comment: string;
  comment_review_status: "pending" | "approved" | "hidden";
  redacted_public_comment: string;
  flags: string[] | string;
  submitted_at: Date | string;
};

function disclosureFor(items: EvaluationItem[], rows: PeerRow[]) {
  const averages: Record<string, number> = {};
  const validCounts: Record<string, number> = {};
  for (const item of items) {
    const levels = rows.flatMap((row) => {
      const response = parseJson(row.responses, []).find((entry) => entry.itemId === item.id);
      return response && typeof response.value === "number" ? [response.value] : [];
    });
    validCounts[item.id] = levels.length;
    if (levels.length >= 3) averages[item.id] = Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length * 10) / 10;
  }
  return { averages, validCounts, eligible: items.every((item) => validCounts[item.id] >= 3) };
}

export async function reviewPeerComment(
  teacherId: string,
  input: { evaluationId: string; status: "approved" | "hidden"; redactedPublicComment: string; expectedVersion?: number },
) {
  const db = await getDb();
  const result = await db.query<{ round_id: string }>("SELECT round_id FROM peer_evaluations WHERE id = $1", [input.evaluationId]);
  const roundId = result.rows[0]?.round_id;
  if (!roundId) throw new EvaluationServiceError("동료평가 의견을 찾을 수 없습니다.", 404);
  await assertRoundTeacherAccess(teacherId, await roundRow(roundId));
  const redacted = input.redactedPublicComment.trim();
  if (redacted.length > 200) throw new EvaluationServiceError("학생에게 공개할 의견은 200자 이내여야 합니다.");
  if (input.status === "approved" && !redacted) throw new EvaluationServiceError("승인할 공개 의견을 확인해 주세요.");
  const client = await db.connect();
  let version = 0;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT status FROM evaluation_rounds WHERE id = $1 FOR UPDATE", [roundId]);
    if (!["closed", "reviewing"].includes(locked.rows[0]?.status)) throw new EvaluationServiceError("평가 상태가 변경되었습니다. 평가를 닫은 뒤 다시 확인해 주세요.");
    const current = await client.query<{ write_version: number; comment_review_status: string; redacted_public_comment: string }>(
      "SELECT write_version, comment_review_status, redacted_public_comment FROM peer_evaluations WHERE id = $1 FOR UPDATE",
      [input.evaluationId],
    );
    const row = current.rows[0];
    if (!row) throw new EvaluationServiceError("동료평가 의견을 찾을 수 없습니다.", 404);
    const desired = input.status === "approved" ? redacted : "";
    if (row.comment_review_status === input.status && row.redacted_public_comment === desired) {
      version = row.write_version;
      await client.query("COMMIT");
      return { version };
    }
    if (input.expectedVersion === undefined || input.expectedVersion !== row.write_version) throw new FormWriteConflict();
    const reviewed = await client.query<{ write_version: number }>(
      `UPDATE peer_evaluations SET comment_review_status = $1, redacted_public_comment = $2,
               reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1
        WHERE id = $4 AND write_version = $5 RETURNING write_version`,
      [input.status, input.status === "approved" ? redacted : "", teacherId, input.evaluationId, row.write_version],
    );
    if (!reviewed.rows[0]) throw new FormWriteConflict();
    version = reviewed.rows[0].write_version;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(teacherId, `evaluation.comment.${input.status}`, "peer_evaluation", input.evaluationId);
  return { version };
}

export async function saveEvaluationTeacherSummary(
  teacherId: string,
  input: { roundId: string; studentId: string; teacherSummary: string; expectedVersion: number | null },
) {
  const round = await roundRow(input.roundId);
  await assertRoundTeacherAccess(teacherId, round);
  const summary = input.teacherSummary.trim();
  if (summary.length > 2_000) throw new EvaluationServiceError("교사 종합 피드백은 2,000자 이내로 입력해 주세요.");
  const db = await getDb();
  const targetColumn = round.club_id ? "club_id" : "class_id";
  const client = await db.connect();
  let version = 0;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT status FROM evaluation_rounds WHERE id = $1 FOR UPDATE", [round.id]);
    if (!["closed", "reviewing"].includes(locked.rows[0]?.status)) throw new EvaluationServiceError("평가 상태가 변경되었습니다. 평가를 닫은 뒤 다시 확인해 주세요.");
    const target = await client.query<{ session_id: string }>(
      `SELECT s.id AS session_id
         FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
         JOIN inquiry_sessions s ON s.team_id = t.id
        WHERE u.id = $1 AND t.${targetColumn} = $2
          AND t.status = 'active' AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}
        ORDER BY tm.joined_at DESC LIMIT 1`,
      [input.studentId, round.club_id ?? round.class_id],
    );
    if (!target.rows[0]) throw new EvaluationServiceError("평가 대상 학생을 찾을 수 없습니다.", 404);
    const current = await client.query<{ teacher_summary: string; write_version: number }>(
      "SELECT teacher_summary, write_version FROM evaluation_publications WHERE round_id = $1 AND student_id = $2 FOR UPDATE",
      [round.id, input.studentId],
    );
    const row = current.rows[0];
    if (row?.teacher_summary === summary) {
      version = row.write_version;
      await client.query("COMMIT");
      return { version };
    }
    if ((row?.write_version ?? null) !== input.expectedVersion) throw new FormWriteConflict();
    const saved = row
      ? await client.query<{ write_version: number }>(
        `UPDATE evaluation_publications SET teacher_summary = $1, session_id = $2,
                updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1
          WHERE round_id = $3 AND student_id = $4 AND write_version = $5 RETURNING write_version`,
        [summary, target.rows[0].session_id, round.id, input.studentId, input.expectedVersion],
      )
      : await client.query<{ write_version: number }>(
        `INSERT INTO evaluation_publications (id, round_id, session_id, student_id, teacher_summary, write_version)
         VALUES ($1, $2, $3, $4, $5, 1) ON CONFLICT DO NOTHING RETURNING write_version`,
        [createId("evaluation_publication"), round.id, target.rows[0].session_id, input.studentId, summary],
      );
    if (!saved.rows[0]) throw new FormWriteConflict();
    version = saved.rows[0].write_version;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(teacherId, "evaluation.summary.save", "evaluation_round", round.id, { studentId: input.studentId });
  return { version };
}

export async function publishEvaluationRound(teacherId: string, roundId: string) {
  const round = await roundRow(roundId);
  await assertRoundTeacherAccess(teacherId, round);
  const db = await getDb();
  const targetColumn = round.club_id ? "club_id" : "class_id";
  const client = await db.connect();
  let studentCount = 0;
  try {
    await client.query("BEGIN");
    const lockedRound = await client.query<{ status: string }>("SELECT status FROM evaluation_rounds WHERE id = $1 FOR UPDATE", [round.id]);
    if (lockedRound.rows[0]?.status === "published") {
      await client.query("COMMIT");
      return { published: false, studentCount: 0 };
    }
    if (!["closed", "reviewing"].includes(lockedRound.rows[0]?.status)) {
      throw new EvaluationServiceError("평가를 닫고 의견 검토를 마친 뒤 공개해 주세요.");
    }

    // Membership writers use the same student-then-team lock order. Re-read after
    // taking the locks so one publication batch uses one stable active roster.
    const candidates = await client.query<{ student_id: string; team_id: string }>(
      `SELECT u.id AS student_id, t.id AS team_id
         FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
        WHERE t.${targetColumn} = $1
          AND t.status = 'active' AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}`,
      [round.club_id ?? round.class_id],
    );
    // Publication updates sessions too. Take these before student/team locks,
    // matching journal/evaluation writers rather than waiting in reverse order.
    const lockedSessions = new Set<string>();
    for (const teamId of [...new Set(candidates.rows.map(row => row.team_id))].sort()) {
      const sessions = await client.query<{ id: string }>(
        "SELECT id FROM inquiry_sessions WHERE team_id = $1 ORDER BY id FOR UPDATE", [teamId],
      );
      for (const session of sessions.rows) lockedSessions.add(session.id);
    }
    await lockStudentsTeams(client, candidates.rows.map((row) => row.student_id), candidates.rows.map((row) => row.team_id));
    const students = await client.query<{ student_id: string; session_id: string; team_id: string }>(
      `SELECT u.id AS student_id, s.id AS session_id, t.id AS team_id
         FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
         JOIN inquiry_sessions s ON s.team_id = t.id
        WHERE t.${targetColumn} = $1
          AND t.status = 'active' AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}
        ORDER BY u.login_id`,
      [round.club_id ?? round.class_id],
    );
    const candidateIds = new Set(candidates.rows.map(row => row.student_id));
    if (students.rows.some(student => !candidateIds.has(student.student_id) || !lockedSessions.has(student.session_id))) {
      throw new EvaluationServiceError("평가 대상 팀원이 변경되었습니다. 최신 명단과 교사 피드백을 확인한 뒤 다시 공개해 주세요.", 409);
    }
    const peers = await client.query<PeerRow>(
      `SELECT id, session_id, evaluator_id, evaluatee_id, responses, private_evidence, public_comment,
              comment_review_status, redacted_public_comment, flags, submitted_at
         FROM peer_evaluations WHERE round_id = $1`,
      [round.id],
    );
    const currentSessionByStudent = new Map(students.rows.map((student) => [student.student_id, student.session_id]));
    if (peers.rows.some((row) => row.public_comment.trim() && row.comment_review_status === "pending"
      && currentSessionByStudent.get(row.evaluatee_id) === row.session_id)) {
      throw new EvaluationServiceError("아직 검토하지 않은 익명 의견이 있습니다.");
    }
    const existing = await client.query<{ student_id: string; teacher_summary: string }>(
      "SELECT student_id, teacher_summary FROM evaluation_publications WHERE round_id = $1",
      [round.id],
    );
    const summaries = new Map(existing.rows.map((row) => [row.student_id, row.teacher_summary.trim()]));
    const prepared = students.rows.map((student) => {
      const targetRows = peers.rows.filter((row) => row.evaluatee_id === student.student_id && row.session_id === student.session_id);
      const disclosure = disclosureFor(round.peerTemplate.items, targetRows);
      if (!disclosure.eligible && !summaries.get(student.student_id)) {
        throw new EvaluationServiceError("유효 평가가 3건 미만인 학생에게 교사 종합 피드백을 작성해 주세요.");
      }
      const comments = disclosure.eligible
        ? targetRows
          .filter((row) => row.comment_review_status === "approved" && row.redacted_public_comment.trim())
          .sort((a, b) => createHash("sha256").update(`${round.id}:${student.student_id}:${a.id}`).digest("hex").localeCompare(createHash("sha256").update(`${round.id}:${student.student_id}:${b.id}`).digest("hex")))
          .map((row) => row.redacted_public_comment.trim())
        : [];
      return { ...student, averages: disclosure.averages, comments, teacherSummary: summaries.get(student.student_id) ?? "" };
    });
    studentCount = prepared.length;
    for (const student of prepared) {
      await client.query(
        `INSERT INTO evaluation_publications
          (id, round_id, session_id, student_id, peer_averages, approved_comments, teacher_summary, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
         ON CONFLICT (round_id, student_id) DO UPDATE SET
           session_id = EXCLUDED.session_id, peer_averages = EXCLUDED.peer_averages,
           approved_comments = EXCLUDED.approved_comments, teacher_summary = EXCLUDED.teacher_summary,
           published_by = EXCLUDED.published_by, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [
          createId("evaluation_publication"), round.id, student.session_id, student.student_id,
          JSON.stringify(student.averages), JSON.stringify(student.comments), student.teacherSummary, teacherId,
        ],
      );
    }
    await client.query(
      "UPDATE evaluation_rounds SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('closed', 'reviewing')",
      [round.id],
    );
    for (const teamId of [...new Set(students.rows.map((student) => student.team_id))].sort()) {
      await client.query("UPDATE inquiry_sessions SET stage = 'COMPLETED', last_activity_at = CURRENT_TIMESTAMP WHERE team_id = $1", [teamId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, "evaluation.round.publish", "evaluation_round", round.id, { studentCount });
  return { published: true, studentCount };
}

async function getEvaluationManagementDataForTarget(
  target: { classNumber: number | null; classId: string | null; clubId: string | null; label: string },
  selectedRoundId?: string,
) {
  const db = await getDb();
  const targetColumn = target.clubId ? "club_id" : "class_id";
  const rounds = await db.query<{
    id: string; title: string; status: "draft" | "open" | "closed" | "reviewing" | "published";
    created_at: Date | string; opened_at: Date | string | null; published_at: Date | string | null;
  }>(
    `SELECT id, title, status, created_at, opened_at, published_at FROM evaluation_rounds
      WHERE ${targetColumn} = $1
      ORDER BY CASE WHEN status = 'published' THEN 1 ELSE 0 END, created_at DESC, id DESC`,
    [target.clubId ?? target.classId],
  );
  const selectedId = selectedRoundId && rounds.rows.some((row) => row.id === selectedRoundId) ? selectedRoundId : rounds.rows[0]?.id;
  if (!selectedId) return { classNumber: target.classNumber, clubId: target.clubId, scopeLabel: target.label, rounds: [], selected: null };
  const round = await roundRow(selectedId);
  const students = await db.query<{
    student_id: string; name: string; login_id: string; team_id: string; team_name: string; session_id: string;
  }>(
    `SELECT u.id AS student_id, u.name, u.login_id, t.id AS team_id, t.name AS team_name, s.id AS session_id
       FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.${targetColumn} = $1
        AND t.status = 'active' AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR}
      ORDER BY t.team_number, u.login_id`,
    [target.clubId ?? target.classId],
  );
  const selfRows = await db.query<{ student_id: string }>("SELECT student_id FROM self_evaluations WHERE round_id = $1", [round.id]);
  const peerRows = await db.query<PeerRow & { evaluator_name: string; evaluatee_name: string; team_name: string; write_version: number }>(
    `SELECT pe.id, pe.session_id, pe.evaluator_id, pe.evaluatee_id, pe.responses, pe.private_evidence, pe.public_comment,
            pe.comment_review_status, pe.redacted_public_comment, pe.flags, pe.submitted_at, pe.write_version,
            evaluator.name AS evaluator_name, evaluatee.name AS evaluatee_name, t.name AS team_name
       FROM peer_evaluations pe
       JOIN users evaluator ON evaluator.id = pe.evaluator_id
       JOIN users evaluatee ON evaluatee.id = pe.evaluatee_id
       JOIN inquiry_sessions s ON s.id = pe.session_id JOIN teams t ON t.id = s.team_id
      WHERE pe.round_id = $1 ORDER BY t.team_number, evaluatee.login_id, evaluator.login_id`,
    [round.id],
  );
  const publications = await db.query<{ student_id: string; teacher_summary: string; published_at: Date | string | null; write_version: number }>(
    "SELECT student_id, teacher_summary, published_at, write_version FROM evaluation_publications WHERE round_id = $1",
    [round.id],
  );
  const selfSet = new Set(selfRows.rows.map((row) => row.student_id));
  const publicationMap = new Map(publications.rows.map((row) => [row.student_id, row]));
  const progress = students.rows.map((student) => {
    const teamSize = students.rows.filter((row) => row.team_id === student.team_id).length;
    const submittedByStudent = peerRows.rows.filter((row) => row.evaluator_id === student.student_id && row.session_id === student.session_id).length;
    const received = peerRows.rows.filter((row) => row.evaluatee_id === student.student_id && row.session_id === student.session_id);
    const disclosure = disclosureFor(round.peerTemplate.items, received);
    return {
      studentId: student.student_id,
      name: student.name,
      loginId: student.login_id,
      teamId: student.team_id,
      teamName: student.team_name,
      selfSubmitted: selfSet.has(student.student_id),
      peerSubmitted: submittedByStudent,
      peerExpected: Math.max(0, teamSize - 1),
      peerReceived: received.length,
      validCounts: disclosure.validCounts,
      disclosureEligible: disclosure.eligible,
      teacherSummary: publicationMap.get(student.student_id)?.teacher_summary ?? "",
      teacherSummaryVersion: publicationMap.get(student.student_id)?.write_version ?? null,
      published: Boolean(publicationMap.get(student.student_id)?.published_at),
    };
  });
  return {
    classNumber: target.classNumber,
    clubId: target.clubId,
    scopeLabel: target.label,
    rounds: rounds.rows.map((item) => ({ id: item.id, title: item.title, status: item.status, createdAt: iso(item.created_at), openedAt: iso(item.opened_at), publishedAt: iso(item.published_at) })),
    selected: {
      id: round.id,
      title: round.title,
      status: round.status,
      template: round.template,
      peerTemplate: round.peerTemplate,
      progress,
      peerEvaluations: peerRows.rows.map((row) => ({
        id: row.id,
        version: row.write_version,
        evaluatorId: row.evaluator_id,
        evaluatorName: row.evaluator_name,
        evaluateeId: row.evaluatee_id,
        evaluateeName: row.evaluatee_name,
        teamName: row.team_name,
        responses: parseJson(row.responses, []),
        privateEvidence: row.private_evidence,
        publicComment: row.public_comment,
        commentReviewStatus: row.comment_review_status,
        redactedPublicComment: row.redacted_public_comment,
        flags: parseJson(row.flags, []),
        submittedAt: iso(row.submitted_at),
      })),
    },
  };
}

async function accessibleEvaluationClubs(teacherId?: string) {
  if (!teacherId) return [];
  const db = await getDb();
  const actor = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1", [teacherId]);
  const result = actor.rows[0]?.is_master
    ? await db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE academic_year = $1 ORDER BY name", [ACADEMIC_YEAR])
    : await db.query<{ id: string; name: string }>(`SELECT c.id, c.name FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id
        WHERE c.academic_year = $1 AND a.teacher_id = $2 ORDER BY c.name`, [ACADEMIC_YEAR, teacherId]);
  return result.rows;
}

export async function getEvaluationManagementData(classNumber: number, selectedRoundId?: string, teacherId?: string) {
  const classId = await classIdForNumber(classNumber);
  return { ...(await getEvaluationManagementDataForTarget({ classNumber, classId, clubId: null, label: `${classNumber}반` }, selectedRoundId)), availableClubs: await accessibleEvaluationClubs(teacherId) };
}

export async function getClubEvaluationManagementData(teacherId: string, clubId: string, selectedRoundId?: string) {
  await assertClubEvaluationAccess(teacherId, clubId);
  const db = await getDb();
  const club = await db.query<{ name: string }>("SELECT name FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR]);
  if (!club.rows[0]) throw new EvaluationServiceError("동아리를 찾을 수 없습니다.", 404);
  return { ...(await getEvaluationManagementDataForTarget({ classNumber: null, classId: null, clubId, label: club.rows[0].name }, selectedRoundId)), availableClubs: await accessibleEvaluationClubs(teacherId) };
}

export type EvaluationManagementData = Awaited<ReturnType<typeof getEvaluationManagementData>> | Awaited<ReturnType<typeof getClubEvaluationManagementData>>;

export async function getStudentEvaluationData(studentId: string, teamId?: string) {
  const context = await activeMemberContext(studentId, teamId);
  const db = await getDb();
  const targetColumn = context.clubId ? "club_id" : "class_id";
  const roundResult = await db.query<{ id: string }>(
    `SELECT id FROM evaluation_rounds WHERE ${targetColumn} = $1 AND status <> 'draft'
      ORDER BY CASE WHEN status = 'published' THEN 1 ELSE 0 END, created_at DESC, id DESC LIMIT 1`,
    [context.clubId ?? context.classId],
  );
  const roundId = roundResult.rows[0]?.id;
  if (!roundId) return null;
  const round = await roundRow(roundId);
  const members = await db.query<{ id: string; name: string; login_id: string }>(
    `SELECT u.id, u.name, u.login_id FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = ${ACADEMIC_YEAR} ORDER BY u.login_id`,
    [context.teamId],
  );
  const selfResult = await db.query<{ responses: EvaluationResponse<SelfEvaluationValue>[] | string; reflections: [string, string] | string; submitted_at: Date | string; write_version: number }>(
    "SELECT responses, reflections, submitted_at, write_version FROM self_evaluations WHERE round_id = $1 AND student_id = $2",
    [round.id, studentId],
  );
  const peerResult = await db.query<PeerRow & { write_version: number }>(
    `SELECT id, evaluator_id, evaluatee_id, responses, private_evidence, public_comment,
            comment_review_status, redacted_public_comment, flags, submitted_at, write_version
       FROM peer_evaluations WHERE round_id = $1 AND evaluator_id = $2`,
    [round.id, studentId],
  );
  const publication = await db.query<{
    peer_averages: Record<string, number> | string;
    approved_comments: string[] | string;
    teacher_summary: string;
    published_at: Date | string | null;
  }>(
    "SELECT peer_averages, approved_comments, teacher_summary, published_at FROM evaluation_publications WHERE round_id = $1 AND student_id = $2",
    [round.id, studentId],
  );
  const self = selfResult.rows[0];
  const published = publication.rows[0];
  return {
    round: { id: round.id, title: round.title, status: round.status, template: round.template, peerTemplate: round.peerTemplate },
    teammates: members.rows.filter((member) => member.id !== studentId).map((member) => ({ id: member.id, name: member.name, loginId: member.login_id })),
    selfEvaluation: self ? { responses: parseJson(self.responses, []), reflections: parseJson(self.reflections, ["", ""]), submittedAt: iso(self.submitted_at), version: self.write_version } : null,
    peerEvaluations: peerResult.rows.map((row) => ({
      evaluateeId: row.evaluatee_id,
      version: row.write_version,
      responses: parseJson(row.responses, []),
      privateEvidence: row.private_evidence,
      publicComment: row.public_comment,
      submittedAt: iso(row.submitted_at),
    })),
    result: round.status === "published" && published?.published_at ? {
      peerAverages: parseJson(published.peer_averages, {}),
      approvedComments: parseJson(published.approved_comments, []),
      teacherSummary: published.teacher_summary,
      publishedAt: iso(published.published_at),
    } : null,
  };
}
