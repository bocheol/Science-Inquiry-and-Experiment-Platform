import type { PoolClient } from "pg";
import { ACADEMIC_YEAR, PLAN_FIELDS, REPORT_FIELDS } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { openAiExamGenerator, type ExamGenerator, type ExamSourceItem, type GeneratedExamQuestion, type TeamExamSource } from "@/lib/exam-ai";
import { createId } from "@/lib/id";
import { aiRequestKey, beginAiJob, completeAiJob, failAiJob, ownsAiJob, runAiJobStep } from "@/lib/ai-jobs";
import { getExamDocumentSources } from "@/lib/exam-document-sources";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";

export type ExamScope = "common" | "team" | "individual";
export type ExamDifficulty = "basic" | "standard" | "advanced";

export type ExamQuestion = {
  id: string;
  examSetId: string;
  scope: ExamScope;
  teamId: string | null;
  studentId: string | null;
  sequence: number;
  stimulus: string;
  question: string;
  questionType: "multiple_choice" | "short_answer" | "constructed";
  competency: string;
  difficulty: ExamDifficulty;
  maxScore: number;
  modelAnswer: string;
  scoringRubric: Array<{ criterion: string; points: number }>;
  sourceEvidence: Array<{ sourceType: string; sourceLabel: string; sourceKey: string; excerpt: string }>;
  isAiGenerated: boolean;
};

export type ExamPaper = {
  examId: string;
  studentId: string;
  studentName: string;
  loginId: string;
  teamId: string;
  teamName: string;
  classNumber: number | null;
  status: string;
  result: null | {
    questionScores: Record<string, number>;
    totalScore: number;
    teacherFeedback: string;
    gradedAt: string | null;
    publishedAt: string | null;
  };
};

export type ExamSetData = {
  id: string;
  title: string;
  classNumber: number | null;
  clubId: string | null;
  activityLabel: string;
  status: "draft" | "confirmed";
  commonCount: number;
  teamCount: number;
  individualCount: number;
  totalScore: number;
  commonScope: string;
  generatedAt: string;
  confirmedAt: string | null;
  revisionNumber: number;
  parentExamSetId: string | null;
  correctionReason: string | null;
  questions: ExamQuestion[];
  papers: ExamPaper[];
};

export type ExamManagementData = {
  classNumber: number | null;
  clubId: string | null;
  activityLabel: string;
  availableClubs: Array<{ id: string; name: string }>;
  defaultConfig: null | { title: string; commonCount: number; teamCount: number; individualCount: number; totalScore: number; commonScope: string; configVersionId: string };
  sets: Array<{
    id: string;
    title: string;
    classNumber: number | null;
    status: "draft" | "confirmed";
    generatedAt: string;
    revisionNumber: number;
    parentExamSetId: string | null;
  }>;
  selected: ExamSetData | null;
};

export type GenerateExamInput = {
  classNumber?: number;
  clubId?: string;
  title: string;
  commonCount: number;
  teamCount: number;
  individualCount: number;
  totalScore: number;
  commonScope: string;
  configVersionId?: string;
};

export class ExamServiceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type PreparedStudent = { id: string; ref: string; source: { studentRef: string; sources: ExamSourceItem[] } };
type PreparedTeam = { id: string; sessionId: string; source: TeamExamSource; students: PreparedStudent[] };

function parseJson<T>(value: T | string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function stringifySource(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function redact(value: unknown, replacements: string[], maxLength = 1_200) {
  let text = stringifySource(value).replace(/\s+/g, " ").trim();
  for (const replacement of replacements.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(replacement).join("[비식별화]");
  }
  text = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[이메일 제거]")
    .replace(/(?:01[016789]|0\d{1,2})[-. ]?\d{3,4}[-. ]?\d{4}/g, "[연락처 제거]");
  return text.slice(0, maxLength);
}

function questionScores(counts: { common: number; team: number; individual: number }, total: number) {
  const weights = { common: 60, team: 25, individual: 15 };
  const scopes = (Object.keys(counts) as ExamScope[]).filter((scope) => counts[scope] > 0);
  const activeWeight = scopes.reduce((sum, scope) => sum + weights[scope], 0);
  const totals = { common: counts.common, team: counts.team, individual: counts.individual };
  const remainingScore = total - counts.common - counts.team - counts.individual;
  let assigned = 0;
  scopes.forEach((scope, index) => {
    const value = index === scopes.length - 1 ? remainingScore - assigned : Math.round(remainingScore * weights[scope] / activeWeight);
    totals[scope] += value;
    assigned += value;
  });
  const split = (value: number, count: number) => Array.from({ length: count }, (_, index) =>
    Math.floor(value / count) + (index < value % count ? 1 : 0));
  return {
    common: split(totals.common, counts.common),
    team: split(totals.team, counts.team),
    individual: split(totals.individual, counts.individual),
  };
}

function validateGenerateInput(input: GenerateExamInput) {
  if (input.clubId ? input.classNumber != null : !Number.isInteger(input.classNumber) || input.classNumber! < 1 || input.classNumber! > 9) throw new ExamServiceError("학급 또는 동아리를 확인해 주세요.");
  if (!input.title.trim() || input.title.trim().length > 100) throw new ExamServiceError("시험 제목은 1~100자로 입력해 주세요.");
  const limits = { commonCount: 5, teamCount: 5, individualCount: 3 } as const;
  for (const [key, max] of Object.entries(limits) as Array<[keyof typeof limits, number]>) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > max) throw new ExamServiceError("문항 수를 확인해 주세요.");
  }
  const count = input.commonCount + input.teamCount + input.individualCount;
  if (count < 1 || count > 10) throw new ExamServiceError("전체 문항 수는 1~10개여야 합니다.");
  if (!Number.isInteger(input.totalScore) || input.totalScore < count || input.totalScore > 200) throw new ExamServiceError("총점은 문항 수 이상 200점 이하여야 합니다.");
}

function addSource(list: ExamSourceItem[], key: string, label: string, value: unknown, replacements: string[], maxLength = 1_200) {
  const text = redact(value, replacements, maxLength);
  if (text) list.push({ key, label, text });
}

