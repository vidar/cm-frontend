// Shared helper for integration tests: is the local games database reachable?
import postgres from 'postgres';
import { env } from 'cloudflare:workers';

let available: boolean | null = null;
export async function dbAvailable() {
  if (available !== null) return available;
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, connect_timeout: 3, fetch_types: false });
  try {
    await sql`SELECT 1`;
    available = true;
  } catch {
    available = false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  return available;
}
