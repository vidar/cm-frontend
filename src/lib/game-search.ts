// Game search (/games/search/): white, black (or either colour), result, event, opening or ECO,
// dates, minimum rating, length, sorting. Names, events and openings are resolved to ids with small
// indexed lookups first; the games query then uses the games_* indexes (see scripts/twic/indexes.pg.sql).
// Only import from on-demand routes.
import { GAME_COLS, GAME_JOINS, PAGE_SIZE, query, slugify, type GameRow, type Player } from './games';

export const SORTS = { newest: 'Newest first', oldest: 'Oldest first', rating: 'Highest rated', shortest: 'Shortest' } as const;
export const RESULTS = { '': 'Any result', '1-0': 'White won (1–0)', '1/2-1/2': 'Draw (½–½)', '0-1': 'Black won (0–1)', decisive: 'Decisive' } as const;
type Sort = keyof typeof SORTS;
type Result = keyof typeof RESULTS;

export interface SearchParams {
  white: string;
  black: string;
  anyColour: boolean;
  result: Result;
  event: string;
  opening: string;
  from: string;
  to: string;
  minRating: number | null;
  minMoves: number | null;
  maxMoves: number | null;
  sort: Sort;
  page: number;
}

const int = (v: string | null, lo: number, hi: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
/** "2016", "2016-05", "2016-05-03" (dots or slashes accepted) or "" */
const date = (v: string | null) => {
  const m = /^(\d{4})(?:[-./](\d{1,2}))?(?:[-./](\d{1,2}))?$/.exec((v ?? '').trim());
  if (!m) return '';
  return [m[1], m[2]?.padStart(2, '0'), m[3]?.padStart(2, '0')].filter(Boolean).join('-');
};

export function parseSearch(q: URLSearchParams): SearchParams {
  const s = (k: string, n = 80) => (q.get(k) ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const result = s('result') as Result;
  const sort = s('sort') as Sort;
  return {
    white: s('white'),
    black: s('black'),
    anyColour: q.get('any') === '1',
    result: result in RESULTS ? result : '',
    event: s('event'),
    opening: s('opening'),
    from: date(q.get('from')),
    to: date(q.get('to')),
    minRating: int(q.get('rating'), 1000, 3000),
    minMoves: int(q.get('minmoves'), 1, 500),
    maxMoves: int(q.get('maxmoves'), 1, 500),
    sort: sort in SORTS ? sort : 'newest',
    page: int(q.get('page'), 1, 200) ?? 1,
  };
}

export const hasFilters = (p: SearchParams) =>
  !!(p.white || p.black || p.result || p.event || p.opening || p.from || p.to || p.minRating || p.minMoves || p.maxMoves);

/** URL of these search params (optionally changed), without empty fields. */
export function searchUrl(p: SearchParams, change: Partial<SearchParams> = {}) {
  const v = { ...p, ...change };
  const q = new URLSearchParams();
  const set = (k: string, x: string | number | null | boolean) => {
    if (x !== '' && x !== null && x !== false) q.set(k, x === true ? '1' : String(x));
  };
  set('white', v.white);
  set('black', v.black);
  set('any', v.anyColour);
  set('result', v.result);
  set('event', v.event);
  set('opening', v.opening);
  set('from', v.from);
  set('to', v.to);
  set('rating', v.minRating);
  set('minmoves', v.minMoves);
  set('maxmoves', v.maxMoves);
  if (v.sort !== 'newest') set('sort', v.sort);
  if (v.page > 1) set('page', v.page);
  const s = q.toString();
  return `/games/search/${s ? `?${s}` : ''}`;
}

const intArray = (ids: number[]) => `{${ids.join(',')}}`;
const textArray = (xs: string[]) => `{${xs.map((x) => `"${x.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

/** Players matching a name: exact matches if any, else the most active substring matches. */
async function resolvePlayers(name: string) {
  const term = slugify(name).replace(/-/g, ' ');
  if (term.length < 2) return [];
  const rows = await query<Pick<Player, 'id' | 'name' | 'slug' | 'games' | 'title'> & { exact: boolean }>(
    `SELECT id, name, slug, games, title, search = $1 AS exact FROM players WHERE search LIKE $2 ORDER BY (search = $1) DESC, games DESC LIMIT 30`,
    [term, `%${term}%`],
  );
  const exact = rows.filter((r) => r.exact);
  return exact.length ? exact : rows;
}

export interface SearchResult {
  games: GameRow[];
  hasMore: boolean;
  white: Awaited<ReturnType<typeof resolvePlayers>>;
  black: Awaited<ReturnType<typeof resolvePlayers>>;
  events: number | null;
  openings: number | null;
  /** Why nothing could match (a name, event or opening that doesn't exist). */
  empty?: string;
}

export async function searchGames(p: SearchParams): Promise<SearchResult> {
  const eco = /^([A-E]\d{2})(?:\s*-\s*([A-E]\d{2}))?$/i.exec(p.opening);
  const [white, black, eventIds, openingSlugs] = await Promise.all([
    p.white ? resolvePlayers(p.white) : null,
    p.black ? resolvePlayers(p.black) : null,
    p.event
      ? query<{ id: number }>('SELECT id FROM events WHERE lower(name) LIKE $1 ORDER BY start_date DESC NULLS LAST LIMIT 2000', [`%${p.event.toLowerCase()}%`]).then((r) => r.map((x) => x.id))
      : null,
    p.opening && !eco
      ? query<{ slug: string }>('SELECT slug FROM openings WHERE lower(name) LIKE $1 LIMIT 2000', [`%${p.opening.toLowerCase()}%`]).then((r) => r.map((x) => x.slug))
      : null,
  ]);
  const base = { white: white ?? [], black: black ?? [], events: eventIds?.length ?? null, openings: openingSlugs?.length ?? null };
  const none = (why: string): SearchResult => ({ ...base, games: [], hasMore: false, empty: why });
  if (white && !white.length) return none(`No player matches “${p.white}”.`);
  if (black && !black.length) return none(`No player matches “${p.black}”.`);
  if (eventIds && !eventIds.length) return none(`No event matches “${p.event}”.`);
  if (openingSlugs && !openingSlugs.length) return none(`No opening matches “${p.opening}”. Try a name like “Najdorf” or an ECO code like B90.`);

  const where: string[] = [];
  const params: (string | number)[] = [];
  const arg = (v: string | number) => {
    params.push(v);
    return `$${params.length}`;
  };
  const W = white && arg(intArray(white.map((x) => x.id)));
  const B = black && arg(intArray(black.map((x) => x.id)));
  if (W && B)
    where.push(p.anyColour ? `((g.white_id = ANY(${W}::int[]) AND g.black_id = ANY(${B}::int[])) OR (g.white_id = ANY(${B}::int[]) AND g.black_id = ANY(${W}::int[])))` : `g.white_id = ANY(${W}::int[]) AND g.black_id = ANY(${B}::int[])`);
  else if (W) where.push(p.anyColour ? `(g.white_id = ANY(${W}::int[]) OR g.black_id = ANY(${W}::int[]))` : `g.white_id = ANY(${W}::int[])`);
  else if (B) where.push(p.anyColour ? `(g.white_id = ANY(${B}::int[]) OR g.black_id = ANY(${B}::int[]))` : `g.black_id = ANY(${B}::int[])`);
  if (p.result === 'decisive') where.push(`g.result <> '1/2-1/2'`);
  else if (p.result) where.push(`g.result = ${arg(p.result)}`);
  if (eventIds) where.push(`g.event_id = ANY(${arg(intArray(eventIds))}::int[])`);
  if (openingSlugs) where.push(`g.opening = ANY(${arg(textArray(openingSlugs))}::text[])`);
  if (eco) where.push(`g.eco BETWEEN ${arg(eco[1].toUpperCase())} AND ${arg((eco[2] ?? eco[1]).toUpperCase())}`);
  // Dates are text ('YYYY', 'YYYY-MM' or 'YYYY-MM-DD'); '~' sorts after digits and '-', so
  // "<= '2016~'" includes every date in 2016.
  if (p.from) where.push(`g.date >= ${arg(p.from)}`);
  if (p.to) where.push(`g.date <= ${arg(`${p.to}~`)}`);
  if (p.minRating) where.push(`g.white_elo >= ${arg(p.minRating)} AND g.black_elo >= ${arg(p.minRating)}`);
  if (p.minRating) where.push(`g.elo_avg >= ${arg(p.minRating)}`); // lets the planner use games_elo
  if (p.minMoves) where.push(`g.plies >= ${arg(p.minMoves * 2 - 1)}`);
  if (p.maxMoves) where.push(`g.plies <= ${arg(p.maxMoves * 2)}`);

  const order = {
    newest: 'g.date DESC NULLS LAST, g.id DESC',
    oldest: 'g.date ASC NULLS LAST, g.id ASC',
    rating: 'g.elo_avg DESC NULLS LAST, g.id DESC',
    shortest: 'g.plies ASC, g.id ASC',
  }[p.sort];
  const rows = await query<GameRow>(
    `SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${order} LIMIT ${arg(PAGE_SIZE + 1)} OFFSET ${arg((p.page - 1) * PAGE_SIZE)}`,
    params,
  );
  return { ...base, games: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

/** Player name suggestions for the search form (most games first). */
export async function suggestPlayers(q: string, limit = 8) {
  const term = slugify(q).replace(/-/g, ' ');
  if (term.length < 3) return [];
  return query<{ name: string; title: string | null; fed: string | null; games: number }>(
    'SELECT name, title, fed, games FROM players WHERE search LIKE $1 ORDER BY games DESC LIMIT $2',
    [`%${term}%`, limit],
  );
}