async function prepareTargetSources(teacherId: string, target: { classNumber?: number; clubId?: string }) {
  const db = await getDb();
  let classId: string | null = null;
  let clubId: string | null = null;
  if (target.clubId) {
    const actor = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1 AND role = 'teacher' AND status = 'active'", [teacherId]);
    const club = actor.rows[0]?.is_master
      ? await db.query<{ id: string }>("SELECT id FROM clubs WHERE id = $1 AND academic_year = $2", [target.clubId, ACADEMIC_YEAR])
      : await db.query<{ id: string }>(`SELECT c.id FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id
          WHERE c.id = $1 AND c.academic_year = $2 AND a.teacher_id = $3`, [target.clubId, ACADEMIC_YEAR, teacherId]);
    clubId = club.rows[0]?.id ?? null;
    if (!clubId) throw new ExamServiceError("이 동아리의 시험 운영 권한이 없습니다.", 403);
  } else {
    const classResult = await db.query<{ id: string }>("SELECT id FROM classes WHERE academic_year = $1 AND class_number = $2", [ACADEMIC_YEAR, target.classNumber]);
    classId = classResult.rows[0]?.id ?? null;
    if (!classId) throw new ExamServiceError("학급을 찾을 수 없습니다.", 404);
  }
  const targetColumn = clubId ? "club_id" : "class_id";
  const targetId = clubId ?? classId;

  const privacyResult = await db.query<{ name: string; login_id: string }>(
    `SELECT DISTINCT u.name, u.login_id FROM users u JOIN team_members tm ON tm.user_id = u.id JOIN teams t ON t.id = tm.team_id
      WHERE t.${targetColumn} = $1`,
    [targetId],
  );
  const classReplacements = privacyResult.rows.flatMap((student) => [student.name, student.login_id]);

  const teamsResult = await db.query<{
    team_id: string; team_name: string; session_id: string;
  }>(
    `SELECT t.id AS team_id, t.name AS team_name, s.id AS session_id
       FROM teams t
       JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.${targetColumn} = $1 AND t.status = 'active'
      ORDER BY t.team_number`,
    [targetId],
  );
  if (!teamsResult.rows.length) throw new ExamServiceError("이 학급에 시험을 만들 팀이 없습니다.");

  const membersResult = await db.query<{
    team_id: string; user_id: string; name: string; login_id: string;
  }>(
    `SELECT tm.team_id, u.id AS user_id, u.name, u.login_id
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       JOIN teams t ON t.id = tm.team_id
      WHERE t.${targetColumn} = $1 AND t.status = 'active' AND tm.status = 'active' AND u.status = 'active' AND u.account_type = 'standard'
        AND u.academic_year = $2
      ORDER BY tm.team_id, u.login_id`,
    [targetId, ACADEMIC_YEAR],
  );
  const journals = await db.query<{
    id: string; cycle_id: string | null; cycle_ordinal: number | null;
    team_id: string; student_id: string; session_number: number;
    activities: string; observations: string; reflections: string;
  }>(
    `SELECT j.id, j.cycle_id, c.ordinal AS cycle_ordinal, s.team_id, j.student_id, j.session_number, j.activities, j.observations, j.reflections
       FROM experiment_journals j
       JOIN inquiry_sessions s ON s.id = j.session_id
       LEFT JOIN inquiry_cycles c ON c.id = j.cycle_id AND c.session_id = j.session_id
       JOIN teams t ON t.id = s.team_id
       JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = j.student_id AND tm.status = 'active'
      WHERE t.${targetColumn} = $1 AND t.status = 'active'
      ORDER BY s.team_id, j.student_id, c.ordinal, j.session_number, j.id`,
    [targetId],
  );
  const customRows = clubId ? await db.query<{
    id: string; config_version_id: string; team_id: string; student_id: string | null; title: string; definition: Record<string, unknown> | string; response_data: Record<string, unknown> | string;
  }>(`SELECT r.id, r.config_version_id, s.team_id, r.student_id, v.title, v.definition, r.response_data
       FROM club_custom_responses r JOIN club_config_versions v ON v.id = r.config_version_id
       JOIN inquiry_sessions s ON s.id = r.session_id JOIN teams t ON t.id = s.team_id
      WHERE t.club_id = $1 AND t.status = 'active' AND r.status IN ('submitted', 'feedback', 'reviewed')`, [clubId]) : { rows: [] };

  const prepared: PreparedTeam[] = [];
  for (const [teamIndex, team] of teamsResult.rows.entries()) {
    const memberRows = membersResult.rows.filter((member) => member.team_id === team.team_id);
    if (!memberRows.length) continue;
    const replacements = classReplacements;
    const teamSources: ExamSourceItem[] = [];
    const documents = await getExamDocumentSources(team.session_id, teacherId);
    const documentLabel = (document: typeof documents[number]) => `${document.ordinal == null ? "회차 미분류" : `${document.ordinal}회차`} · ${document.kind === "plan" ? "승인 계획서" : "확인 보고서"}${document.legacy ? " · 기존 자료 고정본" : ""}`;
    for (const document of documents) {
      const defaultFields = document.kind === "plan" ? PLAN_FIELDS : REPORT_FIELDS;
      const configuredFields = Array.isArray(document.definition.fields) ? document.definition.fields as Array<{ id: string; label: string }> : [];
      for (const [key, value] of Object.entries(document.form)) {
        const fieldLabel = configuredFields.find(field => field.id === key)?.label ?? defaultFields.find(field => field.key === key)?.label ?? key;
        addSource(teamSources, `${document.kind}.${document.cycleId ?? "legacy"}.${document.id}.${key}`, `${documentLabel(document)} - ${redact(fieldLabel, replacements, 150)}`, value, replacements);
      }
    }
    for (const custom of customRows.rows.filter((row) => row.team_id === team.team_id && !row.student_id)) {
      const definition = parseJson(custom.definition, {} as { useForExam?: boolean });
      if (definition.useForExam) addSource(teamSources, `custom.${custom.config_version_id}.${custom.id}`, `동아리 탭 - ${redact(custom.title, replacements, 100)}`, parseJson(custom.response_data, {}), replacements);
    }

    const preparedStudents: PreparedStudent[] = memberRows.map((member, studentIndex) => {
      const ref = `S${studentIndex + 1}`;
      const personalSources: ExamSourceItem[] = [];
      for (const document of documents.filter(document => document.kind === "report")) {
        for (const role of document.roles.filter(role => role.userId === member.user_id)) {
          addSource(personalSources, `role.${document.cycleId ?? "legacy"}.${document.id}`, `${documentLabel(document)} - 본인 역할`, role.description, replacements, 600);
        }
      }
      for (const journal of journals.rows.filter((item) => item.team_id === team.team_id && item.student_id === member.user_id)) {
        const key = `journal.${journal.cycle_id ?? "legacy"}.${journal.id}`;
        const label = `${journal.cycle_ordinal == null ? "회차 미분류" : `${journal.cycle_ordinal}회차`} · ${journal.session_number}차시`;
        addSource(personalSources, `${key}.activities`, `${label} - 오늘 한 일`, journal.activities, replacements, 700);
        addSource(personalSources, `${key}.observations`, `${label} - 관찰 결과`, journal.observations, replacements, 700);
        addSource(personalSources, `${key}.reflections`, `${label} - 느낀 점과 궁금한 점`, journal.reflections, replacements, 700);
      }
      for (const custom of customRows.rows.filter((row) => row.team_id === team.team_id && row.student_id === member.user_id)) {
        const definition = parseJson(custom.definition, {} as { useForExam?: boolean });
        if (definition.useForExam) addSource(personalSources, `custom.${custom.config_version_id}.${custom.id}`, `개인 동아리 탭 - ${redact(custom.title, replacements, 100)}`, parseJson(custom.response_data, {}), replacements);
      }
      return { id: member.user_id, ref, source: { studentRef: ref, sources: personalSources } };
    });
    prepared.push({
      id: team.team_id,
      sessionId: team.session_id,
      students: preparedStudents,
      source: {
        teamId: team.team_id,
        teamRef: `T${teamIndex + 1}`,
        topic: redact(documents.filter(document => document.kind === "plan").map(document => document.form.topic ?? document.form.title ?? "").filter(Boolean).join(" / ") || "승인 자료의 탐구", replacements, 500),
        sources: teamSources,
        students: preparedStudents.map((student) => student.source),
      },
    });
  }
  if (!prepared.length) throw new ExamServiceError("활성 학생이 있는 팀이 없습니다.");
  return { classId, clubId, teams: prepared };
}

