import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createClubConfigDraft } from "@/lib/club-settings";
import { ACADEMIC_YEAR } from "@/lib/constants";

it.each([false, true])("blocks past-year club changes for master=%s and keeps historical configuration", async master => {
  const db = await getDb(), key = `settings_year_${master}`;
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 설정 교사',$1,$2,'teacher','unused',FALSE,$3)", [key, ACADEMIC_YEAR, master]);
  await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 설정 동아리',$1)", [key, ACADEMIC_YEAR]);
  await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$1,$1)", [key]);
  await createClubConfigDraft(key, { clubId: key, configType: "plan" });
  const rows = (await db.query("SELECT * FROM club_config_versions WHERE club_id=$1", [key])).rows;
  await db.query("UPDATE users SET academic_year=$2 WHERE id=$1", [key, ACADEMIC_YEAR - 1]);
  await expect(createClubConfigDraft(key, { clubId: key, configType: "plan" })).rejects.toThrow();
  await db.query("UPDATE users SET academic_year=$2 WHERE id=$1", [key, ACADEMIC_YEAR]);
  await db.query("UPDATE clubs SET academic_year=$2 WHERE id=$1", [key, ACADEMIC_YEAR - 1]);
  await expect(createClubConfigDraft(key, { clubId: key, configType: "plan" })).rejects.toThrow();
  expect((await db.query("SELECT * FROM club_config_versions WHERE club_id=$1", [key])).rows).toEqual(rows);
});
