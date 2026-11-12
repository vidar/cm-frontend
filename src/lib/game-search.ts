// Game search (/games/search/): white, black (or either colour), result, event, opening or ECO,
// dates, minimum rating, length, sorting. One connection, at most two statements: a lookup of the typed
// players (and whether the event and opening names match anything), then the games query, which matches
// events and openings by name itself and uses the games_* indexes (see scripts/twic/indexes.pg.sql).
// Both run under a short statement timeout, so a search the indexes can't serve ends as "too broad".
// Only import from on-demand routes.
import { GAME_COLS, GAME_JOINS, nameMatch, nameWords, PAGE_SIZE, query, transaction, type GameRow, type Player, type Q } from './games';

export const SORTS = { newest: 'Newest first', oldest: 'Oldest first', rating: 'Highest rated', shortest: 'Shortest' } as const;
export const RESULTS = { '': 'Any result', '1-0': 'White won (1–0)', '1/2-1/2': 'Draw (½–½)', '0-1': 'Black won (0–1)', decisive: 'Decisive' } as const;
type Sort = keyof typeof SORTS;
type Result = keyof typeof RESULTS;

export interface SearchParams {
  white: string;
  black: string;
  /** Slug of one player with the typed name (`wp`, `bp`): tells namesakes apart. Ignored unless that player's name is exactly the typed one. */
  whitePin: string;
  blackPin: string;
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
const slug = (v: string | null) => (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v ?? '') && (v ?? '').length <= 120 ? (v as string) : '');

