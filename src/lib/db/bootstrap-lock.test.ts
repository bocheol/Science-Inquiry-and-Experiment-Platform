import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withDatabaseBootstrapLock } from "@/lib/db/bootstrap-lock";
afterEach(() => vi.unstubAllEnvs());
it("releases the bootstrap lock when schema or seed work fails", async () => {
  vi.stubEnv("DATABASE_URL", "local-test-marker");
  const query = vi.fn().mockResolvedValue({ rows: [] }), release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
  await expect(withDatabaseBootstrapLock(pool, async () => { throw new Error("synthetic schema failure"); })).rejects.toThrow("synthetic schema failure");
  expect(query.mock.calls.map(call => call[0])).toEqual(["SELECT pg_advisory_lock($1::bigint)", "SELECT pg_advisory_unlock($1::bigint)"]);
  expect(release).toHaveBeenCalledWith(false);
});
it("discards a connection when lock release fails rather than returning a possibly locked connection to the pool", async () => {
  vi.stubEnv("DATABASE_URL", "local-test-marker");
  const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("synthetic disconnect")), release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
  expect(await withDatabaseBootstrapLock(pool, async () => "finished")).toBe("finished");
  expect(release).toHaveBeenCalledWith(true);
});
