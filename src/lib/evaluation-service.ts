import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";

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
  roundId: string;
  responses: EvaluationResponse<SelfEvaluationValue>[];
  reflections: [string, string];
};

export type PeerEvaluationInput = {
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
    class_id: string;
    template_id: string;
    title: string;
    status: "draft" | "open" | "closed" | "reviewing" | "published";
    template_snapshot: EvaluationTemplateSnapshot | string;
  }>("SELECT id, class_id, template_id, title, status, template_snapshot FROM evaluation_rounds WHERE id = $1", [roundId]);
  const row = result.rows[0];
  if (!row) throw new EvaluationServiceError("평가 회차를 찾을 수 없습니다.", 404);
  return { ...row, template: parseJson(row.template_snapshot, snapshotFrom(CORE_EVALUATION_ITEMS)) };
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

export async function updateEvaluationTemplate(
  teacherId: string,
  input: { roundId: string; title: string; items: EvaluationItem[] },
) {
  const round = await roundRow(input.roundId);
  if (round.status !== "draft") throw new EvaluationServiceError("평가를 연 뒤에는 문항과 행동 기준을 바꿀 수 없습니다.");
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
  const allowed = action === "open"
    ? round.status === "draft"
    : action === "close"
      ? round.status === "open"
      : round.status === "reviewing" || round.status === "closed";
  if (!allowed) throw new EvaluationServiceError("현재 상태에서는 요청한 평가 상태 변경을 할 수 없습니다.");
  const db = await getDb();
  if (action === "open" || action === "reopen") {
    await db.query(
      `UPDATE evaluation_rounds
          SET status = 'open', opened_by = COALESCE(opened_by, $1), opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP),
              closed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [teacherId, roundId],
    );
    await db.query(
      `UPDATE inquiry_sessions SET stage = 'EVALUATING', last_activity_at = CURRENT_TIMESTAMP
        WHERE team_id IN (SELECT id FROM teams WHERE class_id = $1) AND stage <> 'COMPLETED'`,
      [round.class_id],
    );
  } else {
    await db.query(
      "UPDATE evaluation_rounds SET status = 'reviewing', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [roundId],
    );
  }
  await audit(teacherId, `evaluation.round.${action}`, "evaluation_round", roundId);
}

type MemberContext = {
  classId: string;
  teamId: string;
  sessionId: string;
};

async function activeMemberContext(studentId: string): Promise<MemberContext> {
  const db = await getDb();
  const result = await db.query<{ class_id: string; team_id: string; session_id: string }>(
    `SELECT t.class_id, t.id AS team_id, s.id AS session_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
       JOIN users u ON u.id = tm.user_id
      WHERE tm.user_id = $1 AND tm.status = 'active' AND u.status = 'active'
      ORDER BY tm.joined_at DESC LIMIT 1`,
    [studentId],
  );
  const row = result.rows[0];
  if (!row) throw new EvaluationServiceError("현재 팀 평가에 접근할 수 없습니다.", 403);
  return { classId: row.class_id, teamId: row.team_id, sessionId: row.session_id };
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

export async function saveSelfEvaluation(studentId: string, input: SelfEvaluationInput) {
  const context = await activeMemberContext(studentId);
  const round = await roundRow(input.roundId);
  if (round.class_id !== context.classId || round.status !== "open") throw new EvaluationServiceError("현재 자기평가를 제출할 수 없습니다.", 403);
  const responses = validateResponses(round.template.items, input.responses, "self");
  const reflections = input.reflections.map((value) => value.trim()) as [string, string];
  if (reflections.some((value) => !value || value.length > 1_000)) throw new EvaluationServiceError("자기성찰 두 문항을 각각 1,000자 이내로 작성해 주세요.");
  const db = await getDb();
  await db.query(
    `INSERT INTO self_evaluations (id, round_id, session_id, student_id, responses, reflections)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (round_id, student_id) DO UPDATE SET
       session_id = EXCLUDED.session_id, responses = EXCLUDED.responses, reflections = EXCLUDED.reflections,
       submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
    [createId("self_evaluation"), round.id, context.sessionId, studentId, JSON.stringify(responses), JSON.stringify(reflections)],
  );
  await audit(studentId, "evaluation.self.save", "evaluation_round", round.id);
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
  const context = await activeMemberContext(studentId);
  const round = await roundRow(input.roundId);
  if (round.class_id !== context.classId || round.status !== "open") throw new EvaluationServiceError("현재 동료평가를 제출할 수 없습니다.", 403);
  if (studentId === input.evaluateeId) throw new EvaluationServiceError("자기 자신은 동료평가 대상이 아닙니다.");
  const db = await getDb();
  const target = await db.query<{ session_id: string }>(
    `SELECT s.id AS session_id
       FROM team_members tm JOIN inquiry_sessions s ON s.team_id = tm.team_id JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND u.status = 'active'`,
    [context.teamId, input.evaluateeId],
  );
  if (!target.rows[0] || target.rows[0].session_id !== context.sessionId) throw new EvaluationServiceError("현재 함께 활동하는 팀원만 평가할 수 있습니다.", 403);
  const responses = validateResponses(round.template.items, input.responses, "peer");
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
  await db.query(
    `INSERT INTO peer_evaluations
      (id, round_id, session_id, evaluator_id, evaluatee_id, responses, private_evidence, public_comment,
       comment_review_status, redacted_public_comment, flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '', $10)
     ON CONFLICT (round_id, evaluator_id, evaluatee_id) DO UPDATE SET
       session_id = EXCLUDED.session_id, responses = EXCLUDED.responses, private_evidence = EXCLUDED.private_evidence,
       public_comment = EXCLUDED.public_comment, comment_review_status = EXCLUDED.comment_review_status,
       redacted_public_comment = '', flags = EXCLUDED.flags, reviewed_by = NULL, reviewed_at = NULL,
       submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
    [
      createId("peer_evaluation"), round.id, context.sessionId, studentId, input.evaluateeId,
      JSON.stringify(responses), privateEvidence, publicComment, publicComment ? "pending" : "hidden", JSON.stringify(flags),
    ],
  );
  await audit(studentId, "evaluation.peer.save", "evaluation_round", round.id, { evaluateeId: input.evaluateeId, flags });
}

type PeerRow = {
  id: string;
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
  input: { evaluationId: string; status: "approved" | "hidden"; redactedPublicComment: string },
) {
  const db = await getDb();
  const result = await db.query<{ round_id: string; round_status: string; public_comment: string }>(
    `SELECT pe.round_id, er.status AS round_status, pe.public_comment
       FROM peer_evaluations pe JOIN evaluation_rounds er ON er.id = pe.round_id WHERE pe.id = $1`,
    [input.evaluationId],
  );
  const row = result.rows[0];
  if (!row) throw new EvaluationServiceError("동료평가 의견을 찾을 수 없습니다.", 404);
  if (row.round_status !== "reviewing" && row.round_status !== "closed") throw new EvaluationServiceError("평가를 닫은 뒤 의견을 검토해 주세요.");
  const redacted = input.redactedPublicComment.trim();
  if (redacted.length > 200) throw new EvaluationServiceError("학생에게 공개할 의견은 200자 이내여야 합니다.");
  if (input.status === "approved" && !redacted) throw new EvaluationServiceError("승인할 공개 의견을 확인해 주세요.");
  await db.query(
    `UPDATE peer_evaluations SET comment_review_status = $1, redacted_public_comment = $2,
            reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4`,
    [input.status, input.status === "approved" ? redacted : "", teacherId, input.evaluationId],
  );
  await audit(teacherId, `evaluation.comment.${input.status}`, "peer_evaluation", input.evaluationId);
}

export async function saveEvaluationTeacherSummary(
  teacherId: string,
  input: { roundId: string; studentId: string; teacherSummary: string },
) {
  const round = await roundRow(input.roundId);
  if (round.status !== "reviewing" && round.status !== "closed") throw new EvaluationServiceError("평가를 닫은 뒤 종합 피드백을 작성해 주세요.");
  const summary = input.teacherSummary.trim();
  if (summary.length > 2_000) throw new EvaluationServiceError("교사 종합 피드백은 2,000자 이내로 입력해 주세요.");
  const db = await getDb();
  const target = await db.query<{ session_id: string }>(
    `SELECT s.id AS session_id
       FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE u.id = $1 AND t.class_id = $2 ORDER BY tm.joined_at DESC LIMIT 1`,
    [input.studentId, round.class_id],
  );
  if (!target.rows[0]) throw new EvaluationServiceError("평가 대상 학생을 찾을 수 없습니다.", 404);
  await db.query(
    `INSERT INTO evaluation_publications (id, round_id, session_id, student_id, teacher_summary)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (round_id, student_id) DO UPDATE SET teacher_summary = EXCLUDED.teacher_summary, updated_at = CURRENT_TIMESTAMP`,
    [createId("evaluation_publication"), round.id, target.rows[0].session_id, input.studentId, summary],
  );
  await audit(teacherId, "evaluation.summary.save", "evaluation_round", round.id, { studentId: input.studentId });
}

export async function publishEvaluationRound(teacherId: string, roundId: string) {
  const round = await roundRow(roundId);
  if (round.status !== "reviewing" && round.status !== "closed") throw new EvaluationServiceError("평가를 닫고 의견 검토를 마친 뒤 공개해 주세요.");
  const db = await getDb();
  const pending = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM peer_evaluations WHERE round_id = $1 AND public_comment <> '' AND comment_review_status = 'pending'",
    [round.id],
  );
  if (Number(pending.rows[0]?.count ?? 0) > 0) throw new EvaluationServiceError("아직 검토하지 않은 익명 의견이 있습니다.");
  const students = await db.query<{ student_id: string; session_id: string }>(
    `SELECT u.id AS student_id, s.id AS session_id
       FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.class_id = $1 AND tm.status = 'active' AND u.status = 'active'
      ORDER BY u.login_id`,
    [round.class_id],
  );
  const peers = await db.query<PeerRow>(
    `SELECT id, evaluator_id, evaluatee_id, responses, private_evidence, public_comment,
            comment_review_status, redacted_public_comment, flags, submitted_at
       FROM peer_evaluations WHERE round_id = $1`,
    [round.id],
  );
  const existing = await db.query<{ student_id: string; teacher_summary: string }>(
    "SELECT student_id, teacher_summary FROM evaluation_publications WHERE round_id = $1",
    [round.id],
  );
  const summaries = new Map(existing.rows.map((row) => [row.student_id, row.teacher_summary.trim()]));
  const prepared = students.rows.map((student) => {
    const targetRows = peers.rows.filter((row) => row.evaluatee_id === student.student_id);
    const disclosure = disclosureFor(round.template.items, targetRows);
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

  const client = await db.connect();
  try {
    await client.query("BEGIN");
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
      "UPDATE evaluation_rounds SET status = 'published', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [round.id],
    );
    await client.query(
      `UPDATE inquiry_sessions SET stage = 'COMPLETED', last_activity_at = CURRENT_TIMESTAMP
        WHERE team_id IN (SELECT id FROM teams WHERE class_id = $1)`,
      [round.class_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, "evaluation.round.publish", "evaluation_round", round.id, { studentCount: prepared.length });
}

export type EvaluationManagementData = Awaited<ReturnType<typeof getEvaluationManagementData>>;

export async function getEvaluationManagementData(classNumber: number, selectedRoundId?: string) {
  const classId = await classIdForNumber(classNumber);
  const db = await getDb();
  const rounds = await db.query<{
    id: string; title: string; status: "draft" | "open" | "closed" | "reviewing" | "published";
    created_at: Date | string; opened_at: Date | string | null; published_at: Date | string | null;
  }>(
    "SELECT id, title, status, created_at, opened_at, published_at FROM evaluation_rounds WHERE class_id = $1 ORDER BY created_at DESC",
    [classId],
  );
  const selectedId = selectedRoundId && rounds.rows.some((row) => row.id === selectedRoundId) ? selectedRoundId : rounds.rows[0]?.id;
  if (!selectedId) return { classNumber, rounds: [], selected: null };
  const round = await roundRow(selectedId);
  const students = await db.query<{
    student_id: string; name: string; login_id: string; team_id: string; team_name: string; session_id: string;
  }>(
    `SELECT u.id AS student_id, u.name, u.login_id, t.id AS team_id, t.name AS team_name, s.id AS session_id
       FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
       JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.class_id = $1 AND tm.status = 'active' AND u.status = 'active'
      ORDER BY t.team_number, u.login_id`,
    [classId],
  );
  const selfRows = await db.query<{ student_id: string }>("SELECT student_id FROM self_evaluations WHERE round_id = $1", [round.id]);
  const peerRows = await db.query<PeerRow & { evaluator_name: string; evaluatee_name: string; team_name: string }>(
    `SELECT pe.id, pe.evaluator_id, pe.evaluatee_id, pe.responses, pe.private_evidence, pe.public_comment,
            pe.comment_review_status, pe.redacted_public_comment, pe.flags, pe.submitted_at,
            evaluator.name AS evaluator_name, evaluatee.name AS evaluatee_name, t.name AS team_name
       FROM peer_evaluations pe
       JOIN users evaluator ON evaluator.id = pe.evaluator_id
       JOIN users evaluatee ON evaluatee.id = pe.evaluatee_id
       JOIN inquiry_sessions s ON s.id = pe.session_id JOIN teams t ON t.id = s.team_id
      WHERE pe.round_id = $1 ORDER BY t.team_number, evaluatee.login_id, evaluator.login_id`,
    [round.id],
  );
  const publications = await db.query<{ student_id: string; teacher_summary: string; published_at: Date | string | null }>(
    "SELECT student_id, teacher_summary, published_at FROM evaluation_publications WHERE round_id = $1",
    [round.id],
  );
  const selfSet = new Set(selfRows.rows.map((row) => row.student_id));
  const publicationMap = new Map(publications.rows.map((row) => [row.student_id, row]));
  const progress = students.rows.map((student) => {
    const teamSize = students.rows.filter((row) => row.team_id === student.team_id).length;
    const submittedByStudent = peerRows.rows.filter((row) => row.evaluator_id === student.student_id).length;
    const received = peerRows.rows.filter((row) => row.evaluatee_id === student.student_id);
    const disclosure = disclosureFor(round.template.items, received);
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
      published: Boolean(publicationMap.get(student.student_id)?.published_at),
    };
  });
  return {
    classNumber,
    rounds: rounds.rows.map((item) => ({ id: item.id, title: item.title, status: item.status, createdAt: iso(item.created_at), openedAt: iso(item.opened_at), publishedAt: iso(item.published_at) })),
    selected: {
      id: round.id,
      title: round.title,
      status: round.status,
      template: round.template,
      progress,
      peerEvaluations: peerRows.rows.map((row) => ({
        id: row.id,
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

export async function getStudentEvaluationData(studentId: string) {
  const context = await activeMemberContext(studentId);
  const db = await getDb();
  const roundResult = await db.query<{ id: string }>(
    "SELECT id FROM evaluation_rounds WHERE class_id = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 1",
    [context.classId],
  );
  const roundId = roundResult.rows[0]?.id;
  if (!roundId) return null;
  const round = await roundRow(roundId);
  const members = await db.query<{ id: string; name: string; login_id: string }>(
    `SELECT u.id, u.name, u.login_id FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.status = 'active' AND u.status = 'active' ORDER BY u.login_id`,
    [context.teamId],
  );
  const selfResult = await db.query<{ responses: EvaluationResponse<SelfEvaluationValue>[] | string; reflections: [string, string] | string; submitted_at: Date | string }>(
    "SELECT responses, reflections, submitted_at FROM self_evaluations WHERE round_id = $1 AND student_id = $2",
    [round.id, studentId],
  );
  const peerResult = await db.query<PeerRow>(
    `SELECT id, evaluator_id, evaluatee_id, responses, private_evidence, public_comment,
            comment_review_status, redacted_public_comment, flags, submitted_at
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
    round: { id: round.id, title: round.title, status: round.status, template: round.template },
    teammates: members.rows.filter((member) => member.id !== studentId).map((member) => ({ id: member.id, name: member.name, loginId: member.login_id })),
    selfEvaluation: self ? { responses: parseJson(self.responses, []), reflections: parseJson(self.reflections, ["", ""]), submittedAt: iso(self.submitted_at) } : null,
    peerEvaluations: peerResult.rows.map((row) => ({
      evaluateeId: row.evaluatee_id,
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
