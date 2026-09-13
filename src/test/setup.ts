// Test workers must never inherit live database or external-service credentials.
// Assign directly: vi.unstubAllEnvs() in individual tests must restore these safe defaults.
for (const key of ["DATABASE_URL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
  process.env[key] = "";
}
process.env.SESSION_SECRET = "synthetic-test-session-only";
process.env.BOOTSTRAP_TEACHER_LOGIN = "teacher";
process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-test-teacher-only";