export function parseSearch(q: URLSearchParams): SearchParams {
  const s = (k: string, n = 80) => (q.get(k) ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const result = s('result') as Result;
  const sort = s('sort') as Sort;
  const white = s('white');
  const black = s('black');
  return {
    white,
    black,
    whitePin: white ? slug(q.get('wp')) : '',
    blackPin: black ? slug(q.get('bp')) : '',
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
  if (v.white) set('wp', v.whitePin);
  set('black', v.black);
  if (v.black) set('bp', v.blackPin);
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

/** An ECO code or range ("B90", "b90-b99"), low end first (a reversed "E99-A00" means A00 to E99); null for anything else. */
export function ecoRange(opening: string): [string, string] | null {
  const m = /^([A-E]\d{2})(?:\s*-\s*([A-E]\d{2}))?$/i.exec(opening);
  if (!m) return null;
  const a = m[1].toUpperCase();
  const b = (m[2] ?? m[1]).toUpperCase();
  return a <= b ? [a, b] : [b, a];
}

/** How long one search statement may run. The indexes answer ordinary searches in well under 100 ms. */
export const SEARCH_TIMEOUT = '3s';
export const TOO_BROAD = 'This search is too broad to finish quickly. Add a player, an event or a year, or sort by newest.';

const intArray = (ids: number[]) => `{${ids.join(',')}}`;

type Found = Pick<Player, 'id' | 'name' | 'slug' | 'games' | 'title' | 'fed'> & { exact: boolean; pinned: boolean };

/**
 * The players a typed name stands for: the pinned one if its name is exactly the typed one, else
 * every exact match (namesakes), else the most active players whose names contain all the words.
 */
export function pickPlayers(rows: Found[]): Found[] {
  const pinned = rows.find((r) => r.pinned && r.exact);
  if (pinned) return [pinned];
  const exact = rows.filter((r) => r.exact);
  return exact.length ? exact : rows;
}

export interface SearchResult {
  games: GameRow[];
  hasMore: boolean;
  white: Found[];
  black: Found[];
  /** Why nothing could match (a name, event or opening that doesn't exist, or a search that took too long). */
  empty?: string;
  /** The search hit the statement timeout (don't cache the answer for long). */
  tooBroad?: boolean;
}

/** A case-insensitive LIKE pattern for "contains", with % and _ in the text matched literally (backslash is the default escape). */
export const contains = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;

const isTimeout = (e: unknown) => (e as { code?: unknown } | null)?.code === '57014';

export async function searchGames(p: SearchParams, timeout = SEARCH_TIMEOUT): Promise<SearchResult> {
  const eco = ecoRange(p.opening);
  const whiteWords = p.white ? nameWords(p.white) : null;
  const blackWords = p.black ? nameWords(p.black) : null;
  const out: SearchResult = { games: [], hasMore: false, white: [], black: [] };
  const none = (why: string): SearchResult => ({ ...out, games: [], hasMore: false, empty: why });
  // A name too short to search (one letter, or only punctuation) matches nobody.
  if (whiteWords && whiteWords.join(' ').length < 2) return none(`No player matches “${p.white}”.`);
  if (blackWords && blackWords.join(' ').length < 2) return none(`No player matches “${p.black}”.`);

  try {
    return await transaction(async (q: Q) => {
      await q(`SET LOCAL statement_timeout = '${timeout.replace(/[^0-9a-z]/g, '')}'`);

      // 1. Lookups: the typed players (namesakes told apart by the pins) and whether the event and opening names match anything.
      if (whiteWords || blackWords || p.event || (p.opening && !eco)) {
        const params: (string | number)[] = [];
        const arg = (v: string | number) => {
          params.push(v);
          return `$${params.length}`;
        };
        const players = (words: string[] | null, pin: string) => {
          if (!words) return 'NULL::json';
          const m = nameMatch(words, arg);
          return `(SELECT json_agg(x ORDER BY x.exact DESC, x.pinned DESC, x.games DESC) FROM (
            SELECT id, name, slug, games, title, fed, ${m.exact()} AS exact, slug = ${arg(pin)} AS pinned FROM players WHERE ${m.where}
            ORDER BY exact DESC, pinned DESC, games DESC LIMIT 30) x)`;
        };
        const [row] = await q<{ white: Found[] | null; black: Found[] | null; event: boolean | null; opening: boolean | null }>(
          `SELECT ${players(whiteWords, p.whitePin)} AS white, ${players(blackWords, p.blackPin)} AS black,
             ${p.event ? `EXISTS (SELECT 1 FROM events WHERE lower(name) LIKE ${arg(contains(p.event))})` : 'NULL'} AS event,
             ${p.opening && !eco ? `EXISTS (SELECT 1 FROM openings WHERE lower(name) LIKE ${arg(contains(p.opening))})` : 'NULL'} AS opening`,
          params,
        );
        out.white = pickPlayers(row.white ?? []);
        out.black = pickPlayers(row.black ?? []);
        if (whiteWords && !out.white.length) return none(`No player matches “${p.white}”.`);
        if (blackWords && !out.black.length) return none(`No player matches “${p.black}”.`);
        if (row.event === false) return none(`No event matches “${p.event}”.`);
        if (row.opening === false) return none(`No opening matches “${p.opening}”. Try a name like “Najdorf” or an ECO code like B90.`);
      }

      // 2. The games.
      const where: string[] = [];
      const params: (string | number)[] = [];
      const arg = (v: string | number) => {
        params.push(v);
        return `$${params.length}`;
      };
      const W = whiteWords && arg(intArray(out.white.map((x) => x.id)));
      const B = blackWords && arg(intArray(out.black.map((x) => x.id)));
      if (W && B)
        where.push(p.anyColour ? `((g.white_id = ANY(${W}::int[]) AND g.black_id = ANY(${B}::int[])) OR (g.white_id = ANY(${B}::int[]) AND g.black_id = ANY(${W}::int[])))` : `g.white_id = ANY(${W}::int[]) AND g.black_id = ANY(${B}::int[])`);
      else if (W) where.push(p.anyColour ? `(g.white_id = ANY(${W}::int[]) OR g.black_id = ANY(${W}::int[]))` : `g.white_id = ANY(${W}::int[])`);
      else if (B) where.push(p.anyColour ? `(g.white_id = ANY(${B}::int[]) OR g.black_id = ANY(${B}::int[]))` : `g.black_id = ANY(${B}::int[])`);
      if (p.result === 'decisive') where.push(`g.result <> '1/2-1/2'`);
      else if (p.result) where.push(`g.result = ${arg(p.result)}`);
      // Every event and opening whose name matches (no cap: "Open" alone matches thousands of events).
      if (p.event) where.push(`g.event_id IN (SELECT id FROM events WHERE lower(name) LIKE ${arg(contains(p.event))})`);
      if (p.opening && !eco) where.push(`g.opening IN (SELECT slug FROM openings WHERE lower(name) LIKE ${arg(contains(p.opening))})`);
      if (eco) where.push(`g.eco BETWEEN ${arg(eco[0])} AND ${arg(eco[1])}`); // games_eco
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
        // NULLS FIRST: the backward scan of games_date (date DESC NULLS LAST); NULLS LAST would scan the table.
        oldest: 'g.date ASC NULLS FIRST, g.id ASC',
        rating: 'g.elo_avg DESC NULLS LAST, g.id DESC',
        shortest: 'g.plies ASC, g.id ASC',
      }[p.sort];
      const rows = await q<GameRow>(
        `SELECT ${GAME_COLS} FROM games g ${GAME_JOINS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${order} LIMIT ${arg(PAGE_SIZE + 1)} OFFSET ${arg((p.page - 1) * PAGE_SIZE)}`,
        params,
      );
      return { ...out, games: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
    });
  } catch (e) {
    if (isTimeout(e)) return { ...none(TOO_BROAD), tooBroad: true };
    throw e;
  }
}

/** Player name suggestions for the search form (most games first; the words in any order). */
export async function suggestPlayers(q: string, limit = 8) {
  const words = nameWords(q);
  if (words.join(' ').length < 3) return [];
  const params: (string | number)[] = [];
  const arg = (v: string | number) => {
    params.push(v);
    return `$${params.length}`;
  };
  const { where } = nameMatch(words, arg);
  return query<{ name: string; title: string | null; fed: string | null; games: number }>(
    `SELECT name, title, fed, games FROM players WHERE ${where} ORDER BY games DESC LIMIT ${arg(limit)}`,
    params,
  );
}
