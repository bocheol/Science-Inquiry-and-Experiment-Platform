import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { getCycleJourney, requestCycleAnalysis, saveCycleDecision } from "@/lib/cycle-analysis";
import { transitionCycle } from "@/lib/cycle-workflow";
import { restorePlanRevision } from "@/lib/document-history";
import { getExamDocumentSources } from "@/lib/exam-document-sources";

const teamId = "cycle_workflow_team";
const sessionId = "cycle_workflow_session";
const planId = "cycle_workflow_plan";
const reportId = "cycle_workflow_report";
const studentId = "cycle_workflow_student";
let firstCycleId = "";

function analysisResult(label: string) {
  return {
    overview: `${label} 고정 자료 분석`,
    inquiryField: "화학",
    researchType: "비교 실험",
    strengths: [{ statement: "측정할 주제가 기록되어 있습니다.", evidenceIds: ["plan:topic"] }],
    findings: [{
      category: "hypothesis_variables_measurement" as const,
      priority: "required" as const,
      title: "측정 연결 확인",
      observation: "주제와 측정 방법의 연결을 확인해야 합니다.",
      evidenceIds: ["plan:topic"],
      question: "어떤 값을 같은 간격으로 측정할 것인가요?",
    }],
    suggestions: [
      {
        title: "측정 간격 정하기",
        rationale: "비교 가능한 기록을 만들기 위해 필요합니다.",
        evidenceIds: ["plan:topic"],
        feasibleNextStep: "다음 회차 계획에 측정 간격을 적습니다.",
        safetyNote: "기존 안전 수칙을 다시 확인합니다.",
        questionForStudents: "현재 여건에서 가능한 간격은 얼마인가요?",
      },
      {
        title: "반복 횟수 정하기",
        rationale: "한 번의 측정만으로 판단하지 않기 위해 필요합니다.",
        evidenceIds: ["plan:topic"],
        feasibleNextStep: "가능한 반복 횟수를 팀이 합의합니다.",
        safetyNote: "반복 과정에서도 보호 장비를 유지합니다.",
        questionForStudents: "남은 시간에 몇 번 반복할 수 있나요?",
      },
    ],
    cycleComparison: [],
    limitations: ["실제 기구 보유 여부는 자료에서 확인할 수 없습니다."],
  };
}

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, 'Cycle 합성 학생', 'cycle-workflow-student', 2026, 'student', 'class_2026_3', 'unused', FALSE)`,
    [studentId],
  );
  await db.query(
    `INSERT INTO teams (id, class_id, team_number, name, leader_user_id)
     VALUES ($1, 'class_2026_3', 94, 'Cycle 검증팀', $2)`,
    [teamId, studentId],
  );
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1,$2,$3)", [createId("member"), teamId, studentId]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, selected_topic, stage) VALUES ($1,$2,'온도별 용해도','REPORTING')", [sessionId, teamId]);
  firstCycleId = await ensureInitialCycle(db, sessionId, "teacher_bootstrap");
  await db.query(
    `INSERT INTO investigation_plans (id, session_id, cycle_id, form_data, review_status)
     VALUES ($1,$2,$3,$4,'approved')`,
    [planId, sessionId, firstCycleId, JSON.stringify({ topic: "온도별 용해도", method: "온도를 바꾸어 측정한다." })],
  );
  await db.query(
    `INSERT INTO reports (id, session_id, cycle_id, form_data, status)
     VALUES ($1,$2,$3,$4,'reviewed')`,
    [reportId, sessionId, firstCycleId, JSON.stringify({ title: "온도별 용해도", result: "합성 측정 결과" })],
  );
  await db.query("INSERT INTO report_member_roles (report_id,user_id,role_description) VALUES ($1,$2,'첫 회차 실제 역할')", [reportId, studentId]);
  await db.query(
    `INSERT INTO material_requests
      (id, submission_id, session_id, cycle_id, team_id, submitted_by, form_data, sync_status)
     VALUES ('cycle_workflow_material','cycle-workflow-material',$1,$2,$3,$4,$5,'synced')`,
    [sessionId, firstCycleId, teamId, studentId, JSON.stringify([{ name: "비커", link: "https://secret.example/item", quantity: 1, unitPrice: 1000, shipping: 0 }])],
  );
  await db.query(
    `INSERT INTO experiment_journals
      (id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations, reflections)
     VALUES ('cycle_workflow_journal_1',$1,$2,$3,1,'2026-09-08','용액을 준비했다.','온도에 따라 차이가 있었다.','개인 성찰은 AI 근거에서 제외한다.')`,
    [sessionId, firstCycleId, studentId],
  );
  await db.query(
    `INSERT INTO messages (id, session_id, cycle_id, sender_id, role, content, sequence)
     VALUES ('cycle_workflow_message_1',$1,$2,$3,'user','측정 간격을 어떻게 정할까?',1)`,
    [sessionId, firstCycleId, studentId],
  );
});

describe("evidence-bound multi-cycle workflow", () => {
  it("reuses one fixed analysis, keeps student decisions optional, and starts an isolated next cycle", async () => {
    const generate = vi.fn(async ({ snapshot }: { snapshot: { materialRequests: Array<{ items: unknown[] }>; journals: Array<Record<string, unknown>> } }) => {
      expect(JSON.stringify(snapshot.materialRequests)).not.toContain("secret.example");
      expect(JSON.stringify(snapshot.journals)).not.toContain("개인 성찰");
      expect(JSON.stringify(snapshot.journals)).not.toContain(studentId);
      return { result: analysisResult("중간"), model: "synthetic-cycle-model" };
    });
    const first = await requestCycleAnalysis(firstCycleId, "intermediate", "teacher_bootstrap", generate);
    const repeated = await requestCycleAnalysis(firstCycleId, "intermediate", "teacher_bootstrap", generate);
    expect(repeated.id).toBe(first.id);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(first.documents.plan.formData.topic).toBe("온도별 용해도");

    const firstSuggestion = first.result.suggestions[0]!;
    const secondSuggestion = first.result.suggestions[1]!;
    const saved = await saveCycleDecision({
      analysisId: first.id, suggestionId: firstSuggestion.id, decision: "modified",
      reason: "수업 시간 안에 가능한 10분 간격으로 수정한다.", expectedVersion: null, studentId,
    });
    expect(saved.version).toBe(1);
    const db = await getDb();
    await db.query("UPDATE messages SET content = '분석 뒤 바뀐 질문' WHERE id = 'cycle_workflow_message_1'");
    await expect(saveCycleDecision({
      analysisId: first.id, suggestionId: secondSuggestion.id, decision: "accepted",
      reason: "낡은 분석 화면에서는 저장되면 안 된다.", expectedVersion: null, studentId,
    })).rejects.toThrow("최신 분석");
    await db.query("UPDATE messages SET content = '측정 간격을 어떻게 정할까?' WHERE id = 'cycle_workflow_message_1'");

    const moved = await transitionCycle({ cycleId: firstCycleId, action: "start_next", teacherId: "teacher_bootstrap" });
    expect(moved.nextCycleId).toBe(`cycle_${sessionId}_2`);
    const cycles = await db.query<{ ordinal: number; status: string }>(
      "SELECT ordinal, status FROM inquiry_cycles WHERE session_id = $1 ORDER BY ordinal", [sessionId],
    );
    expect(cycles.rows).toEqual([{ ordinal: 1, status: "completed" }, { ordinal: 2, status: "active" }]);
    const documents = await db.query<{ plan_cycle: string; plan_data: Record<string, unknown>; report_cycle: string; report_data: Record<string, unknown> }>(
      `SELECT p.cycle_id AS plan_cycle, p.form_data AS plan_data, r.cycle_id AS report_cycle, r.form_data AS report_data
         FROM investigation_plans p JOIN reports r ON r.session_id = p.session_id WHERE p.session_id = $1`, [sessionId],
    );
    expect(documents.rows[0]).toMatchObject({ plan_cycle: moved.nextCycleId, plan_data: {}, report_cycle: moved.nextCycleId, report_data: {} });
    const journey = await getCycleJourney(sessionId);
    expect(journey[0]?.analysis?.documents.plan.formData.topic).toBe("온도별 용해도");
    expect(journey[0]?.analysis?.decisions).toHaveLength(1);
    const examSources = await getExamDocumentSources(sessionId, "teacher_bootstrap");
    expect(examSources.find(source => source.kind === "plan")?.form.topic).toBe("온도별 용해도");
    expect(examSources.find(source => source.kind === "report")).toMatchObject({ cycleId: firstCycleId, form: { result: "합성 측정 결과" }, roles: [{ userId: studentId, description: "첫 회차 실제 역할" }] });
    expect(examSources.every(source => source.cycleId === firstCycleId)).toBe(true);

    const oldRevision = await db.query<{ id: string }>(
      "SELECT id FROM document_revisions WHERE document_id = $1 AND cycle_id = $2 AND action = 'cycle_completed' LIMIT 1",
      [planId, firstCycleId],
    );
    await expect(restorePlanRevision(planId, oldRevision.rows[0]!.id, "teacher_bootstrap")).rejects.toThrow("이력");
    await db.query(
      `INSERT INTO experiment_journals
        (id, session_id, cycle_id, student_id, session_number, journal_date, activities, observations, reflections)
       VALUES ('cycle_workflow_journal_2',$1,$2,$3,1,'2026-09-09','두 번째 회차','새 관찰','새 성찰')`,
      [sessionId, moved.nextCycleId, studentId],
    );
    expect((await db.query("SELECT id FROM experiment_journals WHERE session_id = $1 AND student_id = $2 AND session_number = 1", [sessionId, studentId])).rows).toHaveLength(2);
  });

  it("uses prior analysis and decisions in the final snapshot, then completes the project without reopening it", async () => {
    const db = await getDb();
    const nextCycleId = `cycle_${sessionId}_2`;
    await db.query(
      "UPDATE investigation_plans SET form_data = $1, review_status = 'approved' WHERE id = $2",
      [JSON.stringify({ topic: "온도별 용해도 재탐구", method: "10분 간격으로 세 번 측정한다." }), planId],
    );
    await db.query(
      "UPDATE reports SET form_data = $1, status = 'reviewed' WHERE id = $2",
      [JSON.stringify({ title: "재탐구 결과", result: "반복 측정 기록" }), reportId],
    );
    const generate = vi.fn(async ({ snapshot }: { snapshot: { trajectoryContext: Array<{ decisions: unknown[] }> } }) => {
      expect(snapshot.trajectoryContext).toHaveLength(1);
      expect(snapshot.trajectoryContext[0]?.decisions).toHaveLength(1);
      return { result: { ...analysisResult("최종"), cycleComparison: [{ aspect: "측정 방법", change: "측정 간격과 반복 횟수를 명시했다.", evidenceIds: ["plan:method"] }] }, model: "synthetic-cycle-model" };
    });
    const final = await requestCycleAnalysis(nextCycleId, "final", "teacher_bootstrap", generate);
    expect(final.analysisType).toBe("final");
    await transitionCycle({ cycleId: nextCycleId, action: "finish_project", teacherId: "teacher_bootstrap" });
    expect((await db.query("SELECT stage FROM inquiry_sessions WHERE id = $1", [sessionId])).rows[0]?.stage).toBe("COMPLETED");
    expect((await db.query("SELECT id FROM inquiry_cycles WHERE session_id = $1 AND status = 'active'", [sessionId])).rows).toHaveLength(0);
    await expect(transitionCycle({ cycleId: nextCycleId, action: "finish_project", teacherId: "teacher_bootstrap" }))
      .rejects.toThrow("현재 진행 중인 회차");
  });
});
