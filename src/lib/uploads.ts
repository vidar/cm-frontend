// Tournaments uploaded by organisers (/upload/): PGN round by round, managed through a secret link.
// Uploads live in tables uploads/upload_rounds (scripts/uploads.pg.sql) until the site owner approves
// them (/upload/admin/, Worker secret ADMIN_KEY); then they are published into events/players/games
// with ids from UPLOAD_ID_BASE, and later rounds publish straight away. Players are matched to existing
// ones by FIDE ID (FideId tags), otherwise by exact name among uploaded players, otherwise created.
// Only import from on-demand routes.
import { env } from 'cloudflare:workers';
import { analyseEvent, type EventGame } from './event';
import { query, slugify, transaction, type Q } from './games';
import { parseGame, roundOf, splitPgn, type ParsedGame, type PgnProblem } from './pgn';

/** Uploaded events, players and games get ids from here up; the TWIC importer stays below. */
export const UPLOAD_ID_BASE = 100_000_000;
export const isUploaded = (id: number) => id >= UPLOAD_ID_BASE;

export const FORMATS = { swiss: 'Swiss', 'round-robin': 'Round robin', knockout: 'Knockout', team: 'Team event' } as const;
export type UploadFormat = keyof typeof FORMATS;
/** events.type for each format (analyseEvent reads "k.o" as a knockout hint). */
const EVENT_TYPE: Record<UploadFormat, string> = { swiss: 'swiss', 'round-robin': 'round robin', knockout: 'k.o.', team: 'team' };

export const LIMITS = { bytes: 2_000_000, gamesPerRound: 600, rounds: 40, pending: 50 };

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

