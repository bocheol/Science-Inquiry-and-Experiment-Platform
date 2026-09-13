// Executed only by cloud-dev.mjs in a fresh process with sanitized credentials.
import assert from "node:assert/strict";
import { validateDevelopmentDatabase } from "./cloud-dev.mjs";
validateDevelopmentDatabase(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, "development");
assert.equal(process.env.INSTANCE_UNIX_SOCKET, "");
const { getDb } = await import("../src/lib/db/index.ts");
const db = await getDb();
try {
  const { rows: [identity] } = await db.query("SELECT current_database() AS name, current_user AS actor");
  assert.equal(identity.name, "science_dev");
  assert.equal(identity.actor, "science_dev");
  // The production schema's teacher2 promotion runs before initial seed creation.
  // Make the newly seeded synthetic teacher usable on the first development start.
  await db.query("UPDATE users SET is_master = TRUE WHERE id = 'teacher_bootstrap' AND login_id = 'teacher2' AND role = 'teacher'");
  const { rows: [state] } = await db.query("SELECT (SELECT COUNT(*)::int FROM schema_migrations) AS migrations, (SELECT COUNT(*)::int FROM users) AS users");
  console.log(`개발 초기화 완료: 마이그레이션 ${state.migrations}개, 개발 계정 ${state.users}개.`);
} finally { await db.end(); }
