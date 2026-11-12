// Shared helpers for the integration tests (*-db.test.ts) against a local Postgres database (the stub's
// HYPERDRIVE connection string: TEST_DATABASE_URL, else cm_games_test on localhost).
//
// Without TEST_DATABASE_URL the suites skip themselves when the default database isn't there. Once
// TEST_DATABASE_URL is set (or CI is), a database that can't be reached or has no schema fails the run: a
// typo in the URL must not look like a green run that tested nothing.
import postgres from 'postgres';
import { env } from 'cloudflare:workers';

const explicit = Boolean(process.env.TEST_DATABASE_URL) || Boolean(process.env.CI);
/** The database `wrangler dev` reads (wrangler.jsonc localConnectionString), and production's name. */
const SITE_DATABASE = 'cm_games';

/** The connection string without its password, for messages. */
function where(url: string) {
  try {
    const u = new URL(url);
    u.password = '';
    return u.toString();
  } catch {
    return 'TEST_DATABASE_URL';
  }
}

/** Says why tests skip. (console output of a file whose tests all skip is not shown by vitest's reporter.) */
export function notice(message: string) {
  process.stderr.write(`${message}\n`);
}

let checked: Promise<string | null> | null = null;
/** Name of the test database, or null when the default one isn't reachable (then the suites skip). */
function database() {
  checked ??= (async () => {
    const url = env.HYPERDRIVE.connectionString;
    const sql = postgres(url, { max: 1, connect_timeout: 3, fetch_types: false, onnotice: () => {} });
    let name: string;
    let schema: boolean;
    try {
      [{ name, schema }] = await sql<{ name: string; schema: boolean }[]>`SELECT current_database() AS name, to_regclass('public.games') IS NOT NULL AS schema`;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (explicit) throw new Error(`The test database ${where(url)} cannot be reached: ${reason}`, { cause: e });
      notice(`Skipping the database tests: ${where(url)} is not reachable (${reason}). Set TEST_DATABASE_URL to run them.`);
      return null;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
    if (!schema) {
      throw new Error(
        `The test database ${where(url)} has no games table: apply scripts/twic/schema.pg.sql, indexes.pg.sql and scripts/*.pg.sql (as .github/workflows/test.yml does), or copy a games database.`,
      );
    }
    return name;
  })();
  return checked;
}

/** Is the test database there? (Throws instead when TEST_DATABASE_URL was given but doesn't work.) */
export async function dbAvailable() {
  return (await database()) !== null;
}

/**
 * For suites that write: as dbAvailable(), but refuses the site's own database, cm_games. The upload tests
 * republish every approved upload and delete orphaned analyses, and the analysis tests count every row of the day,
 * so they need a copy (createdb -T cm_games cm_games_test).
 */
export async function writableDbAvailable() {
  const name = await database();
  if (name === SITE_DATABASE) {
    throw new Error(
      `Refusing to run the writing database tests on ${SITE_DATABASE}, the database the local site reads: point TEST_DATABASE_URL at a copy (createdb -T cm_games cm_games_test).`,
    );
  }
  return name !== null;
}

/** The value of one key of the `meta` table (null when it has none): tells which data set the database holds. */
export async function metaValue(key: string) {
  if (!(await dbAvailable())) return null;
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, connect_timeout: 3, fetch_types: false });
  try {
    const rows = await sql<{ value: string }[]>`SELECT value FROM meta WHERE key = ${key}`;
    return rows[0]?.value ?? null;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
