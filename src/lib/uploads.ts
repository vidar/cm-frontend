// Tournaments uploaded by organisers (/upload/): PGN round by round, managed through a secret link.
// Uploads live in tables uploads/upload_rounds (scripts/uploads.pg.sql) until the site owner approves
// them (/upload/admin/, Worker secret ADMIN_KEY); then they are published into events/players/games
// with ids from UPLOAD_ID_BASE, and later rounds publish straight away. Players are matched to existing
// ones by FIDE ID (FideId tags) when the names agree, otherwise by exact name among uploaded players,
// otherwise created. Only import from on-demand routes.
import { env } from 'cloudflare:workers';
import { analyseEvent, type EventGame } from './event';
import { query, slugify, transaction, type Q } from './games';
import { parseGame, roundOf, splitPgn, type ParsedGame, type PgnProblem } from './pgn';

/** Shown when a rejected tournament is changed (also thrown inside a transaction when it was rejected meanwhile). */
export const REJECTED = 'This tournament was not accepted, so it can no longer be changed.';

/** Uploaded events, players and games get ids from here up; the TWIC importer stays below. */
export const UPLOAD_ID_BASE = 100_000_000;
export const isUploaded = (id: number) => id >= UPLOAD_ID_BASE;

export const FORMATS = { swiss: 'Swiss', 'round-robin': 'Round robin', knockout: 'Knockout', team: 'Team event' } as const;
export type UploadFormat = keyof typeof FORMATS;
/** events.type for each format (analyseEvent reads "k.o" as a knockout hint). */
const EVENT_TYPE: Record<UploadFormat, string> = { swiss: 'swiss', 'round-robin': 'round robin', knockout: 'k.o.', team: 'team' };

// games: per tournament; plies: per file (replaying moves is what costs CPU); pending: tournaments with
// games waiting for approval; perDay: new tournaments a day.
export const LIMITS = { bytes: 2_000_000, gamesPerRound: 600, rounds: 40, games: 2_000, plies: 150_000, pending: 50, perDay: 200 };

export interface Upload {
  id: number;
  name: string;
  site: string | null;
  format: UploadFormat;
  contact: string | null;
  status: 'pending' | 'approved' | 'rejected';
  event_id: number | null;
  created_at: string;
}
export interface UploadRound {
  round: number;
  games: ParsedGame[];
  uploaded_at: string;
}