async function mapWithConcurrency<T, U>(items: T[], limit: number, task: (item: T) => Promise<U>) {
  const results = new Array<U>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function normalizeRubric(items: Array<{ criterion: string; points: number }>, maxScore: number) {
  const clean = items.filter((item) => item.criterion.trim()).slice(0, Math.min(6, maxScore));
  const criteria = clean.length ? clean : [{ criterion: "질문의 요구에 맞게 근거를 들어 설명함", points: 1 }];
  const weights = criteria.map((item) => Math.max(1, item.points));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const remaining = maxScore - criteria.length;
  const extras = weights.map((weight) => Math.floor(remaining * weight / totalWeight));
  let leftover = remaining - extras.reduce((sum, value) => sum + value, 0);
  for (let index = 0; leftover > 0; index = (index + 1) % extras.length) {
    extras[index] += 1;
    leftover -= 1;
  }
  return criteria.map((item, index) => ({ criterion: item.criterion.trim(), points: 1 + extras[index]! }));
}

export function evidenceFor(question: GeneratedExamQuestion, sources: ExamSourceItem[], scope: ExamScope) {
  if (scope === "common") {
    return [{ sourceType: "neutral", sourceLabel: "공통 중립 자료", sourceKey: "neutral", excerpt: question.stimulus.trim() }];
  }
  if (scope === "individual" && !sources.length && !question.sourceKeys.length) {
    if (!question.stimulus.trim()) throw new ExamServiceError("개인 자료가 없는 대체 문항의 제시 자료를 확인해 주세요.");
    return [{ sourceType: "neutral_fallback", sourceLabel: "개인 기록 부족 · 표준 대체 자료", sourceKey: "neutral_fallback", excerpt: question.stimulus.trim() }];
  }
  const sourceMap = new Map(sources.map((source) => [source.key, source]));
  if (sourceMap.size !== sources.length || !question.sourceKeys.length || question.sourceKeys.some(key => !sourceMap.has(key))) {
    throw new ExamServiceError("문항의 출처가 제공한 자료와 일치하지 않습니다. 다시 생성해 주세요.");
  }
  const selected = [...new Set(question.sourceKeys)].map(key => sourceMap.get(key)!);
  return selected.map((source) => ({
    sourceType: source.key.split(".")[0] ?? scope,
    sourceLabel: source.label,
    sourceKey: source.key,
    excerpt: source.text,
  }));
}

async function insertQuestion(client: PoolClient, input: {
  examSetId: string; scope: ExamScope; teamId?: string; studentId?: string;
  sequence: number; generated: GeneratedExamQuestion; maxScore: number; sources: ExamSourceItem[];
}) {
  const evidence = evidenceFor(input.generated, input.sources, input.scope);
  const groundedStimulus = input.scope === "common"
    ? input.generated.stimulus.trim()
    : evidence.map((item) => `[${item.sourceLabel}]\n${item.excerpt}`).join("\n\n");
  await client.query(
    `INSERT INTO exam_questions
      (id, exam_set_id, scope, team_id, student_id, sequence, stimulus, question,
       competency, difficulty, max_score, model_answer, scoring_rubric, source_evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      createId("exam_question"), input.examSetId, input.scope, input.teamId ?? null, input.studentId ?? null,
      input.sequence, groundedStimulus, input.generated.question.trim(), input.generated.competency.trim(),
      input.generated.difficulty, input.maxScore, input.generated.modelAnswer.trim(),
      JSON.stringify(normalizeRubric(input.generated.rubric, input.maxScore)), JSON.stringify(evidence),
    ],
  );
}

async function assertExamGenerationAccess(db: Pick<PoolClient, "query">, teacherId: string, clubId: string | null, lock = false) {
  const actor = (await db.query<{ role: string; status: string; must_change_password: boolean; academic_year: number; is_master: boolean }>(
    `SELECT role, status, must_change_password, academic_year, is_master FROM users WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [teacherId],
  )).rows[0];
  if (!actor || actor.role !== "teacher" || actor.status !== "active" || actor.must_change_password || actor.academic_year !== ACADEMIC_YEAR) {
    throw new ExamServiceError("시험을 생성할 교사 권한이 없습니다.", 403);
  }
  if (clubId && !actor.is_master) {
    const assignment = await db.query(`SELECT teacher_id FROM club_teacher_assignments WHERE club_id = $1 AND teacher_id = $2${lock ? " FOR UPDATE" : ""}`, [clubId, teacherId]);
    if (!assignment.rows[0]) throw new ExamServiceError("이 동아리의 시험 운영 권한이 없습니다.", 403);
  }
}

