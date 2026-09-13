import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { generateExamSet, getExamManagementData } from "@/lib/exam-service";
import type { ExamGenerator, ExamSourceItem, GeneratedExamQuestion } from "@/lib/exam-ai";

it("pins each selected journal from repeated lesson numbers to its own cycle and original record", async () => {
  const db = await getDb();
  const team = "exam_cycle_source_team", student = "exam_cycle_source_student";
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ($1,'class_2026_7',1,'합성 시험 팀')", [team]);
  await db.query("INSERT INTO inquiry_sessions (id,team_id) VALUES ($1,$1)", [team]);
  await db.query("INSERT INTO users (id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES ($1,'합성 학생','10791',2026,'student','class_2026_7','unused',FALSE)", [student]);
  await db.query("INSERT INTO team_members (id,team_id,user_id) VALUES ($1,$2,$1)", [student, team]);
  for (const ordinal of [1, 2]) {
    const cycle = `exam_source_cycle_${ordinal}`;
    await db.query("INSERT INTO inquiry_cycles (id,session_id,ordinal,title,status,origin) VALUES ($1,$2,$3,'같은 제목',$4,'configured')", [cycle, team, ordinal, ordinal === 1 ? "completed" : "active"]);
    await db.query("INSERT INTO experiment_journals (id,session_id,cycle_id,student_id,session_number,journal_date,observations) VALUES ($1,$2,$3,$4,1,'2026-09-08',$5)", [`exam_source_journal_${ordinal}`, team, cycle, student, `${ordinal}회차만의 합성 관찰`]);
  }
  let sent: ExamSourceItem[] = [];
  const generator: ExamGenerator = {
    async generateCommon() { return []; },
    async generateTeam({ team }) {
      sent = team.students[0]!.sources.filter(source => source.key.endsWith(".observations"));
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map(source => source.key)).size).toBe(2);
      return { teamQuestions: [], individualQuestions: [{ studentRef: team.students[0]!.studentRef, questions: sent.map(source => ({
        stimulus: "합성 자료", question: "관찰의 근거를 설명하세요.", competency: "근거 해석", difficulty: "standard",
        modelAnswer: "관찰 기록을 근거로 설명한다.", rubric: [{ criterion: "근거 연결", points: 1 }], sourceKeys: [source.key],
      } satisfies GeneratedExamQuestion)) }] };
    },
  };
  const id = await generateExamSet("teacher_bootstrap", { classNumber: 7, title: "회차 근거 검증", commonCount: 0, teamCount: 0, individualCount: 2, totalScore: 20, commonScope: "" }, generator);
  const data = (await getExamManagementData(7, id)).selected!;
  expect(data.questions).toHaveLength(2);
  for (const [index, question] of data.questions.entries()) {
    const source = sent[index]!;
    expect(question.sourceEvidence).toEqual([{ sourceType: "journal", sourceLabel: source.label, sourceKey: source.key, excerpt: source.text }]);
    expect(question.stimulus).toContain(`${index + 1}회차 · 1차시`);
    expect(question.stimulus).toContain(`${index + 1}회차만의 합성 관찰`);
  }
  await db.query("UPDATE experiment_journals SET observations = '나중에 수정한 합성 내용' WHERE id = 'exam_source_journal_2'");
  expect((await getExamManagementData(7, id)).selected!.questions).toEqual(data.questions);
  const before = (await db.query("SELECT id FROM exam_sets")).rows.length;
  let attempts = 0;
  const recovering: ExamGenerator = { ...generator, async generateTeam(input) {
    const result = await generator.generateTeam(input);
    attempts += 1;
    if (attempts === 1) result.individualQuestions[0]!.questions[0]!.sourceKeys = ["another-student-journal"];
    return result;
  } };
  const retryInput = { classNumber: 7, title: "잘못된 출처 재시도", commonCount: 0, teamCount: 0, individualCount: 2, totalScore: 20, commonScope: "" };
  await expect(generateExamSet("teacher_bootstrap", retryInput, recovering, "source-retry-test")).rejects.toThrow("출처");
  expect((await db.query("SELECT id FROM exam_sets")).rows).toHaveLength(before);
  await generateExamSet("teacher_bootstrap", retryInput, recovering, "source-retry-test");
  expect(attempts).toBe(2);
});
