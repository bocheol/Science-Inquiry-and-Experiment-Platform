import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { ExamGenerator, GeneratedExamQuestion, TeamExamSource } from "@/lib/exam-ai";
import {
  confirmExamSet,
  createCorrectionExamSet,
  generateExamSet,
  getExamManagementData,
  getExamSetForPdf,
  getPublishedStudentExamResult,
  publishExamResult,
  questionsForPaper,
  saveExamResult,
} from "@/lib/exam-service";
import { buildExamPdf } from "@/lib/exam-pdf";

const classNumber = 8;
const classId = "class_2026_8";
const teamId = "exam_test_team";
const sessionId = "exam_test_session";
const reportId = "exam_test_report";
const activeIds = ["exam_test_student_1", "exam_test_student_2"];
const privateValues = ["홍비밀", "백보안", "윤퇴실", "10801", "10802", "10803"];
let examSetId = "";
let capturedTeam: TeamExamSource | null = null;
let capturedCommon = "";

function question(label: string, sourceKeys: string[] = []): GeneratedExamQuestion {
  return {
    stimulus: `${label} 제시 자료`, question: `${label}에서 근거와 결론의 관계를 설명하시오.`,
    competency: "자료 해석", difficulty: "standard", modelAnswer: `${label} 모범답안`,
    rubric: [{ criterion: "자료에서 근거를 찾음", points: 1 }, { criterion: "결론과 연결함", points: 1 }], sourceKeys,
  };
}

