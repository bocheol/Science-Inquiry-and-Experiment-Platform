import { expect, it, vi } from "vitest";
vi.mock("@/lib/auth", async (original) => ({ ...await original<typeof import("@/lib/auth")>(), getCurrentUser: async () => ({ id: "teacher_bootstrap", role: "teacher", mustChangePassword: false }) }));
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { updatePassword } from "@/lib/auth";
import { assertMasterActor, changeManagedAccountStatus, resetManagedAccountPassword } from "@/lib/master-accounts";
import { POST } from "@/app/api/teacher/password-reset/route";

it.each(["student_reset", "direct_reset", "teacher_reset", "demo_reset", "teacher_deactivate", "teacher_restore", "demo_deactivate", "demo_restore"].flatMap(operation => [false, true].map(old => ({ operation, old }))))(
  "$operation oldYear=$old preserves historical accounts", async ({ operation, old }) => {
    const db = await getDb(), key = `account_year_${operation}_${old}`, master = `${key}_master`;
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 관리자',$1,$2,'teacher','unused',FALSE,TRUE)", [master, ACADEMIC_YEAR]);
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,account_type,status) VALUES($1,'합성 계정',$1,$2,$3,'unused',FALSE,$4,$5)", [key, ACADEMIC_YEAR - Number(old), operation.startsWith("teacher") ? "teacher" : "student", operation.startsWith("demo") ? "demo" : "standard", operation.endsWith("restore") ? "inactive" : "active"]);
    const read = async () => (await db.query("SELECT * FROM users WHERE id=$1", [key])).rows[0];
    const before = await read();
    const run = async () => {
      if (operation === "student_reset") {
        const response = await POST(new Request("http://localhost/api/teacher/password-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId: key }) }));
        expect(response.status).toBe(old ? 404 : 200);
      } else {
        const work = operation === "direct_reset" ? updatePassword(key, "synthetic-reset-only", true)
          : operation.endsWith("reset") ? resetManagedAccountPassword(master, key)
          : changeManagedAccountStatus(master, key, operation.endsWith("deactivate") ? "deactivate" : "restore");
        if (old) await expect(work).rejects.toThrow();
        else await work;
      }
    };
    await run();
    const after = await read();
    if (old) expect(after).toEqual(before);
    else if (operation.endsWith("reset")) {
      expect(after.password_hash === before.password_hash).toBe(false);
      expect(after.must_change_password).toBe(true);
      expect(after.session_version).toBe(before.session_version + 1);
    } else {
      expect(after.status).toBe(operation.endsWith("restore") ? "active" : "inactive");
      expect(after.session_version).toBe(before.session_version + Number(operation.endsWith("deactivate")));
    }
  },
);

it("rejects a historical master and preserves historical memberships during current demo deactivation", async () => {
  const db = await getDb();
  for (const old of [false, true]) {
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 관리자',$1,$2,'teacher','unused',FALSE,TRUE)", [`history_master_${old}`, ACADEMIC_YEAR - Number(old)]);
  }
  await expect(assertMasterActor("history_master_true")).rejects.toThrow();
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,account_type) VALUES('history_demo','합성 체험','history_demo',$1,'student','unused',FALSE,'demo')", [ACADEMIC_YEAR]);
  for (const old of [false, true]) for (const club of [false, true]) {
    const id = `history_${old}_${club}`, year = ACADEMIC_YEAR - Number(old);
    if (club) {
      await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 동아리','teacher_bootstrap')", [id, year]);
      await db.query("INSERT INTO club_members(club_id,user_id) VALUES($1,'history_demo')", [id]);
    } else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,171,'합성 학급')", [id, year]);
    await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name,leader_user_id) VALUES($1,$2,$3,1,'합성 팀','history_demo')", [id, club ? null : id, club ? id : null]);
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,'history_demo')", [id]);
  }
  const history = async () => ({ teams: (await db.query("SELECT * FROM teams WHERE id LIKE 'history_true_%' ORDER BY id")).rows, members: (await db.query("SELECT * FROM team_members WHERE id LIKE 'history_true_%' ORDER BY id")).rows, clubs: (await db.query("SELECT * FROM club_members WHERE club_id LIKE 'history_true_%' ORDER BY club_id")).rows });
  const before = await history();
  await changeManagedAccountStatus("history_master_false", "history_demo", "deactivate");
  expect(await history()).toEqual(before);
  expect((await db.query("SELECT status FROM team_members WHERE id LIKE 'history_false_%'")).rows.map(row => row.status)).toEqual(["inactive", "inactive"]);
  expect((await db.query("SELECT leader_user_id FROM teams WHERE id LIKE 'history_false_%'")).rows.every(row => row.leader_user_id === null)).toBe(true);
  expect((await db.query("SELECT status FROM club_members WHERE club_id='history_false_true'")).rows[0].status).toBe("inactive");
});
