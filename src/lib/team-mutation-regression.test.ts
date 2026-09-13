import { beforeAll, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { assignStudent, createTeam, removeStudent, setTeamLeader } from "@/lib/teams";
import { assignClubStudent, createClub, createClubTeam, enrollClubStudent, leaveClub } from "@/lib/clubs";
import { deactivateStudent, restoreStudent } from "@/lib/student-management";
import { importRoster } from "@/lib/roster";
import * as XLSX from "xlsx";

let clubId: string;
let clubTeam: string;
let secondClubTeam: string;
let courseTeam: string;
beforeAll(async () => {
  const db = await getDb();
  await db.query("UPDATE users SET must_change_password = FALSE WHERE id = 'teacher_bootstrap'");
  clubId = await createClub("teacher_bootstrap", "Synthetic membership club");
  clubTeam = await createClubTeam("teacher_bootstrap", clubId, "Synthetic first team");
  secondClubTeam = await createClubTeam("teacher_bootstrap", clubId, "Synthetic second team");
  await enrollClubStudent("teacher_bootstrap", clubId, "10901", "");
  await assignClubStudent("teacher_bootstrap", clubId, "demo_student_1", clubTeam, true);
  courseTeam = await createTeam("teacher_bootstrap", 9, 2);
});

it("moves a course leader atomically as one operation and retains club membership and old records", async () => {
  const db = await getDb();
  const old = (await db.query("SELECT * FROM team_members WHERE user_id = 'demo_student_1' AND team_id = 'demo_team_1' AND status = 'active'")).rows[0];
  const beforePlan = (await db.query("SELECT * FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0];
  await assignStudent("teacher_bootstrap", "demo_student_1", courseTeam, true);
  expect((await db.query("SELECT * FROM team_members WHERE id = $1", [old.id])).rows[0]).toMatchObject({ status: "inactive", joined_at: old.joined_at });
  expect((await db.query("SELECT left_at FROM team_members WHERE id = $1", [old.id])).rows[0].left_at).toBeTruthy();
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = 'demo_team_1'")).rows[0].leader_user_id).toBeNull();
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = $1", [courseTeam])).rows[0].leader_user_id).toBe("demo_student_1");
  expect((await db.query("SELECT id FROM team_members WHERE user_id = 'demo_student_1' AND team_id = $1 AND status = 'active'", [clubTeam])).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0]).toEqual(beforePlan);
  await expect(setTeamLeader("teacher_bootstrap", "demo_team_1", "demo_student_1")).rejects.toThrow("현재 팀원");
});

it("repeated assignment keeps one active membership and leaving/rejoining preserves distinct past participation", async () => {
  const db = await getDb();
  await assignStudent("teacher_bootstrap", "demo_student_1", courseTeam);
  await assignStudent("teacher_bootstrap", "demo_student_1", courseTeam);
  const memberships = await db.query("SELECT * FROM team_members WHERE user_id = 'demo_student_1' AND team_id = $1", [courseTeam]);
  expect(memberships.rows).toHaveLength(1);
  await removeStudent("teacher_bootstrap", "demo_student_1", courseTeam);
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = $1", [courseTeam])).rows[0].leader_user_id).toBeNull();
  await assignStudent("teacher_bootstrap", "demo_student_1", courseTeam, true);
  const after = await db.query("SELECT * FROM team_members WHERE user_id = 'demo_student_1' AND team_id = $1", [courseTeam]);
  expect(after.rows).toHaveLength(2);
  expect(after.rows.filter(row => row.status === "active")).toHaveLength(1);
});

it("club movement and departure preserve the independent course membership", async () => {
  const db = await getDb();
  await assignClubStudent("teacher_bootstrap", clubId, "demo_student_1", secondClubTeam, true);
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = $1", [clubTeam])).rows[0].leader_user_id).toBeNull();
  await leaveClub("teacher_bootstrap", clubId, "demo_student_1");
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = $1", [secondClubTeam])).rows[0].leader_user_id).toBeNull();
  expect((await db.query("SELECT id FROM team_members WHERE user_id = 'demo_student_1' AND team_id = $1 AND status = 'active'", [courseTeam])).rows).toHaveLength(1);
  expect((await db.query("SELECT id FROM team_members WHERE user_id = 'demo_student_1' AND team_id = $1", [clubTeam])).rows).toHaveLength(1);
});

it("inactive students and archived teams cannot gain membership or leadership", async () => {
  const db = await getDb();
  await db.query("UPDATE teams SET status = 'archived' WHERE id = $1", [courseTeam]);
  await expect(assignStudent("teacher_bootstrap", "demo_student_2", courseTeam)).rejects.toThrow("활성");
  await expect(setTeamLeader("teacher_bootstrap", courseTeam, "demo_student_1")).rejects.toThrow("현재 팀원");
  await db.query("UPDATE teams SET status = 'active' WHERE id = $1", [courseTeam]);
  await deactivateStudent("teacher_bootstrap", "demo_student_1");
  await expect(assignStudent("teacher_bootstrap", "demo_student_1", courseTeam)).rejects.toThrow("활성");
  await expect(setTeamLeader("teacher_bootstrap", courseTeam, "demo_student_1")).rejects.toThrow("현재 팀원");
  expect((await db.query("SELECT id FROM teams WHERE leader_user_id = 'demo_student_1'")).rows).toHaveLength(0);
  await restoreStudent("teacher_bootstrap", "demo_student_1");
  expect((await db.query("SELECT id FROM team_members WHERE user_id = 'demo_student_1' AND status = 'active'")).rows).toHaveLength(0);
});

it("reuses a preexisting course team ID and its original session instead of creating duplicate documents", async () => {
  const db = await getDb();
  expect(await createTeam("teacher_bootstrap", 9, 1)).toBe("demo_team_1");
  expect((await db.query("SELECT id FROM inquiry_sessions WHERE team_id = 'demo_team_1'")).rows).toEqual([{ id: "demo_session_1" }]);
  expect((await db.query("SELECT id FROM investigation_plans WHERE session_id = 'demo_session_1'")).rows).toEqual([{ id: "demo_plan_1" }]);
});

it("roster reimport moves course membership without resetting passwords, club participation, or old leadership", async () => {
  const db = await getDb();
  await assignStudent("teacher_bootstrap", "demo_student_1", "demo_team_1", true);
  await enrollClubStudent("teacher_bootstrap", clubId, "10901", "");
  await assignClubStudent("teacher_bootstrap", clubId, "demo_student_1", clubTeam, true);
  const original = (await db.query("SELECT password_hash FROM users WHERE id = 'demo_student_1'")).rows[0];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 반: 9, 번호: 1, 성명: "Synthetic student", "조 번호": 3 }]), "Synthetic roster");
  expect(await importRoster(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), "teacher_bootstrap")).toEqual({ total: 1, issued: [] });
  expect((await db.query("SELECT password_hash FROM users WHERE id = 'demo_student_1'")).rows[0].password_hash === original.password_hash).toBe(true);
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = 'demo_team_1'")).rows[0].leader_user_id).toBeNull();
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id = $1", [clubTeam])).rows[0].leader_user_id).toBe("demo_student_1");
  expect((await db.query("SELECT id FROM inquiry_sessions WHERE team_id = 'team_2026_9_3'")).rows).toHaveLength(1);
  expect((await db.query("SELECT id FROM team_members WHERE user_id = 'demo_student_1' AND team_id = 'demo_team_1' AND status = 'inactive'")).rows.length).toBeGreaterThan(0);
});
