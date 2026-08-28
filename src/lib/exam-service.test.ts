import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { ExamGenerator, GeneratedExamQuestion, TeamExamSource } from "@/lib/exam-ai";
import {
  confirmExamSet,
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
      teamQuestions: Array.from({ length: input.teamCount }, (_, index) => question(`팀 ${index + 1}`, ["plan.method", "report.analysis"])),
      individualQuestions: input.team.students.map((student) => ({
        studentRef: student.studentRef,
        questions: Array.from({ length: input.individualCount }, (_, index) => question(`${student.studentRef} 개인 ${index + 1}`, ["journal.1.observations"])),
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
});

describe("fair, source-grounded exam workflow", () => {
  it("generates equal-scope papers without sending student identities or cross-student journals", async () => {
    examSetId = await generateExamSet("teacher_bootstrap", {
      classNumber, title: "탐구 수행평가", commonCount: 2, teamCount: 1, individualCount: 1,
      totalScore: 40, commonScope: "자료 해석과 오차 분석",
    }, fakeGenerator);

    const sent = `${capturedCommon}${JSON.stringify(capturedTeam)}`;
    for (const value of privateValues) expect(sent).not.toContain(value);
    expect(sent).not.toContain("퇴실 학생의 비공개 관찰");
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
});
