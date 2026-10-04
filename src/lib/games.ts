// Server-side access to the TWIC games database (Neon Postgres through the Hyperdrive binding
// `HYPERDRIVE`, see scripts/twic/). Only import from on-demand routes (`export const prerender = false`).
import { env } from 'cloudflare:workers';
import postgres from 'postgres';

export interface Player {
  id: number;
  fide_id: number | null;
  name: string;
  slug: string;
  title: string | null;
  fed: string | null;
  born: number | null;
  max_elo: number | null;
  games: number;
  last_date: string | null;
}

export interface EventRow {
  id: number;
  name: string;
  site: string | null;
  slug: string;
  start_date: string | null;
  end_date: string | null;
  games: number;
  twic: number | null;
}

export interface GameRow {
  id: number;
  event_id: number;
  white_id: number;
  black_id: number;
  white_elo: number | null;
  black_elo: number | null;
  white_title: string | null;
  black_title: string | null;
  elo_avg: number | null;
  result: string;
  date: string | null;
  round: string | null;
  eco: string | null;
  opening: string | null;
  plies: number;
  twic: number;
  white_name: string;
  white_slug: string;
  black_name: string;
  black_slug: string;
  event_name: string;
  event_slug: string;
}

/** Game row with moves (for the game page). */
export interface FullGame extends GameRow {
  moves: string;
  event_site: string | null;
}

type Param = string | number | null;

/**
 * Run one query. Workers can't share connections between requests, so each query opens its own
 * (cheap: Hyperdrive keeps the pool to Neon warm next to the Worker) and closes it afterwards.
 */
export async function query<T>(text: string, params: Param[] = []): Promise<T[]> {
  const sql = postgres((env as { HYPERDRIVE: Hyperdrive }).HYPERDRIVE.connectionString, { max: 1, fetch_types: false });
  try {
    return (await sql.unsafe(text, params)) as unknown as T[];
  } finally {
    sql.end().catch(() => {});
  }
}
const first = async <T>(text: string, params: Param[] = []) => (await query<T>(text, params))[0] ?? null;

/** Totals from the `meta` table ('games', 'players', 'events', ...), as numbers. */
export async function getMeta() {
  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM meta');
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.value)])) as Record<string, number>;
}

export async function getOpeningName(slug: string) {
  return (await first<{ name: string }>('SELECT name FROM openings WHERE slug = $1', [slug]))?.name ?? null;
}

const GAME_COLS = `g.id, g.event_id, g.white_id, g.black_id, g.white_elo, g.black_elo, g.white_title, g.black_title,
  g.elo_avg, g.result, g.date, g.round, g.eco, g.opening, g.plies, g.twic,
  w.name AS white_name, w.slug AS white_slug, b.name AS black_name, b.slug AS black_slug, e.name AS event_name, e.slug AS event_slug`;
const GAME_JOINS = `JOIN players w ON w.id = g.white_id JOIN players b ON b.id = g.black_id JOIN events e ON e.id = g.event_id`;

export const PAGE_SIZE = 50;

export const twicIssueUrl = (n: number) => `https://theweekinchess.com/html/twic${n}.html`;

export function slugify(s: string) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const lastName = (name: string) => (name.includes(',') ? name.split(',')[0] : name.split(' ').slice(-1)[0]);

/** Canonical URL path of a game: /games/123-carlsen-vs-caruana-norway-chess-2024/ */
export function gamePath(g: Pick<GameRow, 'id' | 'white_name' | 'black_name' | 'event_name' | 'date'>) {
  const year = g.date?.slice(0, 4) ?? '';
  const slug = slugify(`${lastName(g.white_name)} vs ${lastName(g.black_name)} ${g.event_name} ${g.event_name.includes(year) ? '' : year}`).slice(0, 90).replace(/-$/, '');
  return `/games/${g.id}-${slug}/`;
}

export async function getGame(id: number): Promise<FullGame | null> {
  return first<FullGame>(`SELECT ${GAME_COLS}, g.moves, e.site AS event_site FROM games g ${GAME_JOINS} WHERE g.id = $1`, [id]);
}

export async function getPlayer(slug: string) {
  return first<Player>('SELECT * FROM players WHERE slug = $1', [slug]);
}

