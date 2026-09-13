// Parent passes only a local synthetic connection and clears external credentials.
import assert from "node:assert/strict";
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55416");
assert.match(target.pathname, /^\/codex_validation_bootstrap_[0-9]+_[a-f0-9]+$/);
try {
  const { getDb } = await import("../src/lib/db/index.ts");
  process.once("message", async message => {
    if (message !== "go") return;
    let pool;
    try {
      pool = await getDb();
      const count = async table => Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
      const result = { classes: await count("classes"), users: await count("users"), teams: await count("teams"), migrations: await count("schema_migrations") };
      process.send({ result });
    } catch (error) { process.send({ error: error.code ?? error.name }); }
    finally { await pool?.end(); process.disconnect(); }
  });
  process.send({ ready: true });
} catch (error) { process.send({ error: error.code ?? error.name }); process.disconnect(); }