export async function createUpload(input: { name: string; site: string; format: string; contact: string }) {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (name.length < 3) return { error: 'Give the tournament a name.' };
  if (!(input.format in FORMATS)) return { error: 'Choose the tournament format.' };
  const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM uploads WHERE status = 'pending'`);
  if (Number(n) >= LIMITS.pending) return { error: 'Too many tournaments are waiting for approval right now. Please try again in a few days.' };
  const token = newToken();
  await query('INSERT INTO uploads (token_hash, name, site, format, contact) VALUES ($1, $2, $3, $4, $5)', [
    await hash(token),
    name,
    input.site.trim().slice(0, 120) || null,
    input.format,
    input.contact.trim().slice(0, 200) || null,
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
  const problems: PgnProblem[] = [];
  const byRound = new Map<number, { game: ParsedGame; raw: string }[]>();
  raws.forEach((raw, i) => {
    const g = parseGame(raw);
    if (typeof g === 'string') return problems.push({ game: i + 1, message: g });
    const n = forced ?? roundOf(g.round);
    if (!n) return problems.push({ game: i + 1, message: 'no round number in the Round tag (choose the round in the form instead)' });
    (byRound.get(n) ?? byRound.set(n, []).get(n)!).push({ game: g, raw });
  });
  if (!byRound.size) return { error: raws.length ? 'No game in the file could be read.' : 'The file has no games.', problems };
  const existing = await getRounds(upload.id);
  const rounds = new Set([...existing.map((r) => r.round), ...byRound.keys()]);
  if (rounds.size > LIMITS.rounds || Math.max(...byRound.keys()) > LIMITS.rounds) return { error: `At most ${LIMITS.rounds} rounds.`, problems };
  for (const [n, list] of byRound) if (list.length > LIMITS.gamesPerRound) return { error: `Round ${n} has more than ${LIMITS.gamesPerRound} games.`, problems };

  // Round tags as the site reads them: "N.board" (team events: keep "N.match" when given).
  for (const [n, list] of byRound)
    list.forEach(({ game }, i) => {
      const keep = game.round && roundOf(game.round) === n && game.round.includes('.');
      game.round = keep ? game.round : upload.format === 'team' ? String(n) : `${n}.${i + 1}`;
    });

  await transaction(async (q) => {
    for (const [n, list] of byRound)
      await q(
        `INSERT INTO upload_rounds (upload_id, round, pgn, games) VALUES ($1, $2, $3, $4)
         ON CONFLICT (upload_id, round) DO UPDATE SET pgn = EXCLUDED.pgn, games = EXCLUDED.games, uploaded_at = now()`,
        [upload.id, n, list.map((x) => x.raw.trim()).join('\n\n'), JSON.stringify(list.map((x) => x.game))],
      );
    await q('UPDATE uploads SET updated_at = now() WHERE id = $1', [upload.id]);
    if (upload.status === 'approved') await publish(q, upload, [...byRound.keys()]);
  });
  return { saved: [...byRound].map(([round, list]) => ({ round, games: list.length })).sort((a, b) => a.round - b.round), problems };
}

export async function deleteRound(upload: Upload, n: number) {
  await transaction(async (q) => {
    await q('DELETE FROM upload_rounds WHERE upload_id = $1 AND round = $2', [upload.id, n]);
    if (upload.status === 'approved') await publish(q, upload, [n]);
  });
}

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

const nextId = async (q: Q, table: 'events' | 'players' | 'games') =>
  Number((await q<{ m: number }>(`SELECT GREATEST(COALESCE(MAX(id), 0) + 1, $1::int) AS m FROM ${table} WHERE id >= $1`, [UPLOAD_ID_BASE]))[0].m);

async function uniqueSlug(q: Q, table: 'events' | 'players', base: string) {
  const root = base || 'unnamed';
  const taken = new Set((await q<{ slug: string }>(`SELECT slug FROM ${table} WHERE slug = $1 OR slug LIKE $2`, [root, `${root}-%`])).map((r) => r.slug));
  if (table === 'events') for (const r of await q<{ slug: string }>(`SELECT slug FROM event_redirects WHERE slug = $1 OR slug LIKE $2`, [root, `${root}-%`])) taken.add(r.slug);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}

/** Delete the published games of these rounds (with their analyses) and return the players involved. */
async function dropRounds(q: Q, eventId: number, rounds: number[] | 'all') {
  const where = rounds === 'all' ? 'event_id = $1' : `event_id = $1 AND split_part(round, '.', 1) = ANY($2::text[])`;
  const params = rounds === 'all' ? [eventId] : [eventId, arr(rounds.map(String))];
  const gone = await q<{ id: number; white_id: number; black_id: number }>(`DELETE FROM games WHERE ${where} RETURNING id, white_id, black_id`, params);
  const ids = gone.map((g) => g.id);
  if (ids.length) {
    await q('DELETE FROM game_analysis WHERE game_id = ANY($1::int[])', [arr(ids)]);
    await q('DELETE FROM game_annotation WHERE game_id = ANY($1::int[])', [arr(ids)]);
  }
  return gone.flatMap((g) => [g.white_id, g.black_id]);
}

/** Refresh players' game counts and last dates; drop uploaded players left without games. */
async function refreshPlayers(q: Q, ids: number[]) {
  const list = [...new Set(ids)];
  if (!list.length) return;
  await q(
    `UPDATE players p SET games = s.n, last_date = COALESCE(s.last, p.last_date) FROM (
       SELECT x.id, count(g.id)::int AS n, max(g.date) AS last FROM unnest($1::int[]) AS x(id)
       LEFT JOIN games g ON g.white_id = x.id OR g.black_id = x.id GROUP BY x.id) s WHERE p.id = s.id`,
    [arr(list)],
  );
  await q('DELETE FROM players WHERE id = ANY($1::int[]) AND id >= $2 AND games = 0', [arr(list), UPLOAD_ID_BASE]);
}

async function unpublish(q: Q, eventId: number) {
  const players = await dropRounds(q, eventId, 'all');
  await q('DELETE FROM events WHERE id = $1', [eventId]);
  await refreshPlayers(q, players);
}

/** Publish (or re-publish) rounds of an approved tournament into events/players/games. */
async function publish(q: Q, upload: Upload, rounds: number[], all = false) {
  // The event: create it the first time (or again after a TWIC --reset reload dropped it).
  const exists = upload.event_id ? (await q<{ id: number }>('SELECT id FROM events WHERE id = $1', [upload.event_id])).length > 0 : false;
  const eventId: number = upload.event_id ?? (await nextId(q, 'events'));
  if (!exists) {
    const year = new Date().getUTCFullYear();
    const slug = await uniqueSlug(q, 'events', slugify(/\b(19|20)\d\d\b/.test(upload.name) ? upload.name : `${upload.name} ${year}`));
    await q(`INSERT INTO events (id, name, site, slug, games, twic, type) VALUES ($1, $2, $3, $4, 0, NULL, $5)`, [eventId, upload.name, upload.site, slug, EVENT_TYPE[upload.format]]);
    await q('UPDATE uploads SET event_id = $2 WHERE id = $1', [upload.id, eventId]);
    all = true;
  }
  const touched = await dropRounds(q, eventId, all ? 'all' : rounds);
  const data = await q<{ round: number; games: string }>(
    `SELECT round, games FROM upload_rounds WHERE upload_id = $1 ${all ? '' : 'AND round = ANY($2::int[])'} ORDER BY round`,
    all ? [upload.id] : [upload.id, arr(rounds)],
  );
  const games = data.flatMap((r) => JSON.parse(r.games) as ParsedGame[]);

  // Players: by FIDE ID anywhere, else by exact name among uploaded players, else new.
  const sides = games.flatMap((g) => [
    { name: g.white, fide: g.whiteFide, title: g.whiteTitle, fed: g.whiteFed, elo: g.whiteElo },
    { name: g.black, fide: g.blackFide, title: g.blackTitle, fed: g.blackFed, elo: g.blackElo },
  ]);
  const keyOf = (s: { name: string; fide: number | null }) => (s.fide ? `f${s.fide}` : `n${s.name.toLowerCase()}`);
  const ids = new Map<string, number>();
  const fides = [...new Set(sides.map((s) => s.fide).filter((f): f is number => !!f))];
  if (fides.length) for (const r of await q<{ id: number; fide_id: number }>('SELECT DISTINCT ON (fide_id) id, fide_id FROM players WHERE fide_id = ANY($1::int[]) ORDER BY fide_id, games DESC', [arr(fides)])) ids.set(`f${r.fide_id}`, r.id);
  const names = [...new Set(sides.filter((s) => !s.fide).map((s) => s.name.toLowerCase()))];
  if (names.length) for (const r of await q<{ id: number; name: string }>('SELECT DISTINCT ON (lower(name)) id, name FROM players WHERE id >= $2 AND lower(name) = ANY($1::text[]) ORDER BY lower(name), id', [arr(names), UPLOAD_ID_BASE])) ids.set(`n${r.name.toLowerCase()}`, r.id);
  let pid = await nextId(q, 'players');
  for (const s of sides) {
    const k = keyOf(s);
    if (ids.has(k)) continue;
    const slug = await uniqueSlug(q, 'players', slugify(s.name));
    await q(`INSERT INTO players (id, fide_id, name, slug, search, title, fed, max_elo, games) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`, [
      pid, s.fide, s.name, slug, slugify(s.name).replace(/-/g, ' '), s.title, s.fed, s.elo,
    ]);
    ids.set(k, pid++);
  }
  // Ratings seen in this tournament raise max_elo of uploaded players.
  for (const s of sides) if (s.elo) await q('UPDATE players SET max_elo = GREATEST(COALESCE(max_elo, 0), $2) WHERE id = $1 AND id >= $3', [ids.get(keyOf(s))!, s.elo, UPLOAD_ID_BASE]);

  // Games, in board order.
  let gid = await nextId(q, 'games');
  for (const g of games) {
    const w = ids.get(keyOf({ name: g.white, fide: g.whiteFide }))!;
    const b = ids.get(keyOf({ name: g.black, fide: g.blackFide }))!;
    const avg = g.whiteElo && g.blackElo ? Math.round((g.whiteElo + g.blackElo) / 2) : null;
    await q(
      `INSERT INTO games (id, event_id, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, opening, plies, twic, moves, white_team, black_team)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14, 0, $15, $16, $17)`,
      [gid++, eventId, w, b, g.whiteElo, g.blackElo, g.whiteTitle, g.blackTitle, avg, g.result, g.date, g.round, g.eco, g.plies, g.moves, g.whiteTeam, g.blackTeam],
    );
    touched.push(w, b);
  }

  // Event totals and dates.
  await q(
    `UPDATE events e SET games = s.n, start_date = s.first, end_date = s.last, rounds = s.rounds, name = $2, site = $3, type = $4
     FROM (SELECT count(*)::int AS n, min(date) AS first, max(date) AS last, max(split_part(round, '.', 1)::int) AS rounds FROM games WHERE event_id = $1) s
     WHERE e.id = $1`,
    [eventId, upload.name, upload.site, EVENT_TYPE[upload.format]],
  );
  await refreshPlayers(q, touched);
  return eventId;
}

// ---- preview (before publishing) -------------------------------------------------------------

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