export async function getEvent(slug: string) {
  return first<EventRow>('SELECT * FROM events WHERE slug = $1', [slug]);
}

/** A player's games, newest first. `color`: 'w' | 'b' | undefined (both). */
export async function playerGames(playerId: number, page: number, color?: 'w' | 'b') {
  const where = color === 'w' ? 'g.white_id = $1' : color === 'b' ? 'g.black_id = $1' : null;
  // Two indexed queries merged, so both colours use an index.
  const sql = where
    ? `SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} WHERE ${where} ORDER BY g.date DESC NULLS LAST, g.id DESC LIMIT $2 OFFSET $3`
    : `SELECT * FROM (
         SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} WHERE g.white_id = $1
         UNION ALL
         SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} WHERE g.black_id = $1
       ) t ORDER BY date DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3`;
  const results = await query<GameRow>(sql, [playerId, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE]);
  return { games: results.slice(0, PAGE_SIZE), hasMore: results.length > PAGE_SIZE };
}

/** Score summary for a player: [wins, draws, losses] overall. */
export async function playerScore(playerId: number) {
  const row = await first<{ w: number; d: number; l: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE (white_id = $1 AND result = '1-0') OR (black_id = $1 AND result = '0-1'))::int AS w,
       COUNT(*) FILTER (WHERE result = '1/2-1/2')::int AS d,
       COUNT(*) FILTER (WHERE (white_id = $1 AND result = '0-1') OR (black_id = $1 AND result = '1-0'))::int AS l
     FROM (SELECT white_id, black_id, result FROM games WHERE white_id = $1
           UNION ALL SELECT white_id, black_id, result FROM games WHERE black_id = $1) t`,
    [playerId],
  );
  return row ?? { w: 0, d: 0, l: 0 };
}

export const EVENT_PAGE_SIZE = 200;

export async function eventGames(eventId: number, page = 1) {
  return query<GameRow>(`SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} WHERE g.event_id = $1 ORDER BY g.date, g.id LIMIT $2 OFFSET $3`, [
    eventId,
    EVENT_PAGE_SIZE,
    (page - 1) * EVENT_PAGE_SIZE,
  ]);
}

export async function searchPlayers(q: string, limit = 30) {
  const term = slugify(q).replace(/-/g, ' ');
  if (term.length < 2) return [];
  // Trigram index (players_search) makes the substring match fast.
  return query<Player>('SELECT * FROM players WHERE search LIKE $1 ORDER BY games DESC LIMIT $2', [`%${term}%`, limit]);
}

export async function topPlayers(limit = 60) {
  return query<Player>('SELECT * FROM players ORDER BY games DESC LIMIT $1', [limit]);
}

export async function recentEvents(limit = 40) {
  return query<EventRow>('SELECT * FROM events ORDER BY start_date DESC NULLS LAST LIMIT $1', [limit]);
}

/** Recent games between strong players. */
export async function recentTopGames(limit = 30) {
  return query<GameRow>(
    `SELECT ${GAME_COLS} FROM games g ${GAME_JOINS}
     WHERE g.id IN (SELECT id FROM games ORDER BY date DESC NULLS LAST LIMIT 3000) AND g.elo_avg >= 2600
     ORDER BY g.date DESC NULLS LAST, g.elo_avg DESC LIMIT $1`,
    [limit],
  );
}

/** Head-to-head games between two players, newest first. */
export async function headToHead(a: number, b: number, limit = 20) {
  return query<GameRow>(
    `SELECT ${GAME_COLS} FROM games g ${GAME_JOINS}
     WHERE (g.white_id = $1 AND g.black_id = $2) OR (g.white_id = $2 AND g.black_id = $1)
     ORDER BY g.date DESC NULLS LAST LIMIT $3`,
    [a, b, limit],
  );
}

/** Score from a player's perspective: "1", "½", "0". */
export function scoreFor(g: Pick<GameRow, 'result' | 'white_id'>, playerId: number) {
  if (g.result === '1/2-1/2') return '½';
  const whiteWon = g.result === '1-0';
  return (g.white_id === playerId) === whiteWon ? '1' : '0';
}

export const resultLabel = (r: string) => (r === '1/2-1/2' ? '½–½' : r.replace('-', '–'));