async function lockPreparedExamRoster(client: PoolClient, prepared: { classId: string | null; clubId: string | null; teams: PreparedTeam[] }, teacherId: string) {
  const { teams } = prepared;
  const changed = () => new ExamServiceError("시험 대상 팀이나 학생이 변경되었습니다. 최신 명단을 확인한 뒤 다시 생성해 주세요.", 409);
  const scopeTable = prepared.clubId ? "clubs" : "classes";
  const scopeColumn = prepared.clubId ? "club_id" : "class_id";
  const scopeId = prepared.clubId ?? prepared.classId;
  // Team creation takes this same parent lock (and its FK also conflicts with it).
  const scope = await client.query(`SELECT id FROM ${scopeTable} WHERE id = $1 AND academic_year = $2 FOR UPDATE`, [scopeId, ACADEMIC_YEAR]);
  if (!scope.rows[0]) throw changed();
  const scopeTeams = await client.query<{ id: string; session_id: string | null }>(
    `SELECT t.id, s.id AS session_id FROM teams t LEFT JOIN inquiry_sessions s ON s.team_id = t.id
      WHERE t.${scopeColumn} = $1 ORDER BY t.id`, [scopeId],
  );
  // Match evaluation/document writers: session, students, then related teams.
  // The AI calls have already finished; no network operation holds these locks.
  for (const team of scopeTeams.rows) {
    if (!team.session_id) continue;
    const session = await client.query<{ team_id: string }>("SELECT team_id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [team.session_id]);
    if (session.rows[0]?.team_id !== team.id) throw changed();
  }
  await lockStudentsTeams(client, [teacherId, ...teams.flatMap(team => team.students.map(student => student.id))], scopeTeams.rows.map(team => team.id));
  await assertExamGenerationAccess(client, teacherId, prepared.clubId, true);
  const populated = await client.query<{ id: string }>(
    `SELECT DISTINCT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id JOIN users u ON u.id = tm.user_id
      WHERE t.${scopeColumn} = $1 AND t.status = 'active' AND tm.status = 'active'
        AND u.status = 'active' AND u.account_type = 'standard' AND u.academic_year = $2`, [scopeId, ACADEMIC_YEAR],
  );
  const expectedTeams = new Set(teams.map(team => team.id));
  if (populated.rows.length !== expectedTeams.size || populated.rows.some(team => !expectedTeams.has(team.id))) throw changed();
  for (const team of teams) {
    const active = await client.query("SELECT id FROM teams WHERE id = $1 AND status = 'active'", [team.id]);
    if (!active.rows[0]) throw changed();
    const members = await client.query<{ id: string }>(
      `SELECT u.id FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 AND tm.status = 'active' AND u.status = 'active'
          AND u.account_type = 'standard' AND u.academic_year = $2`, [team.id, ACADEMIC_YEAR],
    );
    const expected = team.students.map(student => student.id).sort();
    const current = members.rows.map(student => student.id).sort();
    if (expected.length !== current.length || expected.some((id, index) => id !== current[index])) throw changed();
  }
}

export async function generateExamSet(
  teacherId: string,
  input: GenerateExamInput,
  generator: ExamGenerator = openAiExamGenerator,
  clientRequestId?: string,
) {
  validateGenerateInput(input);
  await assertExamGenerationAccess(await getDb(), teacherId, input.clubId ?? null);
  const prepared = await prepareTargetSources(teacherId, { classNumber: input.classNumber, clubId: input.clubId });
  if (input.teamCount > 0 && prepared.teams.some(team => !team.source.sources.length)) {
    throw new ExamServiceError("팀 문항을 만들 승인 계획서나 확인 보고서가 없는 팀이 있습니다. 자료를 먼저 검토하거나 팀 문항 수를 0으로 설정해 주세요.");
  }
  let pinnedConfigVersionId: string | null = null;
  if (prepared.clubId) {
    const db = await getDb();
    const published = await db.query<{ id: string }>("SELECT id FROM club_config_versions WHERE club_id = $1 AND config_type = 'exam' AND config_key = 'default' AND status = 'published' ORDER BY version_number DESC LIMIT 1", [prepared.clubId]);
    pinnedConfigVersionId = published.rows[0]?.id ?? null;
    if (!pinnedConfigVersionId) throw new ExamServiceError("동아리 시험 기본안을 발행한 뒤 시험을 만들어 주세요.");
    if (input.configVersionId && input.configVersionId !== pinnedConfigVersionId) throw new ExamServiceError("시험 기본안이 바뀌었습니다. 최신 설정을 다시 불러와 주세요.", 409);
  }
  const scope = input.commonScope.trim() || "통합과학 탐구 설계, 자료 해석, 변인 통제, 오차 분석";
  try {
    const requestKey = aiRequestKey("exam_generation", {
      evidencePolicyVersion: 3,
      clientRequestId: clientRequestId ?? null,
      teacherId,
      input: { ...input, title: input.title.trim(), commonScope: scope },
      pinnedConfigVersionId,
      prepared,
    });
    const job = await beginAiJob<{ examSetId: string }>({
      resourceKey: `exam:${prepared.clubId ?? prepared.classId}`,
      requestKey,
      feature: "exam_generation",
      actorId: teacherId,
      leaseMs: 45 * 60_000,
    });
    if (job.kind === "busy") throw new ExamServiceError("이 대상의 AI 시험 초안을 이미 생성하고 있습니다. 잠시 후 다시 확인해 주세요.", 409);
    if (job.kind === "cached") return job.result.examSetId;

    try {
      const commonQuestions = await runAiJobStep(job, "common", () => generator.generateCommon({
        count: input.commonCount,
        scope,
        teamSummaries: prepared.teams.map((team) => ({
          teamRef: team.source.teamRef,
          topic: team.source.topic,
          sources: team.source.sources.slice(0, 8).map((source) => ({ ...source, text: source.text.slice(0, 500) })),
        })),
        requestId: aiRequestKey("exam_common_step", { jobId: job.jobId }),
      }));
      const validateTeamResult = (result: Awaited<ReturnType<ExamGenerator["generateTeam"]>>, team: PreparedTeam) => {
        if (result.teamQuestions.length !== input.teamCount) throw new ExamServiceError("팀 문항 수가 요청과 다릅니다.");
        for (const question of result.teamQuestions) evidenceFor(question, team.source.sources, "team");
        if ((input.individualCount > 0 || result.individualQuestions.length > 0) &&
            (result.individualQuestions.length !== team.students.length || new Set(result.individualQuestions.map(item => item.studentRef)).size !== team.students.length ||
             result.individualQuestions.some(item => !team.students.some(student => student.ref === item.studentRef)))) {
          throw new ExamServiceError("개인화 문항의 학생 구성이 요청과 다릅니다.");
        }
        for (const student of team.students) {
          const questions = result.individualQuestions.find(item => item.studentRef === student.ref)?.questions ?? [];
          if (questions.length !== input.individualCount) throw new ExamServiceError("개인화 문항 수가 요청과 다릅니다.");
          for (const question of questions) evidenceFor(question, student.source.sources, "individual");
        }
        return result;
      };
      const teamResults = await mapWithConcurrency(prepared.teams, 2, async (team) =>
        runAiJobStep(job, `team:${team.id}`, async () => validateTeamResult(await generator.generateTeam({
          team: team.source,
          teamCount: input.teamCount,
          individualCount: input.individualCount,
          requestId: aiRequestKey("exam_team_step", { jobId: job.jobId, teamId: team.id }),
        }), team)),
      );
      const scores = questionScores(
        { common: input.commonCount, team: input.teamCount, individual: input.individualCount },
        input.totalScore,
      );

      // Validate the complete result before opening the write transaction, including cached steps.
      if (commonQuestions.length !== input.commonCount) throw new ExamServiceError("공통 문항 수가 요청과 다릅니다.");
      for (const [index, team] of prepared.teams.entries()) {
        validateTeamResult(teamResults[index]!, team);
      }

      const db = await getDb();
      const client = await db.connect();
      const examSetId = `exam_set_${job.jobId}`;
      try {
        await client.query("BEGIN");
        await lockPreparedExamRoster(client, prepared, teacherId);
        if (!(await ownsAiJob(client, job.jobId, job.leaseToken))) throw new ExamServiceError("AI 시험 생성 작업이 만료되었습니다. 다시 시도해 주세요.", 409);
        await client.query(
          `INSERT INTO exam_sets
            (id, class_id, club_id, config_version_id, title, common_count, team_count, individual_count, total_score, common_scope, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [examSetId, prepared.classId, prepared.clubId, pinnedConfigVersionId, input.title.trim(), input.commonCount, input.teamCount, input.individualCount, input.totalScore, scope, teacherId],
        );
        for (const [index, question] of commonQuestions.entries()) {
          await insertQuestion(client, { examSetId, scope: "common", sequence: index + 1, generated: question, maxScore: scores.common[index]!, sources: [] });
        }
        for (const [teamIndex, team] of prepared.teams.entries()) {
          const result = teamResults[teamIndex]!;
          for (const [index, question] of result.teamQuestions.entries()) {
            await insertQuestion(client, {
              examSetId, scope: "team", teamId: team.id, sequence: index + 1,
              generated: question, maxScore: scores.team[index]!, sources: team.source.sources,
            });
          }
          for (const student of team.students) {
            const generated = result.individualQuestions.find((item) => item.studentRef === student.ref)?.questions ?? [];
            if (generated.length !== input.individualCount) throw new ExamServiceError("개인화 문항 수가 올바르지 않습니다.");
            for (const [index, question] of generated.entries()) {
              await insertQuestion(client, {
                examSetId, scope: "individual", teamId: team.id, studentId: student.id, sequence: index + 1,
                generated: question, maxScore: scores.individual[index]!, sources: student.source.sources,
              });
            }
            await client.query(
              "INSERT INTO exams (id, exam_set_id, session_id, student_id) VALUES ($1, $2, $3, $4)",
              [createId("exam"), examSetId, team.sessionId, student.id],
            );
          }
        }
        if (!(await completeAiJob(client, job.jobId, job.leaseToken, { examSetId }))) throw new ExamServiceError("AI 시험 생성 결과를 저장하지 못했습니다.", 409);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await audit(teacherId, "exam_set_generated", "exam_set", examSetId, {
        classNumber: input.classNumber,
        counts: { common: input.commonCount, team: input.teamCount, individual: input.individualCount },
        paperCount: prepared.teams.reduce((sum, team) => sum + team.students.length, 0),
      });
      return examSetId;
    } catch (error) {
      await failAiJob(job.jobId, job.leaseToken);
      throw error;
    }
  } catch (error) {
    throw error;
  }
}

function toQuestion(row: {
  id: string; exam_set_id: string; scope: ExamScope; team_id: string | null; student_id: string | null;
  sequence: number; stimulus: string; question: string; question_type: ExamQuestion["questionType"];
  competency: string; difficulty: ExamDifficulty; max_score: number; model_answer: string;
  scoring_rubric: ExamQuestion["scoringRubric"] | string; source_evidence: ExamQuestion["sourceEvidence"] | string;
  is_ai_generated: boolean;
}): ExamQuestion {
  return {
    id: row.id, examSetId: row.exam_set_id, scope: row.scope, teamId: row.team_id, studentId: row.student_id,
    sequence: row.sequence, stimulus: row.stimulus, question: row.question, questionType: row.question_type,
    competency: row.competency, difficulty: row.difficulty, maxScore: row.max_score, modelAnswer: row.model_answer,
    scoringRubric: parseJson(row.scoring_rubric, []), sourceEvidence: parseJson(row.source_evidence, []), isAiGenerated: row.is_ai_generated,
  };
}

export function questionsForPaper(data: Pick<ExamSetData, "questions">, paper: Pick<ExamPaper, "teamId" | "studentId">) {
  const order: Record<ExamScope, number> = { common: 0, team: 1, individual: 2 };
  return data.questions
    .filter((question) => question.scope === "common"
      || (question.scope === "team" && question.teamId === paper.teamId)
      || (question.scope === "individual" && question.studentId === paper.studentId))
    .sort((left, right) => order[left.scope] - order[right.scope] || left.sequence - right.sequence);
}

export async function getExamManagementData(classNumber = 9, selectedSetId?: string, teacherId?: string, clubId?: string): Promise<ExamManagementData> {
  const db = await getDb();
  let targetClub: { id: string; name: string } | null = null;
  if (clubId) {
    let result;
    if (teacherId) {
      const actor = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1", [teacherId]);
      result = actor.rows[0]?.is_master
        ? await db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR])
        : await db.query<{ id: string; name: string }>(`SELECT c.id, c.name FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id
            WHERE c.id = $1 AND c.academic_year = $2 AND a.teacher_id = $3`, [clubId, ACADEMIC_YEAR, teacherId]);
    } else result = await db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR]);
    targetClub = result.rows[0] ?? null;
    if (!targetClub) throw new ExamServiceError("이 동아리의 시험 운영 권한이 없습니다.", 403);
  }
  let availableClubs: Array<{ id: string; name: string }> = [];
  if (teacherId) {
    const actor = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1", [teacherId]);
    availableClubs = actor.rows[0]?.is_master
      ? (await db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE academic_year = $1 ORDER BY name", [ACADEMIC_YEAR])).rows
      : (await db.query<{ id: string; name: string }>(`SELECT c.id, c.name FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id
          WHERE c.academic_year = $1 AND a.teacher_id = $2 ORDER BY c.name`, [ACADEMIC_YEAR, teacherId])).rows;
  }
  const defaultConfigResult = targetClub ? await db.query<{ id: string; definition: Record<string, unknown> | string }>(
    "SELECT id, definition FROM club_config_versions WHERE club_id = $1 AND config_type = 'exam' AND config_key = 'default' AND status = 'published' ORDER BY version_number DESC LIMIT 1", [targetClub.id],
  ) : null;
  const rawDefault = defaultConfigResult?.rows[0];
  const config = rawDefault ? parseJson(rawDefault.definition, {} as Record<string, unknown>) : null;
  const defaultConfig = rawDefault && config ? {
    title: String(config.title ?? "동아리 탐구 수행평가"), commonCount: Number(config.commonCount ?? 4), teamCount: Number(config.teamCount ?? 2),
    individualCount: Number(config.individualCount ?? 1), totalScore: Number(config.totalScore ?? 100), commonScope: String(config.commonScope ?? ""), configVersionId: rawDefault.id,
  } : null;
  const setsResult = await db.query<{
    id: string; title: string; class_number: number | null; status: "draft" | "confirmed"; generated_at: Date | string;
    revision_number: number; parent_exam_set_id: string | null;
  }>(
    targetClub
      ? `SELECT es.id, es.title, c.class_number, es.status, es.generated_at, es.revision_number, es.parent_exam_set_id
           FROM exam_sets es LEFT JOIN classes c ON c.id = es.class_id WHERE es.club_id = $1 ORDER BY es.created_at DESC`
      : `SELECT es.id, es.title, c.class_number, es.status, es.generated_at, es.revision_number, es.parent_exam_set_id
           FROM exam_sets es JOIN classes c ON c.id = es.class_id WHERE c.academic_year = $1 AND c.class_number = $2 ORDER BY es.created_at DESC`,
    targetClub ? [targetClub.id] : [ACADEMIC_YEAR, classNumber],
  );
  const setId = selectedSetId && setsResult.rows.some((row) => row.id === selectedSetId)
    ? selectedSetId
    : setsResult.rows[0]?.id;
  const sets = setsResult.rows.map((row) => ({
    id: row.id, title: row.title, classNumber: row.class_number, status: row.status, generatedAt: iso(row.generated_at)!,
    revisionNumber: row.revision_number, parentExamSetId: row.parent_exam_set_id,
  }));
  const base = { classNumber: targetClub ? null : classNumber, clubId: targetClub?.id ?? null, activityLabel: targetClub?.name ?? `${classNumber}반`, availableClubs, defaultConfig };
  if (!setId) return { ...base, sets, selected: null };

  const setResult = await db.query<{
    id: string; title: string; class_number: number | null; club_id: string | null; activity_label: string; status: "draft" | "confirmed";
    common_count: number; team_count: number; individual_count: number; total_score: number;
    common_scope: string; generated_at: Date | string; confirmed_at: Date | string | null;
    revision_number: number; parent_exam_set_id: string | null; correction_reason: string | null;
  }>(
    `SELECT es.id, es.title, c.class_number, es.club_id, COALESCE(c.name, cl.name) AS activity_label, es.status, es.common_count, es.team_count,
            es.individual_count, es.total_score, es.common_scope, es.generated_at, es.confirmed_at,
            es.revision_number, es.parent_exam_set_id, es.correction_reason
       FROM exam_sets es LEFT JOIN classes c ON c.id = es.class_id LEFT JOIN clubs cl ON cl.id = es.club_id WHERE es.id = $1`,
    [setId],
  );
  const set = setResult.rows[0]!;
  const questionResult = await db.query<Parameters<typeof toQuestion>[0]>(
    `SELECT id, exam_set_id, scope, team_id, student_id, sequence, stimulus, question, question_type,
            competency, difficulty, max_score, model_answer, scoring_rubric, source_evidence, is_ai_generated
       FROM exam_questions WHERE exam_set_id = $1 ORDER BY scope, team_id, student_id, sequence`,
    [setId],
  );
  const paperResult = await db.query<{
    exam_id: string; student_id: string; student_name: string; login_id: string; team_id: string; team_name: string;
    class_number: number | null; status: string; question_scores: Record<string, number> | string | null;
    total_score: number | null; teacher_feedback: string | null; graded_at: Date | string | null; published_at: Date | string | null;
  }>(
    `SELECT e.id AS exam_id, e.student_id, u.name AS student_name, u.login_id,
            t.id AS team_id, t.name AS team_name, c.class_number, e.status,
            er.question_scores, er.total_score, er.teacher_feedback, er.graded_at, er.published_at
       FROM exams e
       JOIN users u ON u.id = e.student_id
       JOIN inquiry_sessions s ON s.id = e.session_id
       JOIN teams t ON t.id = s.team_id
       LEFT JOIN classes c ON c.id = t.class_id
       LEFT JOIN exam_results er ON er.exam_id = e.id
      WHERE e.exam_set_id = $1
      ORDER BY t.team_number, u.login_id`,
    [setId],
  );
  return {
    ...base,
    sets,
    selected: {
      id: set.id, title: set.title, classNumber: set.class_number, clubId: set.club_id, activityLabel: set.activity_label, status: set.status,
      commonCount: set.common_count, teamCount: set.team_count, individualCount: set.individual_count,
      totalScore: set.total_score, commonScope: set.common_scope, generatedAt: iso(set.generated_at)!,
      confirmedAt: iso(set.confirmed_at), questions: questionResult.rows.map(toQuestion),
      revisionNumber: set.revision_number, parentExamSetId: set.parent_exam_set_id, correctionReason: set.correction_reason,
      papers: paperResult.rows.map((paper) => ({
        examId: paper.exam_id, studentId: paper.student_id, studentName: paper.student_name, loginId: paper.login_id,
        teamId: paper.team_id, teamName: paper.team_name, classNumber: paper.class_number, status: paper.status,
        result: paper.question_scores == null ? null : {
          questionScores: parseJson(paper.question_scores, {}), totalScore: paper.total_score ?? 0,
          teacherFeedback: paper.teacher_feedback ?? "", gradedAt: iso(paper.graded_at), publishedAt: iso(paper.published_at),
        },
      })),
    },
  };
}

async function assertExamSetTeacherAccess(teacherId: string, examSetId: string) {
  const db = await getDb();
  const result = await db.query<{ club_id: string | null }>(
    `SELECT es.club_id FROM exam_sets es LEFT JOIN classes c ON c.id = es.class_id
      LEFT JOIN clubs cl ON cl.id = es.club_id
      WHERE es.id = $1 AND COALESCE(c.academic_year, cl.academic_year) = $2`,
    [examSetId, ACADEMIC_YEAR],
  );
  if (!result.rows[0]) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
  if (result.rows[0].club_id) await getExamManagementData(9, examSetId, teacherId, result.rows[0].club_id);
}

async function assertDraftSetForQuestion(questionId: string, teacherId?: string) {
  const db = await getDb();
  const result = await db.query<{ exam_set_id: string; status: string; scope: ExamScope; sequence: number; max_score: number }>(
    `SELECT q.exam_set_id, es.status, q.scope, q.sequence, q.max_score
       FROM exam_questions q JOIN exam_sets es ON es.id = q.exam_set_id WHERE q.id = $1`,
    [questionId],
  );
  const row = result.rows[0];
  if (!row) throw new ExamServiceError("문항을 찾을 수 없습니다.", 404);
  if (teacherId) await assertExamSetTeacherAccess(teacherId, row.exam_set_id);
  if (row.status !== "draft") throw new ExamServiceError("확정된 시험은 수정할 수 없습니다.");
  return row;
}

export async function updateExamQuestion(teacherId: string, input: {
  questionId: string; stimulus: string; question: string; competency: string; difficulty: ExamDifficulty;
  modelAnswer: string; scoringRubric: Array<{ criterion: string; points: number }>;
}) {
  await assertDraftSetForQuestion(input.questionId, teacherId);
  if (!input.question.trim() || !input.modelAnswer.trim() || !input.competency.trim()) throw new ExamServiceError("문제·모범답안·평가 역량을 입력해 주세요.");
  const db = await getDb();
  const scoreResult = await db.query<{ max_score: number }>("SELECT max_score FROM exam_questions WHERE id = $1", [input.questionId]);
  const maxScore = scoreResult.rows[0]!.max_score;
  await db.query(
    `UPDATE exam_questions SET stimulus = $1, question = $2, competency = $3, difficulty = $4,
            model_answer = $5, scoring_rubric = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7`,
    [input.stimulus.trim(), input.question.trim(), input.competency.trim(), input.difficulty,
      input.modelAnswer.trim(), JSON.stringify(normalizeRubric(input.scoringRubric, maxScore)), input.questionId],
  );
  await audit(teacherId, "exam_question_updated", "exam_question", input.questionId);
}

export async function deleteExamQuestionSlot(teacherId: string, questionId: string) {
  const current = await assertDraftSetForQuestion(questionId, teacherId);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM exam_questions WHERE exam_set_id = $1 AND scope = $2 AND sequence = $3",
      [current.exam_set_id, current.scope, current.sequence],
    );
    await client.query(
      "UPDATE exam_questions SET sequence = sequence - 1 WHERE exam_set_id = $1 AND scope = $2 AND sequence > $3",
      [current.exam_set_id, current.scope, current.sequence],
    );
    const countColumn = current.scope === "common" ? "common_count" : current.scope === "team" ? "team_count" : "individual_count";
    await client.query(`UPDATE exam_sets SET ${countColumn} = ${countColumn} - 1, total_score = total_score - $2::integer, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [current.exam_set_id, current.max_score]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, "exam_question_slot_deleted", "exam_set", current.exam_set_id, { scope: current.scope, sequence: current.sequence });
}

export async function addCommonExamQuestion(teacherId: string, input: {
  examSetId: string; stimulus: string; question: string; competency: string; difficulty: ExamDifficulty;
  maxScore: number; modelAnswer: string; scoringRubric: Array<{ criterion: string; points: number }>;
}) {
  const db = await getDb();
  await assertExamSetTeacherAccess(teacherId, input.examSetId);
  const setResult = await db.query<{ status: string; common_count: number; total_score: number }>("SELECT status, common_count, total_score FROM exam_sets WHERE id = $1", [input.examSetId]);
  const set = setResult.rows[0];
  if (!set) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
  if (set.status !== "draft") throw new ExamServiceError("확정된 시험은 수정할 수 없습니다.");
  if (set.common_count >= 5) throw new ExamServiceError("공통 문항은 최대 5개입니다.");
  if (set.total_score + input.maxScore > 200) throw new ExamServiceError("추가 후 총점은 200점을 넘을 수 없습니다.");
  if (!input.question.trim() || !input.modelAnswer.trim() || !input.competency.trim()) throw new ExamServiceError("문제·모범답안·평가 역량을 입력해 주세요.");
  if (!Number.isInteger(input.maxScore) || input.maxScore < 1 || input.maxScore > 100) throw new ExamServiceError("배점을 확인해 주세요.");
  const questionId = createId("exam_question");
  const evidence = [{ sourceType: "teacher", sourceLabel: "교사 직접 추가", sourceKey: "teacher", excerpt: input.stimulus.trim().slice(0, 1_200) }];
  await db.query(
    `INSERT INTO exam_questions
      (id, exam_set_id, scope, sequence, stimulus, question, competency, difficulty, max_score,
       model_answer, scoring_rubric, source_evidence, is_ai_generated)
     VALUES ($1, $2, 'common', $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE)`,
    [questionId, input.examSetId, set.common_count + 1, input.stimulus.trim(), input.question.trim(), input.competency.trim(),
      input.difficulty, input.maxScore, input.modelAnswer.trim(), JSON.stringify(normalizeRubric(input.scoringRubric, input.maxScore)), JSON.stringify(evidence)],
  );
  await db.query(
    "UPDATE exam_sets SET common_count = common_count + 1, total_score = total_score + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
    [input.maxScore, input.examSetId],
  );
  await audit(teacherId, "exam_question_added", "exam_question", questionId, { scope: "common" });
}

export async function confirmExamSet(teacherId: string, examSetId: string) {
  const data = (await getExamManagementDataForSet(examSetId, teacherId));
  if (data.status !== "draft") throw new ExamServiceError("이미 확정된 시험입니다.");
  if (!data.papers.length) throw new ExamServiceError("시험 대상 학생이 없습니다.");
  const signatures = data.papers.map((paper) => {
    const questions = questionsForPaper(data, paper);
    return `${questions.map((question) => question.scope).join(",")}|${questions.reduce((sum, question) => sum + question.maxScore, 0)}`;
  });
  if (new Set(signatures).size !== 1) throw new ExamServiceError("학생별 문항 구성 또는 총점이 달라 확정할 수 없습니다. 삭제한 문항 슬롯을 확인해 주세요.");
  if (data.questions.some((question) => !question.question.trim() || !question.modelAnswer.trim() || !question.scoringRubric.length)) {
    throw new ExamServiceError("문제·모범답안·채점 기준이 비어 있는 문항이 있습니다.");
  }
  const db = await getDb();
  await db.query("UPDATE exam_sets SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [examSetId]);
  await db.query("UPDATE exams SET status = 'reviewed', reviewed_by = $1 WHERE exam_set_id = $2", [teacherId, examSetId]);
  await db.query(
    `UPDATE inquiry_sessions SET stage = 'EXAMINING', last_activity_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT session_id FROM exams WHERE exam_set_id = $1)`,
    [examSetId],
  );
  await audit(teacherId, "exam_set_confirmed", "exam_set", examSetId);
}

export async function createCorrectionExamSet(teacherId: string, examSetId: string, reason: string) {
  const correctionReason = reason.trim();
  if (!correctionReason || correctionReason.length > 500) throw new ExamServiceError("교정 사유를 1~500자로 입력해 주세요.");
  await assertExamSetTeacherAccess(teacherId, examSetId);
  const db = await getDb();
  const client = await db.connect();
  const nextId = createId("exam_set");
  let revisionNumber = 0;
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query<{
      class_id: string | null; club_id: string | null; config_version_id: string | null; title: string; status: string;
      common_count: number; team_count: number; individual_count: number; total_score: number; common_scope: string; revision_number: number;
    }>(`SELECT class_id, club_id, config_version_id, title, status, common_count, team_count, individual_count,
               total_score, common_scope, revision_number FROM exam_sets WHERE id = $1 FOR UPDATE`, [examSetId]);
    const source = sourceResult.rows[0];
    if (!source) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
    if (source.status !== "confirmed") throw new ExamServiceError("확정된 시험만 교정본을 만들 수 있습니다.");
    revisionNumber = source.revision_number + 1;
    await client.query(`INSERT INTO exam_sets
      (id, class_id, club_id, config_version_id, parent_exam_set_id, revision_number, correction_reason,
       title, common_count, team_count, individual_count, total_score, common_scope, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [nextId, source.class_id, source.club_id, source.config_version_id, examSetId, revisionNumber, correctionReason,
      `${source.title} 교정본 v${revisionNumber}`, source.common_count, source.team_count, source.individual_count,
      source.total_score, source.common_scope, teacherId]);
    const questions = await client.query<{
      scope: ExamScope; team_id: string | null; student_id: string | null; sequence: number; stimulus: string; question: string;
      question_type: ExamQuestion["questionType"]; competency: string; difficulty: ExamDifficulty; max_score: number;
      model_answer: string; scoring_rubric: unknown; source_evidence: unknown; is_ai_generated: boolean;
    }>(`SELECT scope, team_id, student_id, sequence, stimulus, question, question_type, competency, difficulty,
               max_score, model_answer, scoring_rubric, source_evidence, is_ai_generated
          FROM exam_questions WHERE exam_set_id = $1`, [examSetId]);
    for (const question of questions.rows) {
      await client.query(`INSERT INTO exam_questions
        (id, exam_set_id, scope, team_id, student_id, sequence, stimulus, question, question_type, competency,
         difficulty, max_score, model_answer, scoring_rubric, source_evidence, is_ai_generated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [createId("exam_question"), nextId, question.scope, question.team_id, question.student_id, question.sequence,
        question.stimulus, question.question, question.question_type, question.competency, question.difficulty,
        question.max_score, question.model_answer, JSON.stringify(question.scoring_rubric), JSON.stringify(question.source_evidence), question.is_ai_generated]);
    }
    const papers = await client.query<{ session_id: string; student_id: string }>(`SELECT e.session_id, e.student_id FROM exams e
      JOIN users u ON u.id = e.student_id WHERE e.exam_set_id = $1 AND u.account_type = 'standard'`, [examSetId]);
    for (const paper of papers.rows) await client.query("INSERT INTO exams (id, exam_set_id, session_id, student_id) VALUES ($1, $2, $3, $4)", [createId("exam"), nextId, paper.session_id, paper.student_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
  await audit(teacherId, "exam_correction_created", "exam_set", nextId, { parentExamSetId: examSetId, revisionNumber, reason: correctionReason });
  return nextId;
}

async function getExamManagementDataForSet(examSetId: string, teacherId?: string) {
  const db = await getDb();
  const classResult = await db.query<{ class_number: number | null; club_id: string | null }>(
    "SELECT c.class_number, es.club_id FROM exam_sets es LEFT JOIN classes c ON c.id = es.class_id WHERE es.id = $1",
    [examSetId],
  );
  const target = classResult.rows[0];
  if (!target || (!target.class_number && !target.club_id)) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
  const data = await getExamManagementData(target.class_number ?? 9, examSetId, teacherId, target.club_id ?? undefined);
  if (!data.selected || data.selected.id !== examSetId) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
  return data.selected;
}

export async function saveExamResult(teacherId: string, input: {
  examId: string; questionScores: Record<string, number>; teacherFeedback: string;
}) {
  const db = await getDb();
  const examResult = await db.query<{ exam_set_id: string; student_id: string; team_id: string; status: string }>(
    `SELECT e.exam_set_id, e.student_id, s.team_id, e.status
       FROM exams e JOIN inquiry_sessions s ON s.id = e.session_id WHERE e.id = $1`,
    [input.examId],
  );
  const exam = examResult.rows[0];
  if (!exam) throw new ExamServiceError("학생 시험지를 찾을 수 없습니다.", 404);
  if (exam.status === "generated") throw new ExamServiceError("시험을 먼저 확정해 주세요.");
  const data = await getExamManagementDataForSet(exam.exam_set_id, teacherId);
  const paper = data.papers.find((item) => item.examId === input.examId)!;
  const questions = questionsForPaper(data, paper);
  const normalized: Record<string, number> = {};
  for (const question of questions) {
    const score = Number(input.questionScores[question.id]);
    if (!Number.isFinite(score) || score < 0 || score > question.maxScore) throw new ExamServiceError(`${question.sequence}번 문항 점수를 확인해 주세요.`);
    normalized[question.id] = score;
  }
  const totalScore = Object.values(normalized).reduce((sum, score) => sum + score, 0);
  await db.query(
    `INSERT INTO exam_results (id, exam_id, question_scores, total_score, teacher_feedback, graded_by, graded_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (exam_id) DO UPDATE SET question_scores = EXCLUDED.question_scores,
       total_score = EXCLUDED.total_score, teacher_feedback = EXCLUDED.teacher_feedback,
       graded_by = EXCLUDED.graded_by, graded_at = CURRENT_TIMESTAMP, published_at = NULL`,
    [createId("exam_result"), input.examId, JSON.stringify(normalized), totalScore, input.teacherFeedback.trim(), teacherId],
  );
  await db.query("UPDATE exams SET status = 'graded' WHERE id = $1", [input.examId]);
  await audit(teacherId, "exam_result_graded", "exam", input.examId, { totalScore });
}

export async function publishExamResult(teacherId: string, examId: string) {
  const db = await getDb();
  const result = await db.query<{ session_id: string; status: string }>("SELECT session_id, status FROM exams WHERE id = $1", [examId]);
  const exam = result.rows[0];
  if (!exam) throw new ExamServiceError("학생 시험지를 찾을 수 없습니다.", 404);
  const set = await db.query<{ exam_set_id: string }>("SELECT exam_set_id FROM exams WHERE id = $1", [examId]);
  await assertExamSetTeacherAccess(teacherId, set.rows[0]!.exam_set_id);
  if (exam.status !== "graded" && exam.status !== "published") throw new ExamServiceError("채점을 저장한 뒤 결과를 공개해 주세요.");
  const updated = await db.query("UPDATE exam_results SET published_at = CURRENT_TIMESTAMP WHERE exam_id = $1 RETURNING id", [examId]);
  if (!updated.rows[0]) throw new ExamServiceError("저장된 채점 결과가 없습니다.");
  await db.query("UPDATE exams SET status = 'published' WHERE id = $1", [examId]);
  await db.query("UPDATE inquiry_sessions SET stage = 'EVALUATING', last_activity_at = CURRENT_TIMESTAMP WHERE id = $1", [exam.session_id]);
  await audit(teacherId, "exam_result_published", "exam", examId);
}

export async function getPublishedStudentExamResult(studentId: string, teamId?: string) {
  const db = await getDb();
  const result = await db.query<{
    exam_id: string; exam_set_id: string; title: string; team_id: string; total_score: number;
    teacher_feedback: string; question_scores: Record<string, number> | string; published_at: Date | string;
  }>(
    `SELECT e.id AS exam_id, e.exam_set_id, es.title, s.team_id, er.total_score,
            er.teacher_feedback, er.question_scores, er.published_at
       FROM exams e
       JOIN exam_sets es ON es.id = e.exam_set_id
       JOIN inquiry_sessions s ON s.id = e.session_id
       JOIN teams t ON t.id = s.team_id
       JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = e.student_id AND tm.status = 'active'
       JOIN exam_results er ON er.exam_id = e.id
       JOIN users u ON u.id = e.student_id
       LEFT JOIN classes tc ON tc.id = t.class_id LEFT JOIN clubs tl ON tl.id = t.club_id
       LEFT JOIN classes ec ON ec.id = es.class_id LEFT JOIN clubs el ON el.id = es.club_id
      WHERE e.student_id = $1 AND ($2::text IS NULL OR t.id = $2) AND e.status = 'published' AND er.published_at IS NOT NULL AND t.status = 'active'
        AND u.academic_year = $3 AND COALESCE(tc.academic_year, tl.academic_year) = $3
        AND COALESCE(ec.academic_year, el.academic_year) = $3
      ORDER BY er.published_at DESC LIMIT 1`,
    [studentId, teamId ?? null, ACADEMIC_YEAR],
  );
  const row = result.rows[0];
  if (!row) return null;
  const set = await getExamManagementDataForSet(row.exam_set_id);
  const paper = set.papers.find((item) => item.examId === row.exam_id)!;
  const scores = parseJson(row.question_scores, {} as Record<string, number>);
  const questions = questionsForPaper(set, paper);
  return {
    title: row.title,
    totalScore: row.total_score,
    maxScore: questions.reduce((sum, question) => sum + question.maxScore, 0),
    teacherFeedback: row.teacher_feedback,
    publishedAt: iso(row.published_at)!,
    questions: questions.map((question, index) => ({
      sequence: index + 1,
      scope: question.scope,
      question: question.question,
      score: scores[question.id] ?? 0,
      maxScore: question.maxScore,
    })),
  };
}

export async function getExamSetForPdf(examSetId: string, studentId?: string, teacherId?: string) {
  const data = await getExamManagementDataForSet(examSetId, teacherId);
  if (data.status !== "confirmed") throw new ExamServiceError("교사가 확정한 시험만 출력할 수 있습니다.");
  const papers = studentId ? data.papers.filter((paper) => paper.studentId === studentId) : data.papers;
  if (!papers.length) throw new ExamServiceError("출력할 시험지가 없습니다.", 404);
  return { ...data, papers };
}
