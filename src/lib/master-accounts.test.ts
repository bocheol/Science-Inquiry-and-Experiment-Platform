import { describe, expect, it } from "vitest";
import { authenticate } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  assertMasterActor,
  changeManagedAccountStatus,
  createManagedAccount,
  getMasterAccountData,
  resetManagedAccountPassword,
} from "@/lib/master-accounts";

describe("master account management", () => {
  it("grants master authority only to teacher2 and manages accounts without deleting them", async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password, is_master)
       VALUES ('master_test_teacher2', '마스터시험', 'teacher2', 2026, 'teacher', 'unused', FALSE, TRUE)
       ON CONFLICT (academic_year, login_id) DO UPDATE SET is_master = TRUE, must_change_password = FALSE`,
    );
    const master = await db.query<{ id: string }>("SELECT id FROM users WHERE academic_year = 2026 AND login_id = 'teacher2'");
    const masterId = master.rows[0]!.id;
    await expect(assertMasterActor("teacher_bootstrap")).rejects.toThrow("마스터");
    await expect(assertMasterActor(masterId)).resolves.toBeUndefined();

    const teacherCredential = await createManagedAccount(masterId, { kind: "teacher", name: "추가교사", loginId: "teacher-master-test" });
    const demoCredential = await createManagedAccount(masterId, { kind: "demo", name: "체험학생", loginId: "demo-master-test" });
    expect(await authenticate(teacherCredential.loginId, teacherCredential.temporaryPassword)).toBeTruthy();
    expect(await authenticate(demoCredential.loginId, demoCredential.temporaryPassword)).toBeTruthy();

    const data = await getMasterAccountData(masterId);
    const demo = data.demoStudents.find((account) => account.loginId === demoCredential.loginId)!;
    expect(demo.accountType).toBe("demo");
    await changeManagedAccountStatus(masterId, demo.id, "deactivate");
    expect(await authenticate(demoCredential.loginId, demoCredential.temporaryPassword)).toBeNull();
    await changeManagedAccountStatus(masterId, demo.id, "restore");
    const reset = await resetManagedAccountPassword(masterId, demo.id);
    expect(await authenticate(reset.loginId, reset.temporaryPassword)).toBe(demo.id);
    const preserved = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users WHERE id = $1", [demo.id]);
    expect(preserved.rows[0]?.count).toBe("1");
  });

  it("requires the demo prefix", async () => {
    const db = await getDb();
    const master = await db.query<{ id: string }>("SELECT id FROM users WHERE login_id = 'teacher2'");
    await expect(createManagedAccount(master.rows[0]!.id, { kind: "demo", name: "잘못된체험", loginId: "student-demo" })).rejects.toThrow("demo-");
  });
});
