import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { reviewPlan } from "@/lib/plan-service";

const planId = "approval_guard_plan";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name) VALUES ('approval_guard_team', 'class_2026_1', 98, '승인보호시험조')",
  );
  await db.query(
    "INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ('approval_guard_session', 'approval_guard_team', 'EXPERIMENTING')",
  );
  await db.query(
    "INSERT INTO investigation_plans (id, session_id, review_status) VALUES ($1, 'approval_guard_session', 'approved')",
    [planId],
  );
});

describe("approved plan review guard", () => {
  it("rejects repeated approval and unconfirmed status changes", async () => {
    await expect(reviewPlan(planId, "teacher_bootstrap", "approved", ""))
      .rejects.toThrow("이미 승인된 계획서입니다.");
    await expect(reviewPlan(planId, "teacher_bootstrap", "feedback", "측정 조건을 보완해 주세요."))
      .rejects.toThrow("정확히 입력해 주세요.");
    await expect(reviewPlan(planId, "teacher_bootstrap", "feedback", "측정 조건을 보완해 주세요.", "1반 다른조"))
      .rejects.toThrow("정확히 입력해 주세요.");
  });

  it("allows an intentional status change with the exact class and team name", async () => {
    await reviewPlan(
      planId,
      "teacher_bootstrap",
      "feedback",
      "측정 조건을 보완해 주세요.",
      "1반 승인보호시험조",
    );
    const db = await getDb();
    const result = await db.query<{ review_status: string; teacher_feedback: string }>(
      "SELECT review_status, teacher_feedback FROM investigation_plans WHERE id = $1",
      [planId],
    );
    expect(result.rows[0]).toMatchObject({ review_status: "feedback", teacher_feedback: "측정 조건을 보완해 주세요." });
  });
});
