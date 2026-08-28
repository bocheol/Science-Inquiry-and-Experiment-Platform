import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import {
  changeEvaluationRoundStatus,
  CORE_EVALUATION_ITEMS,
  createEvaluationRound,
  getEvaluationManagementData,
  getStudentEvaluationData,
  publishEvaluationRound,
  reviewPeerComment,
  saveEvaluationTeacherSummary,
  savePeerEvaluation,
  saveSelfEvaluation,
  type EvaluationResponse,
  type PeerEvaluationValue,
} from "@/lib/evaluation-service";
import { createId } from "@/lib/id";

const teamId = "evaluation_v9_team";
const sessionId = "evaluation_v9_session";
const students = ["evaluation_target", "evaluation_peer_1", "evaluation_peer_2", "evaluation_peer_3", "evaluation_peer_4"];
let roundId = "";

function peerResponses(value: PeerEvaluationValue): EvaluationResponse<PeerEvaluationValue>[] {
  return CORE_EVALUATION_ITEMS.map((item) => ({
    itemId: item.id,
    value,
    reason: value === "unable_to_judge" ? "직접 함께 관찰할 시간이 부족했습니다." : "",
  }));
}

beforeAll(async () => {
  const db = await getDb();
  for (const [index, studentId] of students.entries()) {
    await db.query(
      `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
       VALUES ($1, $2, $3, 2026, 'student', 'class_2026_8', 'unused', FALSE)`,
      [studentId, `평가학생${index + 1}`, `evaluation-${index + 1}`],
    );
  }
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_8', 95, '평가기준시험조', $2)",
    [teamId, students[0]],
  );
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'REPORTING')", [sessionId, teamId]);
  for (const studentId of students) {
    await db.query("INSERT INTO team_members (id, team_id, user_id, status) VALUES ($1, $2, $3, 'active')", [createId("member"), teamId, studentId]);
  }
  roundId = await createEvaluationRound("teacher_bootstrap", { classNumber: 8, title: "v9 행동 기준 평가", optionalItem: "none" });
  await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "open");
});

describe("v9 self and peer evaluation rules", () => {
  it("requires a reason for activity-unavailable self ratings", async () => {
    const responses = CORE_EVALUATION_ITEMS.map((item, index) => ({
      itemId: item.id,
      value: index === 0 ? "activity_unavailable" as const : 3 as const,
      reason: "",
    }));
    await expect(saveSelfEvaluation(students[0]!, { roundId, responses, reflections: ["실험 설계를 맡았다.", "자료 공유를 더 빨리 하겠다."] }))
      .rejects.toThrow("활동 기회가 없었던 이유");
    responses[0]!.reason = "전입 전 활동이라 참여 기회가 없었습니다.";
    await expect(saveSelfEvaluation(students[0]!, { roundId, responses, reflections: ["실험 설계를 맡았다.", "자료 공유를 더 빨리 하겠다."] }))
      .resolves.toBeUndefined();
  });

  it("requires private evidence for low ratings and excludes unable-to-judge from valid counts", async () => {
    await expect(savePeerEvaluation(students[1]!, {
      roundId, evaluateeId: students[0]!, responses: peerResponses(2), privateEvidence: "", publicComment: "", confirmed: true,
    })).rejects.toThrow("관찰 근거");

    for (const peerId of students.slice(1, 3)) {
      await savePeerEvaluation(peerId!, {
        roundId, evaluateeId: students[0]!, responses: peerResponses(3), privateEvidence: "", publicComment: peerId === students[1] ? "측정 자료를 빠르게 공유해 도움이 되었습니다." : "", confirmed: true,
      });
    }
    await savePeerEvaluation(students[3]!, {
      roundId, evaluateeId: students[0]!, responses: peerResponses("unable_to_judge"), privateEvidence: "", publicComment: "", confirmed: true,
    });
    let management = await getEvaluationManagementData(8, roundId);
    let target = management.selected!.progress.find((student) => student.studentId === students[0]);
    expect(target?.validCounts.role_commitment).toBe(2);
    expect(target?.disclosureEligible).toBe(false);

    await savePeerEvaluation(students[4]!, {
      roundId, evaluateeId: students[0]!, responses: peerResponses(4), privateEvidence: "", publicComment: "", confirmed: true,
    });
    management = await getEvaluationManagementData(8, roundId);
    target = management.selected!.progress.find((student) => student.studentId === students[0]);
    expect(target?.validCounts.role_commitment).toBe(3);
    expect(target?.disclosureEligible).toBe(true);
  });

  it("publishes only teacher-reviewed anonymous comments after the three-rating threshold", async () => {
    await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "close");
    const management = await getEvaluationManagementData(8, roundId);
    const pending = management.selected!.peerEvaluations.find((evaluation) => evaluation.publicComment);
    expect(pending?.commentReviewStatus).toBe("pending");
    await expect(publishEvaluationRound("teacher_bootstrap", roundId)).rejects.toThrow("검토하지 않은 익명 의견");
    await reviewPeerComment("teacher_bootstrap", {
      evaluationId: pending!.id,
      status: "approved",
      redactedPublicComment: "측정 자료를 빠르게 공유해 도움이 되었습니다.",
    });
    for (const studentId of students.slice(1)) {
      await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId, studentId: studentId!, teacherSummary: "유효 평가가 부족하여 교사가 활동 기록을 종합했습니다." });
    }
    await publishEvaluationRound("teacher_bootstrap", roundId);
    const result = await getStudentEvaluationData(students[0]!);
    expect(result?.result?.peerAverages.role_commitment).toBe(3.3);
    expect(result?.result?.approvedComments).toEqual(["측정 자료를 빠르게 공유해 도움이 되었습니다."]);
    expect(JSON.stringify(result?.result)).not.toContain(students[1]);
  });
});
