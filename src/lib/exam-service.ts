import type { PoolClient } from "pg";
import { ACADEMIC_YEAR, PLAN_FIELDS, REPORT_FIELDS } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { openAiExamGenerator, type ExamGenerator, type ExamSourceItem, type GeneratedExamQuestion, type TeamExamSource } from "@/lib/exam-ai";
import { createId } from "@/lib/id";

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
  classNumber: number;
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
  classNumber: number;
  status: "draft" | "confirmed";
  commonCount: number;
  teamCount: number;
  individualCount: number;
  totalScore: number;
  commonScope: string;
  generatedAt: string;
  confirmedAt: string | null;
  questions: ExamQuestion[];
  papers: ExamPaper[];
};

export type ExamManagementData = {
  sets: Array<{
    id: string;
    title: string;
    classNumber: number;
    status: "draft" | "confirmed";
    generatedAt: string;
  }>;
  selected: ExamSetData | null;
};

export type GenerateExamInput = {
  classNumber: number;
  title: string;
  commonCount: number;
  teamCount: number;
  individualCount: number;
  totalScore: number;
  commonScope: string;
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
  if (!Number.isInteger(input.classNumber) || input.classNumber < 1 || input.classNumber > 9) throw new ExamServiceError("학급을 확인해 주세요.");
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

async function prepareClassSources(classNumber: number) {
  const db = await getDb();
  const classResult = await db.query<{ id: string }>(
    "SELECT id FROM classes WHERE academic_year = $1 AND class_number = $2",
    [ACADEMIC_YEAR, classNumber],
  );
  const classId = classResult.rows[0]?.id;
  if (!classId) throw new ExamServiceError("학급을 찾을 수 없습니다.", 404);

  const privacyResult = await db.query<{ name: string; login_id: string }>(
    "SELECT name, login_id FROM users WHERE class_id = $1",
    [classId],
  );
  const classReplacements = privacyResult.rows.flatMap((student) => [student.name, student.login_id]);

  const teamsResult = await db.query<{
    team_id: string; team_name: string; session_id: string; selected_topic: string | null;
    plan_form: Record<string, unknown> | string | null; report_id: string | null;
    report_form: Record<string, unknown> | string | null; report_status: string | null;
  }>(
    `SELECT t.id AS team_id, t.name AS team_name, s.id AS session_id, s.selected_topic,
            p.form_data AS plan_form, r.id AS report_id, r.form_data AS report_form, r.status AS report_status
       FROM teams t
       JOIN inquiry_sessions s ON s.team_id = t.id
       LEFT JOIN investigation_plans p ON p.session_id = s.id
       LEFT JOIN reports r ON r.session_id = s.id
      WHERE t.class_id = $1
      ORDER BY t.team_number`,
    [classId],
  );
  if (!teamsResult.rows.length) throw new ExamServiceError("이 학급에 시험을 만들 팀이 없습니다.");

  const membersResult = await db.query<{
    team_id: string; user_id: string; name: string; login_id: string; role_description: string | null;
  }>(
    `SELECT tm.team_id, u.id AS user_id, u.name, u.login_id, rmr.role_description
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       JOIN teams t ON t.id = tm.team_id
       LEFT JOIN inquiry_sessions s ON s.team_id = t.id
       LEFT JOIN reports r ON r.session_id = s.id
       LEFT JOIN report_member_roles rmr ON rmr.report_id = r.id AND rmr.user_id = u.id
      WHERE t.class_id = $1 AND tm.status = 'active' AND u.status = 'active'
      ORDER BY tm.team_id, u.login_id`,
    [classId],
  );
  const reportFields = await db.query<{ team_id: string; field_key: string; value: string }>(
    `SELECT s.team_id, rf.field_key, rf.value
       FROM report_fields rf
       JOIN reports r ON r.id = rf.report_id
       JOIN inquiry_sessions s ON s.id = r.session_id
       JOIN teams t ON t.id = s.team_id
      WHERE t.class_id = $1`,
    [classId],
  );
  const journals = await db.query<{
    team_id: string; student_id: string; session_number: number;
    activities: string; observations: string; reflections: string;
  }>(
    `SELECT s.team_id, j.student_id, j.session_number, j.activities, j.observations, j.reflections
       FROM experiment_journals j
       JOIN inquiry_sessions s ON s.id = j.session_id
       JOIN teams t ON t.id = s.team_id
       JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = j.student_id AND tm.status = 'active'
      WHERE t.class_id = $1
      ORDER BY s.team_id, j.student_id, j.session_number`,
    [classId],
  );

  const prepared: PreparedTeam[] = [];
  teamsResult.rows.forEach((team, teamIndex) => {
    const memberRows = membersResult.rows.filter((member) => member.team_id === team.team_id);
    if (!memberRows.length) return;
    const replacements = classReplacements;
    const teamSources: ExamSourceItem[] = [];
    addSource(teamSources, "topic", "탐구 주제", team.selected_topic, replacements, 500);
    const planForm = parseJson<Record<string, unknown>>(team.plan_form, {});
    for (const field of PLAN_FIELDS) addSource(teamSources, `plan.${field.key}`, `계획서 - ${field.label}`, planForm[field.key], replacements);
    const reportForm = parseJson<Record<string, unknown>>(team.report_form, {});
    for (const field of reportFields.rows.filter((item) => item.team_id === team.team_id)) reportForm[field.field_key] = field.value;
    for (const field of REPORT_FIELDS) addSource(teamSources, `report.${field.key}`, `보고서 - ${field.label}`, reportForm[field.key], replacements);

    const preparedStudents: PreparedStudent[] = memberRows.map((member, studentIndex) => {
      const ref = `S${studentIndex + 1}`;
      const personalSources: ExamSourceItem[] = [];
      addSource(personalSources, "role", "보고서 역할", member.role_description, replacements, 600);
      for (const journal of journals.rows.filter((item) => item.team_id === team.team_id && item.student_id === member.user_id)) {
        addSource(personalSources, `journal.${journal.session_number}.activities`, `${journal.session_number}차시 - 오늘 한 일`, journal.activities, replacements, 700);
        addSource(personalSources, `journal.${journal.session_number}.observations`, `${journal.session_number}차시 - 관찰 결과`, journal.observations, replacements, 700);
        addSource(personalSources, `journal.${journal.session_number}.reflections`, `${journal.session_number}차시 - 느낀 점과 궁금한 점`, journal.reflections, replacements, 700);
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
        topic: redact(team.selected_topic || "주제 미입력", replacements, 500),
        sources: teamSources,
        students: preparedStudents.map((student) => student.source),
      },
    });
  });
  if (!prepared.length) throw new ExamServiceError("활성 학생이 있는 팀이 없습니다.");
  return { classId, teams: prepared };
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

function evidenceFor(question: GeneratedExamQuestion, sources: ExamSourceItem[], scope: ExamScope) {
  if (scope === "common") {
    return [{ sourceType: "neutral", sourceLabel: "공통 중립 자료", sourceKey: "neutral", excerpt: question.stimulus.trim().slice(0, 1_200) }];
  }
  const sourceMap = new Map(sources.map((source) => [source.key, source]));
  let selected = question.sourceKeys.map((key) => sourceMap.get(key)).filter((item): item is ExamSourceItem => Boolean(item)).slice(0, 2);
  if (!selected.length && sources[0]) selected = [sources[0]];
  return selected.map((source) => ({
    sourceType: source.key.split(".")[0] ?? scope,
    sourceLabel: source.label,
    sourceKey: source.key,
    excerpt: source.text.slice(0, 700),
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

export async function generateExamSet(teacherId: string, input: GenerateExamInput, generator: ExamGenerator = openAiExamGenerator) {
  validateGenerateInput(input);
  const prepared = await prepareClassSources(input.classNumber);
  const scope = input.commonScope.trim() || "통합과학 탐구 설계, 자료 해석, 변인 통제, 오차 분석";
  const commonQuestions = await generator.generateCommon({
    count: input.commonCount,
    scope,
    teamSummaries: prepared.teams.map((team) => ({
      teamRef: team.source.teamRef,
      topic: team.source.topic,
      sources: team.source.sources.slice(0, 8).map((source) => ({ ...source, text: source.text.slice(0, 500) })),
    })),
  });
  const teamResults = await mapWithConcurrency(prepared.teams, 2, async (team) => generator.generateTeam({
    team: team.source,
    teamCount: input.teamCount,
    individualCount: input.individualCount,
  }));
  const scores = questionScores(
    { common: input.commonCount, team: input.teamCount, individual: input.individualCount },
    input.totalScore,
  );

  const db = await getDb();
  const client = await db.connect();
  const examSetId = createId("exam_set");
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO exam_sets
        (id, class_id, title, common_count, team_count, individual_count, total_score, common_scope, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [examSetId, prepared.classId, input.title.trim(), input.commonCount, input.teamCount, input.individualCount, input.totalScore, scope, teacherId],
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

export async function getExamManagementData(classNumber = 9, selectedSetId?: string): Promise<ExamManagementData> {
  const db = await getDb();
  const setsResult = await db.query<{
    id: string; title: string; class_number: number; status: "draft" | "confirmed"; generated_at: Date | string;
  }>(
    `SELECT es.id, es.title, c.class_number, es.status, es.generated_at
       FROM exam_sets es JOIN classes c ON c.id = es.class_id
      WHERE c.academic_year = $1 AND c.class_number = $2
      ORDER BY es.created_at DESC`,
    [ACADEMIC_YEAR, classNumber],
  );
  const setId = selectedSetId && setsResult.rows.some((row) => row.id === selectedSetId)
    ? selectedSetId
    : setsResult.rows[0]?.id;
  const sets = setsResult.rows.map((row) => ({
    id: row.id, title: row.title, classNumber: row.class_number, status: row.status, generatedAt: iso(row.generated_at)!,
  }));
  if (!setId) return { sets, selected: null };

  const setResult = await db.query<{
    id: string; title: string; class_number: number; status: "draft" | "confirmed";
    common_count: number; team_count: number; individual_count: number; total_score: number;
    common_scope: string; generated_at: Date | string; confirmed_at: Date | string | null;
  }>(
    `SELECT es.id, es.title, c.class_number, es.status, es.common_count, es.team_count,
            es.individual_count, es.total_score, es.common_scope, es.generated_at, es.confirmed_at
       FROM exam_sets es JOIN classes c ON c.id = es.class_id WHERE es.id = $1`,
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
    class_number: number; status: string; question_scores: Record<string, number> | string | null;
    total_score: number | null; teacher_feedback: string | null; graded_at: Date | string | null; published_at: Date | string | null;
  }>(
    `SELECT e.id AS exam_id, e.student_id, u.name AS student_name, u.login_id,
            t.id AS team_id, t.name AS team_name, c.class_number, e.status,
            er.question_scores, er.total_score, er.teacher_feedback, er.graded_at, er.published_at
       FROM exams e
       JOIN users u ON u.id = e.student_id
       JOIN inquiry_sessions s ON s.id = e.session_id
       JOIN teams t ON t.id = s.team_id
       JOIN classes c ON c.id = t.class_id
       LEFT JOIN exam_results er ON er.exam_id = e.id
      WHERE e.exam_set_id = $1
      ORDER BY t.team_number, u.login_id`,
    [setId],
  );
  return {
    sets,
    selected: {
      id: set.id, title: set.title, classNumber: set.class_number, status: set.status,
      commonCount: set.common_count, teamCount: set.team_count, individualCount: set.individual_count,
      totalScore: set.total_score, commonScope: set.common_scope, generatedAt: iso(set.generated_at)!,
      confirmedAt: iso(set.confirmed_at), questions: questionResult.rows.map(toQuestion),
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

async function assertDraftSetForQuestion(questionId: string) {
  const db = await getDb();
  const result = await db.query<{ exam_set_id: string; status: string; scope: ExamScope; sequence: number; max_score: number }>(
    `SELECT q.exam_set_id, es.status, q.scope, q.sequence, q.max_score
       FROM exam_questions q JOIN exam_sets es ON es.id = q.exam_set_id WHERE q.id = $1`,
    [questionId],
  );
  const row = result.rows[0];
  if (!row) throw new ExamServiceError("문항을 찾을 수 없습니다.", 404);
  if (row.status !== "draft") throw new ExamServiceError("확정된 시험은 수정할 수 없습니다.");
  return row;
}

export async function updateExamQuestion(teacherId: string, input: {
  questionId: string; stimulus: string; question: string; competency: string; difficulty: ExamDifficulty;
  modelAnswer: string; scoringRubric: Array<{ criterion: string; points: number }>;
}) {
  await assertDraftSetForQuestion(input.questionId);
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
  const current = await assertDraftSetForQuestion(questionId);
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
    await client.query(`UPDATE exam_sets SET ${countColumn} = ${countColumn} - 1, total_score = total_score - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [current.exam_set_id, current.max_score]);
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
  const data = (await getExamManagementDataForSet(examSetId));
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

async function getExamManagementDataForSet(examSetId: string) {
  const db = await getDb();
  const classResult = await db.query<{ class_number: number }>(
    "SELECT c.class_number FROM exam_sets es JOIN classes c ON c.id = es.class_id WHERE es.id = $1",
    [examSetId],
  );
  const classNumber = classResult.rows[0]?.class_number;
  if (!classNumber) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
  const data = await getExamManagementData(classNumber, examSetId);
  if (!data.selected) throw new ExamServiceError("시험을 찾을 수 없습니다.", 404);
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
  const data = await getExamManagementDataForSet(exam.exam_set_id);
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
  if (exam.status !== "graded" && exam.status !== "published") throw new ExamServiceError("채점을 저장한 뒤 결과를 공개해 주세요.");
  const updated = await db.query("UPDATE exam_results SET published_at = CURRENT_TIMESTAMP WHERE exam_id = $1 RETURNING id", [examId]);
  if (!updated.rows[0]) throw new ExamServiceError("저장된 채점 결과가 없습니다.");
  await db.query("UPDATE exams SET status = 'published' WHERE id = $1", [examId]);
  await db.query("UPDATE inquiry_sessions SET stage = 'EVALUATING', last_activity_at = CURRENT_TIMESTAMP WHERE id = $1", [exam.session_id]);
  await audit(teacherId, "exam_result_published", "exam", examId);
}

export async function getPublishedStudentExamResult(studentId: string) {
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
       JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = e.student_id AND tm.status = 'active'
       JOIN exam_results er ON er.exam_id = e.id
      WHERE e.student_id = $1 AND e.status = 'published' AND er.published_at IS NOT NULL
      ORDER BY er.published_at DESC LIMIT 1`,
    [studentId],
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

export async function getExamSetForPdf(examSetId: string, studentId?: string) {
  const data = await getExamManagementDataForSet(examSetId);
  if (data.status !== "confirmed") throw new ExamServiceError("교사가 확정한 시험만 출력할 수 있습니다.");
  const papers = studentId ? data.papers.filter((paper) => paper.studentId === studentId) : data.papers;
  if (!papers.length) throw new ExamServiceError("출력할 시험지가 없습니다.", 404);
  return { ...data, papers };
}
