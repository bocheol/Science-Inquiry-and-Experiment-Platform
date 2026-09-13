import type { Pool } from "pg";

// Separate from the migration lock: migration code obtains its own connection.
// Hold this through schema creation, migrations and seeding across app instances.
export async function withDatabaseBootstrapLock<T>(pool: Pool, operation: () => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL && !process.env.INSTANCE_UNIX_SOCKET) return operation();
  const client = await pool.connect();
  const key = "4934051600002";
  let locked = false;
  let discard = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
    locked = true;
    return await operation();
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]); }
      catch { discard = true; }
    } else { discard = true; }
    client.release(discard);
  }
}