const fakeGenerator: ExamGenerator = {
  async generateCommon(input) {
    capturedCommon = JSON.stringify(input);
    return Array.from({ length: input.count }, (_, index) => question(`공통 ${index + 1}`));
  },
  async generateTeam(input) {
    capturedTeam = input.team;
    return {
      teamQuestions: Array.from({ length: input.teamCount }, (_, index) => question(`팀 ${index + 1}`, input.team.sources.filter(source => source.key.endsWith(".method") || source.key.endsWith(".analysis")).map(source => source.key))),
      individualQuestions: input.team.students.map((student) => ({
        studentRef: student.studentRef,
        questions: Array.from({ length: input.individualCount }, (_, index) => question(`${student.studentRef} 개인 ${index + 1}`, [student.sources.find(source => source.key.endsWith(".observations"))!.key])),
      })),
    };
  },
};

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '홍비밀', '10801', 2026, 'student', $4, 'unused', FALSE),
            ($2, '백보안', '10802', 2026, 'student', $4, 'unused', FALSE),
            ($3, '윤퇴실', '10803', 2026, 'student', $4, 'unused', FALSE)`,
    [activeIds[0], activeIds[1], "exam_test_inactive", classId],
  );
  await db.query("INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, $2, 1, '시험팀', $3)", [teamId, classId, activeIds[0]]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, selected_topic, stage) VALUES ($1, $2, '온도에 따른 용해도', 'REPORTING')", [sessionId, teamId]);
  for (const [index, studentId] of [...activeIds, "exam_test_inactive"].entries()) {
    await db.query("INSERT INTO team_members (id, team_id, user_id, status) VALUES ($1, $2, $3, $4)", [createId("member"), teamId, studentId, index === 2 ? "inactive" : "active"]);
  }
  await db.query(
    "INSERT INTO investigation_plans (id, session_id, form_data, review_status) VALUES ('exam_test_plan', $1, $2, 'approved')",
    [sessionId, JSON.stringify({ method: "홍비밀과 윤퇴실이 물의 온도를 바꾸고 용질의 질량을 측정한다.", purpose: "10801의 용해도 탐구" })],
  );
  await db.query("INSERT INTO reports (id, session_id, form_data, status) VALUES ($1, $2, $3, 'reviewed')", [reportId, sessionId, JSON.stringify({ analysis: "온도가 높을수록 용질이 더 많이 녹았다." })]);
  for (const [index, studentId] of activeIds.entries()) {
    await db.query("INSERT INTO report_member_roles (report_id, user_id, role_description) VALUES ($1, $2, $3)", [reportId, studentId, index ? "측정값 표 작성" : "온도 통제 및 측정"]);
    await db.query(
      `INSERT INTO experiment_journals (id, session_id, student_id, session_number, journal_date, activities, observations, reflections)
       VALUES ($1, $2, $3, 1, '2026-08-20', $4, $5, $6)`,
      [createId("journal"), sessionId, studentId, `${index + 1}번 학생 활동`, `${index + 1}번 학생만의 관찰`, `${index + 1}번 학생만의 성찰`],
    );
  }
  await db.query(
    `INSERT INTO experiment_journals (id, session_id, student_id, session_number, journal_date, observations)
     VALUES ('exam_inactive_journal', $1, 'exam_test_inactive', 1, '2026-08-20', '퇴실 학생의 비공개 관찰')`,
    [sessionId],
  );
  await db.query("INSERT INTO report_member_roles (report_id, user_id, role_description) VALUES ($1,'exam_test_inactive','제거 학생의 과거 역할')", [reportId]);
});

describe("fair, source-grounded exam workflow", () => {
  it("reuses completed AI steps and the final exam when the same generation request is retried", async () => {
    const common = vi.fn(async (input: Parameters<ExamGenerator["generateCommon"]>[0]) =>
      Array.from({ length: input.count }, (_, index) => question(`복구 공통 ${index + 1}`)));
    const team = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic team interruption"))
      .mockImplementation(async (input: Parameters<ExamGenerator["generateTeam"]>[0]) => ({
        teamQuestions: Array.from({ length: input.teamCount }, (_, index) => question(`복구 팀 ${index + 1}`, [input.team.sources.find(source => source.key.endsWith(".method"))!.key])),
        individualQuestions: input.team.students.map((student) => ({
          studentRef: student.studentRef,
          questions: Array.from({ length: input.individualCount }, (_, index) => question(`복구 개인 ${index + 1}`, [student.sources.find(source => source.key.endsWith(".observations"))!.key])),
        })),
      }));
    const recoveringGenerator: ExamGenerator = { generateCommon: common, generateTeam: team };
    const input = {
      classNumber, title: "복구 검증 수행평가", commonCount: 1, teamCount: 1, individualCount: 1,
      totalScore: 30, commonScope: "AI 작업 복구 검증",
    };
    const requestId = "a8e79089-7930-486b-a02c-4bdcb62c9f16";
    await expect(generateExamSet("teacher_bootstrap", input, recoveringGenerator, requestId)).rejects.toThrow("interruption");
    const recoveredId = await generateExamSet("teacher_bootstrap", input, recoveringGenerator, requestId);
    expect(await generateExamSet("teacher_bootstrap", input, recoveringGenerator, requestId)).toBe(recoveredId);
    expect(common).toHaveBeenCalledTimes(1);
    expect(team).toHaveBeenCalledTimes(2);
    expect((await getExamManagementData(classNumber, recoveredId)).selected?.questions).toHaveLength(4);
  });

  it("generates equal-scope papers without sending student identities or cross-student journals", async () => {
    examSetId = await generateExamSet("teacher_bootstrap", {
      classNumber, title: "탐구 수행평가", commonCount: 2, teamCount: 1, individualCount: 1,
      totalScore: 40, commonScope: "자료 해석과 오차 분석",
    }, fakeGenerator);

    const sent = `${capturedCommon}${JSON.stringify(capturedTeam)}`;
    for (const value of privateValues) expect(sent).not.toContain(value);
    expect(sent).not.toContain("퇴실 학생의 비공개 관찰");
    expect(sent).not.toContain("제거 학생의 과거 역할");
    const preservedRole = await (await getDb()).query("SELECT role_description FROM report_member_roles WHERE report_id = $1 AND user_id = 'exam_test_inactive'", [reportId]);
    expect(preservedRole.rows[0].role_description).toBe("제거 학생의 과거 역할");
    expect(capturedTeam!.sources.every((source) => !source.key.startsWith("journal."))).toBe(true);
    expect(capturedTeam!.students).toHaveLength(2);
    expect(capturedTeam!.students[0]!.sources.map((source) => source.text).join(" ")).toContain("1번 학생만의 관찰");
    expect(capturedTeam!.students[0]!.sources.map((source) => source.text).join(" ")).not.toContain("2번 학생만의 관찰");

    const data = (await getExamManagementData(classNumber, examSetId)).selected!;
    expect(data.papers).toHaveLength(2);
    expect(data.questions).toHaveLength(5);
    for (const paper of data.papers) {
      const questions = questionsForPaper(data, paper);
      expect(questions.map((item) => item.scope)).toEqual(["common", "common", "team", "individual"]);
      expect(questions.reduce((sum, item) => sum + item.maxScore, 0)).toBe(40);
    }
  });

  it("sends only approved/reviewed fixed documents after current drafts change and pins their exact source", async () => {
    const db = await getDb();
    await db.query("UPDATE investigation_plans SET form_data = $1, review_status = 'draft' WHERE id = 'exam_test_plan'", [JSON.stringify({ method: "절대 출제하지 않을 계획 초안" })]);
    await db.query("UPDATE reports SET form_data = $1, status = 'draft' WHERE id = $2", [JSON.stringify({ analysis: "절대 출제하지 않을 보고서 초안" }), reportId]);
    await db.query("UPDATE inquiry_sessions SET selected_topic = '절대 출제하지 않을 새 주제' WHERE id = $1", [sessionId]);
    let selectedSource: { key: string; label: string; text: string } | undefined;
    const generator: ExamGenerator = {
      async generateCommon() { return []; },
      async generateTeam({ team }) {
        expect(JSON.stringify(team)).not.toContain("절대 출제하지 않을");
        selectedSource = team.sources.find(source => source.key.startsWith("report.") && source.key.endsWith(".analysis"));
        expect(selectedSource?.text).toBe("온도가 높을수록 용질이 더 많이 녹았다.");
        expect(team.sources.some(source => source.key.startsWith("plan.") && source.text.includes("물의 온도"))).toBe(true);
        return { teamQuestions: [question("고정 근거", [selectedSource!.key])], individualQuestions: [] };
      },
    };
    const fixedId = await generateExamSet("teacher_bootstrap", { classNumber, title: "고정본 출제", commonCount: 0, teamCount: 1, individualCount: 0, totalScore: 20, commonScope: "" }, generator);
    const stored = (await getExamManagementData(classNumber, fixedId)).selected!.questions[0]!;
    expect(stored.sourceEvidence).toEqual([{ sourceType: "report", sourceKey: selectedSource!.key, sourceLabel: selectedSource!.label, excerpt: selectedSource!.text }]);
  });

  it("preserves the exact team and personal evidence when documents change during generation", async () => {
    const db = await getDb();
    const expected = new Map<string, Array<{ key: string; label: string; text: string }>>();
    const revisions = (await db.query("SELECT * FROM document_revisions WHERE document_id = $1 ORDER BY id", [reportId])).rows;
    const snapshots = (await db.query("SELECT * FROM plan_document_snapshots WHERE plan_id = 'exam_test_plan' ORDER BY id")).rows;
    const generator: ExamGenerator = {
      async generateCommon() { return []; },
      async generateTeam({ team }) {
        const teamSources = team.sources.filter(source => source.key.endsWith(".method") || source.key.endsWith(".analysis"));
        expect(teamSources).toHaveLength(2);
        expected.set("team", structuredClone(teamSources));
        for (const student of team.students) {
          const sources = student.sources.filter(source => source.key.startsWith("role.") || source.key.endsWith(".observations"));
          expect(sources).toHaveLength(2);
          expected.set(student.studentRef, structuredClone(sources));
        }
        // Change saved originals after preparation, while the generator is running.
        await db.query("UPDATE investigation_plans SET form_data = $1 WHERE id = 'exam_test_plan'", [JSON.stringify({ method: "생성 도중 바뀐 계획" })]);
        await db.query("UPDATE reports SET form_data = $1 WHERE id = $2", [JSON.stringify({ analysis: "생성 도중 바뀐 보고서" }), reportId]);
        await db.query("UPDATE report_member_roles SET role_description = '생성 도중 바뀐 역할' WHERE report_id = $1", [reportId]);
        await db.query("UPDATE experiment_journals SET observations = '생성 도중 바뀐 관찰' WHERE session_id = $1", [sessionId]);
        return {
          teamQuestions: [question("생성 중 고정 팀 근거", teamSources.map(source => source.key))],
          individualQuestions: team.students.map(student => ({ studentRef: student.studentRef, questions: [question(student.studentRef, expected.get(student.studentRef)!.map(source => source.key))] })),
        };
      },
    };
    const generatedId = await generateExamSet("teacher_bootstrap", { classNumber, title: "생성 중 원문 변경", commonCount: 0, teamCount: 1, individualCount: 1, totalScore: 20, commonScope: "" }, generator);
    const data = (await getExamManagementData(classNumber, generatedId)).selected!;
    expect(data.questions).toHaveLength(3);
    for (const [index, studentId] of activeIds.entries()) {
      const paper = data.papers.find(item => item.studentId === studentId)!;
      const items = questionsForPaper(data, paper);
      expect(items).toHaveLength(2);
      for (const item of items) {
        const sources = expected.get(item.scope === "team" ? "team" : `S${index + 1}`)!;
        expect(item.sourceEvidence).toEqual(sources.map(source => ({ sourceType: source.key.split(".")[0], sourceKey: source.key, sourceLabel: source.label, excerpt: source.text })));
      }
    }
    expect(JSON.stringify(data.questions)).not.toContain("생성 도중 바뀐");
    expect((await db.query("SELECT observations FROM experiment_journals WHERE session_id = $1", [sessionId])).rows.every(row => row.observations === "생성 도중 바뀐 관찰")).toBe(true);
    expect((await db.query("SELECT * FROM document_revisions WHERE document_id = $1 ORDER BY id", [reportId])).rows).toEqual(revisions);
    expect((await db.query("SELECT * FROM plan_document_snapshots WHERE plan_id = 'exam_test_plan' ORDER BY id")).rows).toEqual(snapshots);
  });

  it("confirms, prints, grades, and publishes only the active student's own result", async () => {
    await confirmExamSet("teacher_bootstrap", examSetId);
    const confirmed = await getExamSetForPdf(examSetId, activeIds[0]);
    const pdf = await buildExamPdf(confirmed);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.byteLength).toBeGreaterThan(5_000);
    if (process.env.WRITE_EXAM_QA_PDF) {
      const outputPath = path.resolve(process.env.WRITE_EXAM_QA_PDF);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, pdf);
    }

    const paper = confirmed.papers[0]!;
    const questions = questionsForPaper(confirmed, paper);
    await saveExamResult("teacher_bootstrap", {
      examId: paper.examId,
      questionScores: Object.fromEntries(questions.map((item) => [item.id, item.maxScore])),
      teacherFeedback: "근거와 결론을 명확히 연결했습니다.",
    });
    expect(await getPublishedStudentExamResult(activeIds[0])).toBeNull();
    await publishExamResult("teacher_bootstrap", paper.examId);
    expect(await getPublishedStudentExamResult(activeIds[0])).toMatchObject({ totalScore: 40, maxScore: 40 });
    expect(await getPublishedStudentExamResult(activeIds[1])).toBeNull();
    expect(await getPublishedStudentExamResult("exam_test_inactive")).toBeNull();
  });

  it("creates an editable correction copy while preserving the confirmed original and results", async () => {
    const correctionId = await createCorrectionExamSet("teacher_bootstrap", examSetId, "문항 표현 교정");
    const original = (await getExamManagementData(classNumber, examSetId)).selected!;
    const correction = (await getExamManagementData(classNumber, correctionId)).selected!;
    expect(original.status).toBe("confirmed");
    expect(original.papers.some((paper) => paper.result?.publishedAt)).toBe(true);
    expect(correction).toMatchObject({ status: "draft", revisionNumber: 2, parentExamSetId: examSetId, correctionReason: "문항 표현 교정" });
    expect(correction.papers.every((paper) => paper.result === null && paper.status === "generated")).toBe(true);
    expect(correction.questions).toHaveLength(original.questions.length);
    expect(new Set(correction.questions.map((question) => question.id))).not.toEqual(new Set(original.questions.map((question) => question.id)));
  });
});
