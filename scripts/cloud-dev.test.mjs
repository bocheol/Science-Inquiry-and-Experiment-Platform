import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultDatabaseUrl, safeEnvironment, validateDevelopmentDatabase } from "./cloud-dev.mjs";

test("production credentials and env-file defaults cannot enter verification", () => {
  const env = safeEnvironment({ DATABASE_URL: "postgresql://production.invalid/data", INSTANCE_UNIX_SOCKET: "/cloudsql/production", OPENAI_API_KEY: "synthetic-secret", GOOGLE_CLOUD_PROJECT: "production", VAPID_PRIVATE_KEY: "synthetic", SCIENCE_DEV_OPENAI_API_KEY: "synthetic-ai", PGHOST: "production", PATH: "keep" }, { envKeys: ["GOOGLE_APPLICATION_CREDENTIALS", "NEXT_PUBLIC_SECRET", "CUSTOM_PRIVATE_VALUE"] });
  for (const key of ["DATABASE_URL", "INSTANCE_UNIX_SOCKET", "OPENAI_API_KEY", "GOOGLE_CLOUD_PROJECT", "VAPID_PRIVATE_KEY", "SCIENCE_DEV_OPENAI_API_KEY", "PGHOST", "GOOGLE_APPLICATION_CREDENTIALS", "NEXT_PUBLIC_SECRET", "CUSTOM_PRIVATE_VALUE"]) assert.equal(env[key], "", key);
  assert.equal(env.PATH, "keep");
});
test("only the disposable development database can be selected", () => {
  for (const value of ["postgresql://science_dev:science_dev_only@remote.invalid/science_dev", "postgresql://science_dev:science_dev_only@localhost/production", "postgresql://postgres:password@localhost/science_dev", `${defaultDatabaseUrl}?host=production.invalid`, "invalid"]) assert.throws(() => validateDevelopmentDatabase(value));
  assert.equal(validateDevelopmentDatabase(defaultDatabaseUrl), defaultDatabaseUrl);
});
test("Codespaces allows only this preview origin and explicit development AI", () => {
  const env = safeEnvironment({ CODESPACES: "true", CODESPACE_NAME: "example-space", SCIENCE_DEV_OPENAI_API_KEY: "synthetic-opt-in" }, { envKeys: [], databaseUrl: defaultDatabaseUrl, allowAi: true });
  assert.equal(env.SCIENCE_DEV_ALLOWED_ORIGIN, "example-space-3000.app.github.dev");
  assert.equal(env.OPENAI_API_KEY, "synthetic-opt-in");
  assert.equal(env.SCIENCE_DEV_OPENAI_API_KEY, "");
  assert.equal(env.GOOGLE_SERVICE_ACCOUNT_JSON, "");
});
