import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { assignClubStudent, createClub, createClubTeam, enrollClubStudent } from "@/lib/clubs";
import { createClubConfigDraft, getClubSettingsData, publishClubConfig, updateClubConfigDraft } from "@/lib/club-settings";
import { changeEvaluationRoundStatus, createClubEvaluationRound, getClubEvaluationManagementData, getStudentEvaluationData } from "@/lib/evaluation-service";
import { confirmExamSet, createCorrectionExamSet, generateExamSet, getExamManagementData, getExamSetForPdf } from "@/lib/exam-service";
import type { ExamGenerator, GeneratedExamQuestion } from "@/lib/exam-ai";

function generated(label: string): GeneratedExamQuestion {
  return { stimulus: `${label} 자료`, question: `${label}을 설명하시오.`, competency: "탐구 역량", difficulty: "standard", modelAnswer: `${label} 답`, rubric: [{ criterion: "근거 제시", points: 1 }], sourceKeys: [] };
}

const generator: ExamGenerator = {
  async generateCommon(input) { return Array.from({ length: input.count }, (_, index) => generated(`공통${index + 1}`)); },
  async generateTeam(input) {
    return {
      teamQuestions: Array.from({ length: input.teamCount }, (_, index) => ({ ...generated(`팀${index + 1}`), sourceKeys: [input.team.sources[0]!.key] })),
      individualQuestions: input.team.students.map((student) => ({ studentRef: student.studentRef, questions: Array.from({ length: input.individualCount }, (_, index) => generated(`개인${index + 1}`)) })),
    };
  },
};

describe("club evaluation and exam runtime", () => {
  it("pins separate evaluation settings and produces a correctable club exam", async () => {
    const db = await getDb();
    await db.query("UPDATE users SET is_master = TRUE, must_change_password = FALSE WHERE id = 'teacher_bootstrap'");
    const clubId = await createClub("teacher_bootstrap", "운영연결시험동아리");
    const selfId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "self_evaluation" });
    const peerId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "peer_evaluation" });
    const examConfigId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "exam" });
    const settings = await getClubSettingsData("teacher_bootstrap");
    const club = settings.clubs.find((item) => item.id === clubId)!;
    for (const [id, prompt] of [[selfId, "내 역할을 수행했다"], [peerId, "팀 활동에 협력했다"]] as const) {
      const version = club.versions.find((item) => item.id === id)!;
      const definition = structuredClone(version.definition) as { items: Array<{ prompt: string }> };
      definition.items[0]!.prompt = prompt;
      await updateClubConfigDraft("teacher_bootstrap", { versionId: id, title: version.title, definition, expectedRevision: version.revision });
    }
    await publishClubConfig("teacher_bootstrap", selfId, "운영연결시험동아리");
    await publishClubConfig("teacher_bootstrap", peerId, "운영연결시험동아리");
    await publishClubConfig("teacher_bootstrap", examConfigId, "운영연결시험동아리");

    const teamId = await createClubTeam("teacher_bootstrap", clubId, "실행팀");
    await db.query("UPDATE investigation_plans SET form_data = $1, review_status = 'approved' WHERE session_id IN (SELECT id FROM inquiry_sessions WHERE team_id = $2)", [JSON.stringify({ purpose: "합성 탐구 목적" }), teamId]);
    const students: string[] = [];
    for (const loginId of ["20951", "20952", "20953", "20954"]) {
      const student = await enrollClubStudent("teacher_bootstrap", clubId, loginId, `동아리${loginId}`);
      students.push(student.studentId);
      await assignClubStudent("teacher_bootstrap", clubId, student.studentId, teamId, loginId === "20951");
    }

    const roundId = await createClubEvaluationRound("teacher_bootstrap", { clubId, title: "동아리 평가" });
    await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "open");
    const studentEvaluation = await getStudentEvaluationData(students[0]!, teamId);
    expect(studentEvaluation?.round.template.items[0]?.prompt).toBe("내 역할을 수행했다");
    expect(studentEvaluation?.round.peerTemplate.items[0]?.prompt).toBe("팀 활동에 협력했다");
    const management = await getClubEvaluationManagementData("teacher_bootstrap", clubId, roundId);
    expect(management).toMatchObject({ clubId, scopeLabel: "운영연결시험동아리" });
    expect(management.selected?.progress).toHaveLength(4);

    const examSetId = await generateExamSet("teacher_bootstrap", {
      clubId, configVersionId: examConfigId, title: "동아리 수행평가", commonCount: 1, teamCount: 1, individualCount: 1, totalScore: 30, commonScope: "탐구 설계",
    }, generator);
    const examData = await getExamManagementData(9, examSetId, "teacher_bootstrap", clubId);
    expect(examData).toMatchObject({ clubId, activityLabel: "운영연결시험동아리" });
    expect(examData.selected?.papers).toHaveLength(4);
    await confirmExamSet("teacher_bootstrap", examSetId);
    expect((await getExamSetForPdf(examSetId, undefined, "teacher_bootstrap")).activityLabel).toBe("운영연결시험동아리");
    const correctionId = await createCorrectionExamSet("teacher_bootstrap", examSetId, "동아리 시험 오탈자 교정");
    expect((await getExamManagementData(9, correctionId, "teacher_bootstrap", clubId)).selected).toMatchObject({ status: "draft", revisionNumber: 2, parentExamSetId: examSetId });
  });
});
