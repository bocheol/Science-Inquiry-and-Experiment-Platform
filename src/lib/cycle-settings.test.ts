import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { updateCycleSettings } from "@/lib/cycle-settings";

const cycleId = "cycle_cycle_settings_session_1";

beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ('cycle_settings_team', 'class_2026_2', 63, '회차설정시험조')");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('cycle_settings_session', 'cycle_settings_team')");
  await ensureInitialCycle(db, "cycle_settings_session", "teacher_bootstrap");
});

describe("common inquiry cycle settings", () => {
  it("lets a teacher label the shared class cycle without changing project documents", async () => {
    const db = await getDb();
    await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id, form_data, review_status) VALUES ('cycle_settings_plan', 'cycle_settings_session', $1, $2, 'approved')", [cycleId, JSON.stringify({ topic: "보존할 주제" })]);
    const before = (await db.query("SELECT form_data, review_status FROM investigation_plans WHERE id = 'cycle_settings_plan'")).rows[0];
    await updateCycleSettings({
      cycleId,
      title: "1차 온도 탐구",
      startDate: "2026-09-10",
      endDate: "2026-09-24",
      teacherId: "teacher_bootstrap",
    });
    expect((await db.query("SELECT title, origin FROM inquiry_cycles WHERE id = $1", [cycleId])).rows[0])
      .toMatchObject({ title: "1차 온도 탐구", origin: "configured" });
    expect((await db.query("SELECT form_data, review_status FROM investigation_plans WHERE id = 'cycle_settings_plan'")).rows[0]).toEqual(before);
  });

  it("rejects an end date before the start date", async () => {
    await expect(updateCycleSettings({
      cycleId,
      title: "잘못된 기간",
      startDate: "2026-09-25",
      endDate: "2026-09-20",
      teacherId: "teacher_bootstrap",
    })).rejects.toThrow("종료일");
  });

  it("blocks a teacher who is not assigned to the club", async () => {
    const db = await getDb();
    await db.query("INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password) VALUES ('cycle_unassigned_teacher', '다른 교사', 'cycle-unassigned', 2026, 'teacher', 'synthetic', FALSE)");
    await db.query("INSERT INTO clubs (id, academic_year, name, created_by) VALUES ('cycle_settings_club', 2026, '회차 동아리', 'teacher_bootstrap')");
    await db.query("INSERT INTO teams (id, club_id, team_number, name) VALUES ('cycle_settings_club_team', 'cycle_settings_club', 1, '동아리팀')");
    await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('cycle_settings_club_session', 'cycle_settings_club_team')");
    const clubCycleId = await ensureInitialCycle(db, "cycle_settings_club_session", "teacher_bootstrap");
    await expect(updateCycleSettings({
      cycleId: clubCycleId,
      title: "권한 없는 변경",
      startDate: null,
      endDate: null,
      teacherId: "cycle_unassigned_teacher",
    })).rejects.toThrow("권한이 없습니다");
  });
});
