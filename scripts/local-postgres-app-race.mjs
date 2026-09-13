import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
export async function runAppBootstrapRace(config, database, expectedError = null) {
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "NODE_OPTIONS"]) env[key] = "";
  env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}`;
  env.NODE_ENV = "test"; env.BOOTSTRAP_TEACHER_LOGIN = "teacher"; env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-bootstrap-race-only";
  const children = [], ready = [], results = [], timers = [];
  try {
    for (let i = 0; i < 3; i++) {
      const child = fork(fileURLToPath(new URL("local-postgres-app-worker.mjs", import.meta.url)), [], { env, execArgv: ["--experimental-transform-types", "--import", new URL("local-ts-loader.mjs", import.meta.url).href], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
      children.push(child);
      let markReady, failReady, complete, fail;
      ready.push(new Promise((resolve, reject) => { markReady = resolve; failReady = reject; }));
      results.push(new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
      child.on("message", message => {
        if (message.ready) markReady();
        else if (message.result) complete(message.result);
        else if (message.error) {
          if (expectedError && message.error === expectedError) { complete({ error: message.error }); return; }
          const error = new Error(`App worker failed: ${message.error}`); failReady(error); fail(error);
        }
      });
      child.on("error", error => { failReady(error); fail(error); });
      child.on("exit", code => { if (code) { const error = new Error(`App worker exited: ${code}`); failReady(error); fail(error); } });
      timers.push(setTimeout(() => { const error = new Error("App worker timed out"); failReady(error); fail(error); }, 45000));
    }
    // Attach result handlers before any worker can reject its result.
    const allResults = Promise.all(results); allResults.catch(() => undefined);
    await Promise.all(ready);
    for (const child of children) child.send("go");
    const values = await allResults;
    for (const value of values) assert.deepEqual(value, expectedError ? { error: expectedError } : { classes: 9, users: 4, teams: 1, migrations: 7 });
    return values;
  } finally { timers.forEach(clearTimeout); for (const child of children) if (child.exitCode == null) child.kill(); }
}