// ---- secret links ----------------------------------------------------------------------------

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(24)));
async function hash(token: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The site owner's key (Worker secret ADMIN_KEY); compared in constant time. */
export function isAdmin(key: string | null | undefined) {
  const want = (env as { ADMIN_KEY?: string }).ADMIN_KEY;
  if (!want || !key || key.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}
export const adminConfigured = () => !!(env as { ADMIN_KEY?: string }).ADMIN_KEY;

const COLS = 'id, name, site, format, contact, status, event_id, created_at::text AS created_at';

// ---- organiser actions -----------------------------------------------------------------------

const text = (s: string, max: number) => s.replace(/[<>\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export async function createUpload(input: { name: string; site: string; format: string; contact: string }) {
  const name = text(input.name, 120);
  if (name.length < 3) return { error: 'Give the tournament a name.' };
  if (!Object.hasOwn(FORMATS, input.format)) return { error: 'Choose the tournament format.' }; // not 'in': that sees Object.prototype
  // Tournaments that got no games within a week are dropped; empty ones don't hold a pending slot,
  // so nobody can lock organisers out by creating empty tournaments.
  await query(`DELETE FROM uploads u WHERE status = 'pending' AND created_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM upload_rounds r WHERE r.upload_id = u.id)`);
  const [c] = await query<{ pending: string; today: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending' AND EXISTS (SELECT 1 FROM upload_rounds r WHERE r.upload_id = u.id)) AS pending,
       count(*) FILTER (WHERE created_at > now() - interval '1 day') AS today FROM uploads u`,
  );
  if (Number(c.pending) >= LIMITS.pending || Number(c.today) >= LIMITS.perDay)
    return { error: 'Too many tournaments are waiting for approval right now. Please try again in a few days.' };
  const token = newToken();
  await query('INSERT INTO uploads (token_hash, name, site, format, contact) VALUES ($1, $2, $3, $4, $5)', [
    await hash(token),
    name,
    text(input.site, 120) || null,
    input.format,
    text(input.contact, 200) || null,
  ]);
  return { token };
}

export async function findUpload(token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  // now() keeps Hyperdrive from serving a cached row after an update.
  return (await query<Upload>(`SELECT ${COLS}, now() AS t FROM uploads WHERE token_hash = $1`, [await hash(token)]))[0] ?? null;
}

export async function getUpload(id: number) {
  return (await query<Upload>(`SELECT ${COLS}, now() AS t FROM uploads WHERE id = $1`, [id]))[0] ?? null;
}

export async function getRounds(uploadId: number): Promise<UploadRound[]> {
  const rows = await query<{ round: number; games: string; uploaded_at: string }>(
    'SELECT round, games, uploaded_at::text AS uploaded_at, now() AS t FROM upload_rounds WHERE upload_id = $1 ORDER BY round',
    [uploadId],
  );
  return rows.map((r) => ({ round: r.round, games: JSON.parse(r.games), uploaded_at: r.uploaded_at }));
}

/**
 * Store a PGN file as round `forced`, or split by the games' Round tags when `forced` is null.
 * Replaces those rounds. Published tournaments are updated on the site right away.
 */
export async function saveRounds(upload: Upload, forced: number | null, text: string) {
  if (new TextEncoder().encode(text).length > LIMITS.bytes) return { error: 'The file is too large (2 MB at most).' };
  const raws = splitPgn(text);
  // Counted before anything is parsed: replaying the moves is the expensive part.
  if (raws.length > (forced ? LIMITS.gamesPerRound : LIMITS.games))
    return { error: forced ? `Round ${forced} has more than ${LIMITS.gamesPerRound} games.` : `At most ${LIMITS.games} games per tournament.` };
  const problems: PgnProblem[] = [];
  const byRound = new Map<number, { game: ParsedGame; raw: string }[]>();
  const today = new Date().toISOString().slice(0, 10);
  let plies = 0;
  for (const [i, raw] of raws.entries()) {
    const g = parseGame(raw);
    if (typeof g === 'string') {
      problems.push({ game: i + 1, message: g });
      continue;
    }
    plies += g.plies;
    if (plies > LIMITS.plies) return { error: 'The file has too many moves to read at once: please upload it a few rounds at a time.', problems };
    // A date in the future (they parse up to 2100) would become a player's "last game".
    if (g.date && g.date > today) g.date = null;
    const n = forced ?? roundOf(g.round);
    if (!n) {
      problems.push({ game: i + 1, message: 'no round number in the Round tag (choose the round in the form instead)' });
      continue;
    }
    (byRound.get(n) ?? byRound.set(n, []).get(n)!).push({ game: g, raw });
  }
  if (!byRound.size) return { error: raws.length ? 'No game in the file could be read.' : 'The file has no games.', problems };
  const existing = await getRounds(upload.id);
  const rounds = new Set([...existing.map((r) => r.round), ...byRound.keys()]);
  if (rounds.size > LIMITS.rounds || Math.max(...byRound.keys()) > LIMITS.rounds) return { error: `At most ${LIMITS.rounds} rounds.`, problems };
  for (const [n, list] of byRound) if (list.length > LIMITS.gamesPerRound) return { error: `Round ${n} has more than ${LIMITS.gamesPerRound} games.`, problems };
  const total = existing.reduce((t, r) => t + (byRound.has(r.round) ? 0 : r.games.length), 0) + raws.length;
  if (total > LIMITS.games) return { error: `At most ${LIMITS.games} games per tournament.`, problems };

  // Round tags as the site reads them: "N.board", or "N.match.board" when given (team events: "N" without
  // boards). Always rebuilt from the numbers, so "05.1" is stored as "5.1": rounds are matched by that text.
  for (const [n, list] of byRound)
    list.forEach(({ game }, i) => {
      const rest = (game.round ?? '').split('.').slice(1);
      const ok = roundOf(game.round) === n && rest.length >= 1 && rest.length <= 2 && rest.every((x) => /^\d{1,4}$/.test(x) && +x > 0);
      game.round = ok ? [n, ...rest.map(Number)].join('.') : upload.format === 'team' ? String(n) : `${n}.${i + 1}`;
    });

  const status = await transaction(async (q) => {
    const u = await lockUpload(q, upload.id);
    for (const [n, list] of byRound)
      await q(
        `INSERT INTO upload_rounds (upload_id, round, pgn, games) VALUES ($1, $2, $3, $4)
         ON CONFLICT (upload_id, round) DO UPDATE SET pgn = EXCLUDED.pgn, games = EXCLUDED.games, uploaded_at = now()`,
        [u.id, n, list.map((x) => x.raw.trim()).join('\n\n'), JSON.stringify(list.map((x) => x.game))],
      );
    await q('UPDATE uploads SET updated_at = now() WHERE id = $1', [u.id]);
    if (u.status === 'approved') await publish(q, u, [...byRound.keys()]);
    return u.status;
  }).catch(rejected);
  if (!status) return { error: REJECTED, problems };
  return { saved: [...byRound].map(([round, list]) => ({ round, games: list.length })).sort((a, b) => a.round - b.round), published: status === 'approved', problems };
}

/** Remove a round; false when the tournament was rejected meanwhile. */
export async function deleteRound(upload: Upload, n: number) {
  return transaction(async (q) => {
    const u = await lockUpload(q, upload.id);
    await q('DELETE FROM upload_rounds WHERE upload_id = $1 AND round = $2', [u.id, n]);
    if (u.status === 'approved') await publish(q, u, [n]);
    return true;
  }).catch(rejected);
}

/**
 * The upload as it is now, locked for this transaction: the page read it before the request body
 * arrived, and the site owner may have approved or rejected it since (approve/reject lock it too).
 */
async function lockUpload(q: Q, id: number) {
  const [u] = await q<Upload>(`SELECT ${COLS} FROM uploads WHERE id = $1 FOR UPDATE`, [id]);
  if (!u || u.status === 'rejected') throw new Error(REJECTED);
  return u;
}
const rejected = (e: unknown): false => {
  if (e instanceof Error && e.message === REJECTED) return false;
  throw e;
};

// ---- site owner actions ----------------------------------------------------------------------

export async function listUploads() {
  return query<Upload & { rounds: number; games: number }>(
    `SELECT u.id, u.name, u.site, u.format, u.contact, u.status, u.event_id, u.created_at::text AS created_at,
       count(r.round)::int AS rounds, coalesce(sum(json_array_length(r.games::json)), 0)::int AS games, now() AS t
     FROM uploads u LEFT JOIN upload_rounds r ON r.upload_id = u.id
     GROUP BY u.id ORDER BY (u.status = 'pending') DESC, u.created_at DESC LIMIT 200`,
  );
}

export async function approve(id: number) {
  return transaction(async (q) => {
    const [u] = await q<Upload>(`SELECT ${COLS} FROM uploads WHERE id = $1 FOR UPDATE`, [id]);
    if (!u) return null;
    const rows = await q<{ round: number }>('SELECT round FROM upload_rounds WHERE upload_id = $1', [id]);
    await q(`UPDATE uploads SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
    return publish(q, { ...u, status: 'approved' }, rows.map((r) => r.round), true);
  });
}

/** Reject (or take down) a tournament: removes it from the site, keeps the upload. */
export async function reject(id: number) {
  await transaction(async (q) => {
    const [u] = await q<Upload>(`SELECT ${COLS} FROM uploads WHERE id = $1 FOR UPDATE`, [id]);
    if (!u) return;
    if (u.event_id) await unpublish(q, u.event_id);
    await q(`UPDATE uploads SET status = 'rejected', event_id = NULL, updated_at = now() WHERE id = $1`, [id]);
  });
}

/** Publish every approved tournament again (after a TWIC --reset reload dropped them). */
export async function republishAll() {
  const ids = (await query<{ id: number }>(`SELECT id FROM uploads WHERE status = 'approved' ORDER BY id`)).map((r) => r.id);
  for (const id of ids) await approve(id);
  return ids.length;
}

// ---- publishing ------------------------------------------------------------------------------

/** Postgres array literal (the driver runs without type info here, so arrays go as text, cast in SQL). */
const arr = (xs: (string | number)[]) => `{${xs.map((x) => (typeof x === 'number' ? x : `"${x.replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;

/**
 * Next free uploaded id. Publishes run one at a time (advisory lock in publish), so MAX + 1 is safe.
 * Events also count the ids uploads still hold: a TWIC --reset reload empties events, and a new
 * tournament published before "Republish all" must not take an approved one's id.
 */
const nextId = async (q: Q, table: 'events' | 'players' | 'games') =>
  Number(
    (
      await q<{ m: number }>(
        `SELECT GREATEST(COALESCE(MAX(id), 0) + 1, $1::int${table === 'events' ? ', (SELECT COALESCE(MAX(event_id), 0) + 1 FROM uploads)' : ''}) AS m FROM ${table} WHERE id >= $1`,
        [UPLOAD_ID_BASE],
      )
    )[0].m,
  );

/**
 * A free slug for each base ("root", else "root-2", "root-3", ...), distinct from each other too. Looked
 * up by equality, so the unique index answers (a LIKE 'root-%' probe scans the table).
 */
async function freeSlugs(q: Q, table: 'events' | 'players', bases: string[]) {
  const roots = bases.map((b) => b || 'unnamed');
  const taken = new Set<string>();
  const checked = new Map<string, number>(); // root -> highest suffix looked up
  const lookup = async (want: [string, number][]) => {
    const slugs = want.flatMap(([root, to]) => Array.from({ length: to - (checked.get(root) ?? 0) }, (_, i) => ((checked.get(root) ?? 0) + i + 1 === 1 ? root : `${root}-${(checked.get(root) ?? 0) + i + 1}`)));
    for (const [root, to] of want) checked.set(root, to);
    const list = arr([...new Set(slugs)]);
    const sql = `SELECT slug FROM ${table} WHERE slug = ANY($1::text[])${table === 'events' ? ' UNION SELECT slug FROM event_redirects WHERE slug = ANY($1::text[])' : ''}`;
    for (const r of await q<{ slug: string }>(sql, [list])) taken.add(r.slug);
  };
  await lookup([...new Set(roots)].map((r) => [r, 10]));
  const out: string[] = [];
  for (const root of roots)
    for (let n = 1; ; n++) {
      if (n > checked.get(root)!) await lookup([[root, n + 99]]);
      const slug = n === 1 ? root : `${root}-${n}`;
      if (!taken.has(slug)) {
        taken.add(slug);
        out.push(slug);
        break;
      }
    }
  return out;
}

/**
 * Whether two spellings name the same person: "Nakamura, Hikaru", "Hikaru Nakamura" and "Nakamura, H."
 * do, "John Doe" doesn't. Every part of the shorter name must match its own part of the longer one, in
 * full or as its start (an initial), and at least one in full.
 */
export function sameName(a: string, b: string) {
  const parts = (s: string) => slugify(s).split('-').filter(Boolean);
  const [short, long] = [parts(a), parts(b)].sort((x, y) => x.length - y.length);
  if (!short.length) return false;
  let full = 0;
  for (const p of short) {
    let i = long.indexOf(p);
    if (i >= 0) full++;
    else i = long.findIndex((l) => l.startsWith(p));
    if (i < 0) return false;
    long.splice(i, 1);
  }
  return full > 0;
}

/** Delete the published games of these rounds (with their analyses) and return the players involved. */
async function dropRounds(q: Q, eventId: number, rounds: number[] | 'all') {
  // Rounds by the number the tag starts with ("5.1", and "05.1" stored before tags were rebuilt).
  const where = rounds === 'all' ? 'event_id = $1' : `event_id = $1 AND substring(round from '^[0-9]+')::int = ANY($2::int[])`;
  const params = rounds === 'all' ? [eventId] : [eventId, arr(rounds)];
  const gone = await q<{ id: number; white_id: number; black_id: number }>(`DELETE FROM games WHERE ${where} RETURNING id, white_id, black_id`, params);
  const ids = gone.map((g) => g.id);
  if (ids.length) {
    await q('DELETE FROM game_analysis WHERE game_id = ANY($1::int[])', [arr(ids)]);
    await q('DELETE FROM game_annotation WHERE game_id = ANY($1::int[])', [arr(ids)]);
  }
  return gone.flatMap((g) => [g.white_id, g.black_id]);
}

/**
 * Refresh players' game counts and last dates (and uploaded players' best rating, from their games);
 * drop uploaded players left without games.
 */
async function refreshPlayers(q: Q, ids: number[]) {
  const list = [...new Set(ids)];
  if (!list.length) return;
  await q(
    `UPDATE players p SET games = s.n, last_date = COALESCE(s.last, p.last_date), max_elo = CASE WHEN p.id >= $2 THEN s.elo ELSE p.max_elo END FROM (
       SELECT x.id, count(g.id)::int AS n, max(g.date) AS last, max(CASE WHEN g.white_id = x.id THEN g.white_elo ELSE g.black_elo END) AS elo
       FROM unnest($1::int[]) AS x(id) LEFT JOIN games g ON g.white_id = x.id OR g.black_id = x.id GROUP BY x.id) s WHERE p.id = s.id`,
    [arr(list), UPLOAD_ID_BASE],
  );
  await q('DELETE FROM players WHERE id = ANY($1::int[]) AND id >= $2 AND games = 0', [arr(list), UPLOAD_ID_BASE]);
}

async function unpublish(q: Q, eventId: number) {
  const players = await dropRounds(q, eventId, 'all');
  await q('DELETE FROM events WHERE id = $1', [eventId]);
  await refreshPlayers(q, players);
}

interface Side {
  name: string;
  fide: number | null;
  title: string | null;
  fed: string | null;
}

/** Publish (or re-publish) rounds of an approved tournament into events/players/games. */
async function publish(q: Q, upload: Upload, rounds: number[], all = false) {
  // One publish at a time: ids and slugs are allocated from what is in the tables.
  await q('SELECT pg_advisory_xact_lock($1::bigint)', [UPLOAD_ID_BASE]);

  // The event: create it the first time (or again after a TWIC --reset reload dropped it). An id that
  // another upload holds as well (given out before nextId counted uploads' ids) is not reused.
  let eventId = upload.event_id;
  let exists = false;
  if (eventId) {
    const [r] = await q<{ ev: boolean; other: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM events WHERE id = $1) AS ev, EXISTS (SELECT 1 FROM uploads WHERE event_id = $1 AND id <> $2) AS other',
      [eventId, upload.id],
    );
    if (r.other) eventId = null;
    else exists = r.ev;
  }
  if (!exists) all = true;
  const touched = eventId && exists ? await dropRounds(q, eventId, all ? 'all' : rounds) : [];
  const data = await q<{ round: number; games: string }>(
    `SELECT round, games FROM upload_rounds WHERE upload_id = $1 ${all ? '' : 'AND round = ANY($2::int[])'} ORDER BY round`,
    all ? [upload.id] : [upload.id, arr(rounds)],
  );
  const games = data.flatMap((r) => JSON.parse(r.games) as ParsedGame[]);
  if (!exists) {
    eventId ??= await nextId(q, 'events');
    // The year in the slug comes from the games (stable when the event is published again), else from the upload.
    const year = games.map((g) => g.date?.slice(0, 4)).filter(Boolean).sort()[0] ?? upload.created_at.slice(0, 4);
    const [slug] = await freeSlugs(q, 'events', [slugify(/\b(19|20)\d\d\b/.test(upload.name) ? upload.name : `${upload.name} ${year}`)]);
    await q(`INSERT INTO events (id, name, site, slug, games, twic, type) VALUES ($1, $2, $3, $4, 0, NULL, $5)`, [eventId, upload.name, upload.site, slug, EVENT_TYPE[upload.format]]);
    await q('UPDATE uploads SET event_id = $2 WHERE id = $1', [upload.id, eventId]);
  }

  // Players: an existing player when the FIDE ID and the name agree (an upload never puts games on a
  // real player's page under another name), else by exact name among uploaded players, else new. A FIDE
  // ID whose player has a different name is dropped (a typo, or someone else's ID).
  const fides = [...new Set(games.flatMap((g) => [g.whiteFide, g.blackFide]).filter((f): f is number => !!f))];
  const byFide = new Map<number, { id: number; name: string }>();
  if (fides.length)
    for (const r of await q<{ id: number; fide_id: number; name: string }>('SELECT DISTINCT ON (fide_id) id, fide_id, name FROM players WHERE fide_id = ANY($1::int[]) ORDER BY fide_id, games DESC', [arr(fides)]))
      byFide.set(r.fide_id, r);
  const fideOf = (name: string, fide: number | null) => (fide && (!byFide.has(fide) || sameName(byFide.get(fide)!.name, name)) ? fide : null);
  const keyOf = (name: string, fide: number | null) => (fideOf(name, fide) ? `f${fide}` : `n${name.toLowerCase()}`);
  const ids = new Map<string, number>();
  for (const [f, p] of byFide) ids.set(`f${f}`, p.id);
  const sides: Side[] = games.flatMap((g) => [
    { name: g.white, fide: fideOf(g.white, g.whiteFide), title: g.whiteTitle, fed: g.whiteFed },
    { name: g.black, fide: fideOf(g.black, g.blackFide), title: g.blackTitle, fed: g.blackFed },
  ]);
  const names = [...new Set(sides.filter((s) => !s.fide).map((s) => s.name.toLowerCase()))];
  if (names.length)
    for (const r of await q<{ id: number; name: string }>('SELECT DISTINCT ON (lower(name)) id, name FROM players WHERE id >= $2 AND lower(name) = ANY($1::text[]) ORDER BY lower(name), id', [arr(names), UPLOAD_ID_BASE]))
      ids.set(`n${r.name.toLowerCase()}`, r.id);
  const fresh = new Map<string, Side>();
  for (const s of sides) {
    const k = keyOf(s.name, s.fide);
    if (!ids.has(k) && !fresh.has(k)) fresh.set(k, s);
  }
  if (fresh.size) {
    const slugs = await freeSlugs(q, 'players', [...fresh.values()].map((s) => slugify(s.name)));
    const first = await nextId(q, 'players');
    const rows = [...fresh].map(([k, s], i) => {
      ids.set(k, first + i);
      return { id: first + i, fide_id: s.fide, name: s.name, slug: slugs[i], search: slugify(s.name).replace(/-/g, ' '), title: s.title, fed: s.fed };
    });
    await q(
      `INSERT INTO players (id, fide_id, name, slug, search, title, fed, games)
       SELECT id, fide_id, name, slug, search, title, fed, 0 FROM json_to_recordset($1::text::json) AS x(id int, fide_id int, name text, slug text, search text, title text, fed text)`,
      [JSON.stringify(rows)],
    );
  }

  // Games, in board order, in one statement.
  if (games.length) {
    const first = await nextId(q, 'games');
    const rows = games.map((g, i) => {
      const w = ids.get(keyOf(g.white, g.whiteFide))!;
      const b = ids.get(keyOf(g.black, g.blackFide))!;
      touched.push(w, b);
      const avg = g.whiteElo && g.blackElo ? Math.round((g.whiteElo + g.blackElo) / 2) : null;
      return {
        id: first + i, white_id: w, black_id: b, white_elo: g.whiteElo, black_elo: g.blackElo, white_title: g.whiteTitle, black_title: g.blackTitle, elo_avg: avg,
        result: g.result, date: g.date, round: g.round, eco: g.eco, plies: g.plies, moves: g.moves, white_team: g.whiteTeam, black_team: g.blackTeam,
      };
    });
    await q(
      `INSERT INTO games (id, event_id, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, opening, plies, twic, moves, white_team, black_team)
       SELECT id, $2, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, NULL, plies, 0, moves, white_team, black_team
       FROM json_to_recordset($1::text::json) AS x(id int, white_id int, black_id int, white_elo int, black_elo int, white_title text, black_title text, elo_avg int,
         result text, date text, round text, eco text, plies int, moves text, white_team text, black_team text)`,
      [JSON.stringify(rows), eventId],
    );
  }

  // Event totals and dates.
  await q(
    `UPDATE events e SET games = s.n, start_date = s.first, end_date = s.last, rounds = s.rounds, name = $2, site = $3, type = $4
     FROM (SELECT count(*)::int AS n, min(date) AS first, max(date) AS last, max(substring(round from '^[0-9]+')::int) AS rounds FROM games WHERE event_id = $1) s
     WHERE e.id = $1`,
    [eventId, upload.name, upload.site, EVENT_TYPE[upload.format]],
  );
  await refreshPlayers(q, touched);
  return eventId!;
}

// ---- preview (before publishing) -------------------------------------------------------------

/**
 * How the uploaded players' FIDE IDs will resolve, for the review: linked to an existing player's page
 * (the names agree), or not linked because the ID belongs to someone with another name.
 */
export async function fideLinks(rounds: UploadRound[]) {
  const sides = new Map<string, { name: string; fide: number }>();
  for (const g of rounds.flatMap((r) => r.games))
    for (const [name, fide] of [[g.white, g.whiteFide], [g.black, g.blackFide]] as const) if (fide) sides.set(`${fide}/${name}`, { name, fide });
  if (!sides.size) return [];
  const found = await query<{ fide_id: number; name: string; slug: string }>(
    'SELECT DISTINCT ON (fide_id) fide_id, name, slug FROM players WHERE fide_id = ANY($1::int[]) ORDER BY fide_id, games DESC',
    [arr([...new Set([...sides.values()].map((s) => s.fide))])],
  );
  const byFide = new Map(found.map((p) => [p.fide_id, p]));
  return [...sides.values()]
    .filter((s) => byFide.has(s.fide))
    .map((s) => ({ ...s, player: byFide.get(s.fide)!, linked: sameName(byFide.get(s.fide)!.name, s.name) }))
    .sort((a, b) => Number(a.linked) - Number(b.linked) || a.name.localeCompare(b.name));
}

/** Event analysis of the uploaded rounds, as the event page will show it (standings, format). */
export function previewAnalysis(upload: Upload, rounds: UploadRound[]) {
  const pid = new Map<string, number>();
  const idOf = (name: string) => pid.get(name.toLowerCase()) ?? pid.set(name.toLowerCase(), pid.size + 1).get(name.toLowerCase())!;
  let id = 0;
  const games: EventGame[] = rounds.flatMap((r) =>
    r.games.map((g) => ({
      id: ++id,
      white_id: idOf(g.white),
      black_id: idOf(g.black),
      white_elo: g.whiteElo,
      black_elo: g.blackElo,
      white_title: g.whiteTitle,
      black_title: g.blackTitle,
      result: g.result,
      date: g.date,
      round: g.round,
      plies: g.plies,
      eco: g.eco,
      opening: null,
      opening_name: null,
      white_team: g.whiteTeam,
      black_team: g.blackTeam,
      white_name: g.white,
      white_slug: '',
      white_fed: g.whiteFed,
      black_name: g.black,
      black_slug: '',
      black_fed: g.blackFed,
      event_name: upload.name,
      event_slug: '',
    })),
  );
  return analyseEvent(games, EVENT_TYPE[upload.format]);
}
