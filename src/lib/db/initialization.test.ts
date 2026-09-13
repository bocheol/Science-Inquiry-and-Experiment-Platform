import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), migrate: vi.fn().mockResolvedValue(undefined), compatibility: vi.fn().mockResolvedValue(undefined) }));
vi.mock("pg", () => ({ Pool: class { constructor() { return mocks.create(); } } }));
vi.mock("@/lib/db/migrations", () => ({ runDatabaseMigrations: mocks.migrate, assertDatabaseCompatibility: mocks.compatibility }));
import { getDb } from "@/lib/db";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const state = globalThis as typeof globalThis & { __sciencePool?: unknown; __scienceDbReady?: unknown };
  delete state.__sciencePool;
  delete state.__scienceDbReady;
});

it("stops before schema or seed writes and releases the pool when compatibility fails", async () => {
  vi.stubEnv("INSTANCE_UNIX_SOCKET", "");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/test");
  const release = vi.fn(), lockQuery = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { connect: vi.fn().mockResolvedValue({ query: lockQuery, release }), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
  mocks.create.mockReturnValueOnce(pool);
  mocks.compatibility.mockRejectedValueOnce(new Error("지원하지 않는 DB"));
  await expect(getDb()).rejects.toThrow("지원하지 않는 DB");
  expect(pool.query).not.toHaveBeenCalled();
  expect(mocks.migrate).not.toHaveBeenCalled();
  expect(lockQuery.mock.calls.map(call => call[0])).toEqual([
    "SELECT pg_advisory_lock($1::bigint)", "SELECT pg_advisory_unlock($1::bigint)",
  ]);
  expect(release).toHaveBeenCalledWith(false);
  expect(pool.end).toHaveBeenCalledOnce();
});

it("closes a failed initialization and retries on the next request without duplicating pools", async () => {
  vi.stubEnv("INSTANCE_UNIX_SOCKET", "");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic.invalid/test");
  const release = vi.fn();
  const lockQuery = vi.fn().mockResolvedValue({ rows: [{ count: "1" }] });
  const failed = { connect: vi.fn().mockRejectedValue(new Error("temporary connection failure")), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
  const healthy = { connect: vi.fn().mockResolvedValue({ query: lockQuery, release }), query: vi.fn().mockResolvedValue({ rows: [{ count: "1" }] }), end: vi.fn().mockResolvedValue(undefined) };
  mocks.create.mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
  const first = await Promise.allSettled([getDb(), getDb()]);
  expect(first.map((item) => item.status)).toEqual(["rejected", "rejected"]);
  expect(failed.end).toHaveBeenCalledOnce();
  const recovered = await Promise.all([getDb(), getDb()]);
  expect(recovered).toEqual([healthy, healthy]);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.migrate).toHaveBeenCalledOnce();
  expect(lockQuery.mock.calls.map(call => call[0])).toEqual([
    "SELECT pg_advisory_lock($1::bigint)", "BEGIN", "SELECT COUNT(*)::text AS count FROM users", "COMMIT", "SELECT pg_advisory_unlock($1::bigint)",
  ]);
  expect(release).toHaveBeenCalledWith(false);
});
