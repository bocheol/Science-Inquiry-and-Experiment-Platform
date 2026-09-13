import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createClub, createClubTeam, enrollClubStudent, assignClubStudent } from "@/lib/clubs";
import { createClubConfigDraft, publishClubConfig } from "@/lib/club-settings";
import { getCustomTabResponse, saveCustomTabResponse } from "@/lib/club-custom-tabs";
import { ACADEMIC_YEAR } from "@/lib/constants";

it("blocks archived teams from reading and saving custom tabs without erasing their history", async () => {
  const db = await getDb();
  const clubId = await createClub("teacher_bootstrap", "보관 접근 검사");
  const configVersionId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "custom_tab" });
  await publishClubConfig("teacher_bootstrap", configVersionId, "보관 접근 검사");
  const teamId = await createClubTeam("teacher_bootstrap", clubId, "보관팀");
  const { studentId } = await enrollClubStudent("teacher_bootstrap", clubId, "10901", "");
  await assignClubStudent("teacher_bootstrap", clubId, studentId, teamId);
  const { id: sessionId } = (await db.query("SELECT id FROM inquiry_sessions WHERE team_id = $1", [teamId])).rows[0];
  const before = await getCustomTabResponse(studentId, sessionId, configVersionId);
  await db.query("UPDATE teams SET status = 'archived' WHERE id = $1", [teamId]);
  await expect(getCustomTabResponse(studentId, sessionId, configVersionId)).rejects.toThrow("접근할 수 없습니다");
  await expect(saveCustomTabResponse(studentId, { sessionId, configVersionId, responseData: {}, submit: false })).rejects.toThrow("접근할 수 없습니다");
  await db.query("UPDATE teams SET status = 'active' WHERE id = $1", [teamId]);
  expect(await getCustomTabResponse(studentId, sessionId, configVersionId)).toEqual(before);
});

it.each(["inactive", "password-reset", "old-student", "old-club", "teacher"])("rejects custom-tab access after %s while preserving existing responses", async change => {
  const db = await getDb();
  const title = `합성 권한 ${change}`;
  const clubId = await createClub("teacher_bootstrap", title);
  const configVersionId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "custom_tab" });
  await publishClubConfig("teacher_bootstrap", configVersionId, title);
  const teamId = await createClubTeam("teacher_bootstrap", clubId, "합성 권한 팀");
  const { studentId } = await enrollClubStudent("teacher_bootstrap", clubId, "10901", "");
  await assignClubStudent("teacher_bootstrap", clubId, studentId, teamId);
  await db.query("UPDATE users SET must_change_password=FALSE WHERE id=$1", [studentId]);
  const { id: sessionId } = (await db.query("SELECT id FROM inquiry_sessions WHERE team_id=$1", [teamId])).rows[0];
  await saveCustomTabResponse(studentId, { sessionId, configVersionId, responseData: {}, submit: false, expectedVersion: null });
  const original = (await db.query("SELECT * FROM club_custom_responses WHERE session_id=$1", [sessionId])).rows;
  const members = (await db.query("SELECT * FROM team_members WHERE team_id=$1", [teamId])).rows;
  try {
    if (change === "inactive") await db.query("UPDATE users SET status='inactive' WHERE id=$1", [studentId]);
    if (change === "password-reset") await db.query("UPDATE users SET must_change_password=TRUE WHERE id=$1", [studentId]);
    if (change === "old-student") await db.query("UPDATE users SET academic_year=$2 WHERE id=$1", [studentId, ACADEMIC_YEAR - 1]);
    if (change === "old-club") await db.query("UPDATE clubs SET academic_year=$2 WHERE id=$1", [clubId, ACADEMIC_YEAR - 1]);
    if (change === "teacher") await db.query("UPDATE users SET role='teacher' WHERE id=$1", [studentId]);
    await expect(getCustomTabResponse(studentId, sessionId, configVersionId)).rejects.toThrow("접근할 수 없습니다");
    await expect(saveCustomTabResponse(studentId, { sessionId, configVersionId, responseData: {}, submit: false, expectedVersion: 1 })).rejects.toThrow("접근할 수 없습니다");
    expect((await db.query("SELECT * FROM club_custom_responses WHERE session_id=$1", [sessionId])).rows).toEqual(original);
    expect((await db.query("SELECT * FROM team_members WHERE team_id=$1", [teamId])).rows).toEqual(members);
  } finally {
    await db.query("UPDATE users SET status='active',role='student',must_change_password=FALSE,academic_year=$2 WHERE id=$1", [studentId, ACADEMIC_YEAR]);
    await db.query("UPDATE clubs SET academic_year=$2 WHERE id=$1", [clubId, ACADEMIC_YEAR]);
  }
});
