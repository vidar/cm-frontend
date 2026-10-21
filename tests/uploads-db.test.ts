// Integration tests for src/lib/uploads.ts: the organiser/admin flow of tournament uploads end to end —
// createUpload/findUpload/getUpload, saveRounds (forced round, split by Round tags, N.board tags, PGN
// problems, LIMITS), getRounds/deleteRound, listUploads, isAdmin, approve (publishing into events/players/
// games with ids from UPLOAD_ID_BASE, slugs, FIDE-ID matching), publishing straight away once approved
// (new rounds, replaced rounds and their engine analyses), reject, approving again and republishAll (which also
// takes down uploaded events no approved upload points to, as after a restore from an older backup).
// Needs the local Postgres copy of the games database (tests/db.ts; the suite skips itself without it).
// Everything written is marked "Vitest" (names, slugs) and removed in afterAll; real rows (ids below
// UPLOAD_ID_BASE) are never touched: players are matched by a fake FIDE ID or by names no TWIC player has.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query, slugify } from '../src/lib/games';
import type { ParsedGame } from '../src/lib/pgn';
import {
  approve,
  createUpload,
  deleteRound,
  fideLinks,
  findUpload,
  getRounds,
  getUpload,
  isAdmin,
  LIMITS,
  listUploads,
  REJECTED,
  reject,
  republishAll,
  saveRounds,
  UPLOAD_ID_BASE,
  type Upload,
} from '../src/lib/uploads';
import { dbAvailable } from './db';

// ---- fixtures ---------------------------------------------------------------------------------

/** Slug year of an event whose name has none: the year of its first game (the fixtures are dated 2004). */
const YEAR = 2004;
/** Above FIDE's range of real ids (the largest in the database is ~653 million) and absent from players. */
const FAKE_FIDE = 1_999_999_999;
/** Throwaway players row that FAKE_FIDE matches; id above UPLOAD_ID_BASE so it counts as uploaded data. */
const EXISTING_ID = UPLOAD_ID_BASE + 500;

const P = {
  alpha: 'Vitest, Alpha',
  beta: 'Vitest, Beta',
  gamma: 'Vitest, Gamma',
  delta: 'Vitest, Delta',
  epsilon: 'Vitest, Epsilon',
  zeta: 'Vitest, Zeta',
  fide: 'Vitest, Fide Match',
  eta: 'Vitest, Eta',
  theta: 'Vitest, Theta',
  iota: 'Vitest, Iota',
  kappa: 'Vitest, Kappa',
};

// Mainlines and the SAN chess.js produces for them.
const M1 = { pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6', san: 'e4 e5 Nf3 Nc6 Bb5 a6', plies: 6 };
const M2 = { pgn: '1. d4 d5 2. c4 e6', san: 'd4 d5 c4 e6', plies: 4 };
const M3 = { pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#', san: 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#', plies: 7 };
const M4 = { pgn: '1. c4 c5', san: 'c4 c5', plies: 2 };
const BAD = { pgn: '1. e4 e4', san: '', plies: 0 }; // e4 is not a legal reply

interface Fixture {
  white: string;
  black: string;
  moves: { pgn: string };
  result?: '1-0' | '0-1' | '1/2-1/2' | '*';
  tags?: Record<string, string>;
}
function game(g: Fixture): string {
  const tags: Record<string, string> = { White: g.white, Black: g.black, Result: g.result ?? '*', ...(g.tags ?? {}) };
  const head = Object.entries(tags)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n');
  return `${head}\n\n${g.moves.pgn} ${tags.Result}`;
}
const pgn = (...games: Fixture[]) => `${games.map(game).join('\n\n')}\n`;

/** Upload A ("Vitest Open", Swiss): round 1 by forced number, rounds 2–3 by Round tags, round 4 with a bad game. */
const ROUND1 = pgn(
  { white: P.alpha, black: P.beta, moves: M3, result: '1-0', tags: { Date: '2004.10.01', WhiteElo: '2100', BlackElo: '2000', ECO: 'C20' } },
  { white: P.gamma, black: P.delta, moves: M1, result: '1/2-1/2', tags: { Date: '2004.10.01' } },
);
const ROUNDS_2_3 = pgn(
  { white: P.alpha, black: P.gamma, moves: M2, result: '1-0', tags: { Round: '2', Date: '2004.10.02' } },
  { white: P.delta, black: P.epsilon, moves: M4, result: '0-1', tags: { Round: '2', Date: '2004.10.02' } },
  {
    white: P.fide,
    black: P.alpha,
    moves: M1,
    result: '1/2-1/2',
    tags: { Round: '3', Date: '2004.10.03', WhiteFideId: String(FAKE_FIDE), WhiteElo: '2300', WhiteTitle: 'IM', WhiteFed: 'NOR' },
  },
);
const ROUND4_WITH_BAD_GAME = pgn(
  { white: P.gamma, black: P.epsilon, moves: M1, tags: { Date: '2004.10.04' } },
  { white: P.delta, black: P.alpha, moves: BAD, tags: { Date: '2004.10.04' } },
  { white: P.epsilon, black: P.delta, moves: M2, tags: { Date: '2004.10.04' } },
);
/** Added once A is approved. */
const ROUND4_LATER = pgn(
  { white: P.gamma, black: P.epsilon, moves: M1, result: '1-0', tags: { Date: '2004.10.04' } },
  { white: P.epsilon, black: P.delta, moves: M2, result: '1/2-1/2', tags: { Date: '2004.10.04' } },
);
/** Replaces round 1 once A is approved: Beta disappears from the event, Zeta is new. */
const ROUND1_REPLACEMENT = pgn(
  { white: P.alpha, black: P.gamma, moves: M3, result: '1-0', tags: { Date: '2004.10.01' } },
  { white: P.delta, black: P.zeta, moves: M4, result: '*', tags: { Date: '2004.10.01' } },
);
/** Upload B: the same name as A (slug collision), one game. */
const B_ROUND1 = pgn({ white: P.eta, black: P.theta, moves: M4, result: '1/2-1/2', tags: { Date: '2004.10.05' } });
/** Upload C: a team event whose name carries its year. */
const C_ROUND1 = pgn({
  white: P.iota,
  black: P.kappa,
  moves: M2,
  result: '0-1',
  tags: { Round: '1', Date: '2004.03.01', WhiteTeam: 'Vitest Team One', BlackTeam: 'Vitest Team Two' },
});

// ---- helpers ----------------------------------------------------------------------------------

type Param = string | number | null;
const one = async <T>(text: string, params: Param[] = []) => (await query<T>(text, params))[0];
const count = async (text: string, params: Param[] = []) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${text}`, params)).n;

interface EventRow {
  id: number;
  name: string;
  site: string | null;
  slug: string;
  start_date: string | null;
  end_date: string | null;
  games: number;
  twic: number | null;
  type: string | null;
  rounds: number | null;
}
interface PlayerRow {
  id: number;
  fide_id: number | null;
  name: string;
  slug: string;
  search: string;
  title: string | null;
  fed: string | null;
  max_elo: number | null;
  games: number;
  last_date: string | null;
}
interface GameRow {
  id: number;
  event_id: number;
  white_id: number;
  black_id: number;
  white_elo: number | null;
  black_elo: number | null;
  white_title: string | null;
  elo_avg: number | null;
  result: string;
  date: string | null;
  round: string | null;
  eco: string | null;
  opening: string | null;
  plies: number;
  twic: number;
  moves: string;
  white_team: string | null;
  black_team: string | null;
}
const eventById = (id: number) => one<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
const eventGames = (id: number) => query<GameRow>('SELECT * FROM games WHERE event_id = $1 ORDER BY id', [id]);
const playerByName = (name: string) => one<PlayerRow | undefined>('SELECT * FROM players WHERE name = $1 AND id >= $2', [name, UPLOAD_ID_BASE]);
const gamesOf = (playerId: number) => count('games WHERE white_id = $1 OR black_id = $1', [playerId]);

/** Removes everything this file writes (safe to run before and after: only Vitest-marked rows, all above UPLOAD_ID_BASE). */
async function cleanup() {
  await query(
    `DELETE FROM game_analysis WHERE game_id IN (
       SELECT id FROM games WHERE id >= $1 AND (event_id IN (SELECT id FROM events WHERE id >= $1 AND name LIKE 'Vitest %')
         OR white_id IN (SELECT id FROM players WHERE id >= $1 AND slug LIKE 'vitest-%')))`,
    [UPLOAD_ID_BASE],
  );
  await query(
    `DELETE FROM game_annotation WHERE game_id IN (
       SELECT id FROM games WHERE id >= $1 AND (event_id IN (SELECT id FROM events WHERE id >= $1 AND name LIKE 'Vitest %')
         OR white_id IN (SELECT id FROM players WHERE id >= $1 AND slug LIKE 'vitest-%')))`,
    [UPLOAD_ID_BASE],
  );
  await query(
    `DELETE FROM games WHERE id >= $1 AND (event_id IN (SELECT id FROM events WHERE id >= $1 AND name LIKE 'Vitest %')
       OR white_id IN (SELECT id FROM players WHERE id >= $1 AND slug LIKE 'vitest-%'))`,
    [UPLOAD_ID_BASE],
  );
  await query(`DELETE FROM players WHERE id >= $1 AND (slug LIKE 'vitest-%' OR fide_id = $2)`, [UPLOAD_ID_BASE, FAKE_FIDE]);
  await query(`DELETE FROM events WHERE id >= $1 AND name LIKE 'Vitest %'`, [UPLOAD_ID_BASE]);
  await query(`DELETE FROM uploads WHERE name LIKE 'Vitest %'`); // upload_rounds cascade
}

/** Every published upload agrees with its rounds, and no uploaded player or game is left dangling. */
async function expectConsistent() {
  const approved = await query<{ id: number; event_id: number | null }>(`SELECT id, event_id FROM uploads WHERE status = 'approved' AND name LIKE 'Vitest %'`);
  for (const u of approved) {
    expect(u.event_id).not.toBeNull();
    const ev = await eventById(u.event_id!);
    expect(ev).toBeDefined();
    const games = await eventGames(u.event_id!);
    expect(ev.games).toBe(games.length);
    const inRounds = (await one<{ n: number }>('SELECT coalesce(sum(json_array_length(games::json)), 0)::int AS n FROM upload_rounds WHERE upload_id = $1', [u.id])).n;
    expect(games.length).toBe(inRounds);
    for (const g of games) expect(g.twic).toBe(0);
    const playerIds = [...new Set(games.flatMap((g) => [g.white_id, g.black_id]))];
    for (const id of playerIds) {
      const p = await one<PlayerRow>('SELECT * FROM players WHERE id = $1', [id]);
      expect(p, `player ${id} of game in event ${ev.slug}`).toBeDefined();
      expect(p.games).toBe(await gamesOf(id));
    }
  }
  expect(await count(`players WHERE id >= $1 AND games = 0 AND slug LIKE 'vitest-%'`, [UPLOAD_ID_BASE])).toBe(0);
  expect(await count(`games g WHERE g.id >= $1 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = g.event_id)`, [UPLOAD_ID_BASE])).toBe(0);
  expect(await count(`game_analysis a WHERE a.game_id >= $1 AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = a.game_id)`, [UPLOAD_ID_BASE])).toBe(0);
}

function expectUpload(u: Upload | null): asserts u is Upload {
  expect(u).not.toBeNull();
}

// ---- the flow ---------------------------------------------------------------------------------

describe.skipIf(!(await dbAvailable()))('uploads (local database)', () => {
  // Shared state, filled in as the flow progresses (vitest runs the tests of a file in order).
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let uploadA: Upload;
  let uploadB: Upload;
  let uploadC: Upload;
  let eventA: number;
  let eventB: number;
  let eventC: number;
  /** Ids of A's games after the first approval, by round tag. */
  let firstGames: Map<string, number>;

  beforeAll(async () => {
    await cleanup();
    await query(
      `INSERT INTO players (id, fide_id, name, slug, search, title, fed, born, max_elo, games, last_date)
       VALUES ($1, $2, 'Fide M. Vitest', 'vitest-existing', 'fide m vitest', NULL, NULL, NULL, 2250, 0, NULL)`,
      [EXISTING_ID, FAKE_FIDE],
    );
  });
  afterAll(cleanup);

  describe('isAdmin', () => {
    it("accepts the stub's ADMIN_KEY", () => {
      expect(isAdmin('test-admin-key')).toBe(true);
    });
    it('refuses other keys, the empty string and no key', () => {
      expect(isAdmin('x')).toBe(false);
      expect(isAdmin('')).toBe(false);
      expect(isAdmin('test-admin-kez')).toBe(false); // same length
      expect(isAdmin(null)).toBe(false);
      expect(isAdmin(undefined)).toBe(false);
    });
  });

  describe('createUpload', () => {
    it('needs a name of at least 3 characters', async () => {
      expect(await createUpload({ name: '  Vi ', site: '', format: 'swiss', contact: '' })).toEqual({ error: 'Give the tournament a name.' });
      expect(await count(`uploads WHERE name LIKE 'Vi%'`)).toBe(0);
    });
    it('needs a known format', async () => {
      expect(await createUpload({ name: 'Vitest Bad Format', site: '', format: 'arena', contact: '' })).toEqual({ error: 'Choose the tournament format.' });
      expect(await createUpload({ name: 'Vitest Bad Format', site: '', format: '', contact: '' })).toEqual({ error: 'Choose the tournament format.' });
      expect(await count(`uploads WHERE name = 'Vitest Bad Format'`)).toBe(0);
    });
    // Bug: `input.format in FORMATS` is true for Object.prototype members, so a crafted POST with
    // format=constructor creates an upload whose approval stores events.type = 'function Object() { [native code] }'.
    it('refuses a format that is only a property inherited by FORMATS', async () => {
      try {
        expect(await createUpload({ name: 'Vitest Bad Format', site: '', format: 'constructor', contact: '' })).toEqual({ error: 'Choose the tournament format.' });
        expect(await createUpload({ name: 'Vitest Bad Format', site: '', format: 'toString', contact: '' })).toEqual({ error: 'Choose the tournament format.' });
        expect(await count(`uploads WHERE name = 'Vitest Bad Format'`)).toBe(0);
      } finally {
        await query(`DELETE FROM uploads WHERE name = 'Vitest Bad Format'`);
      }
    });
    it('creates a pending upload and returns a url-safe secret token', async () => {
      const r = await createUpload({ name: '  Vitest   Open ', site: ' Vitest City ', format: 'swiss', contact: ' vitest@example.com ' });
      expect(r).not.toHaveProperty('error');
      tokenA = (r as { token: string }).token;
      expect(tokenA).toMatch(/^[\w-]{20,64}$/);
      expect(tokenA).toHaveLength(32); // 24 random bytes, base64url without padding
      const row = await one<{ name: string; site: string; contact: string; format: string; status: string; event_id: null; token_hash: string }>(
        `SELECT name, site, contact, format, status, event_id, token_hash FROM uploads WHERE name = 'Vitest Open'`,
      );
      expect(row).toMatchObject({ name: 'Vitest Open', site: 'Vitest City', contact: 'vitest@example.com', format: 'swiss', status: 'pending', event_id: null });
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(tokenA);
    });
    it('stores empty site and contact as NULL', async () => {
      const b = await createUpload({ name: 'Vitest Open', site: '  ', format: 'round-robin', contact: '' });
      tokenB = (b as { token: string }).token;
      expect(tokenB).toMatch(/^[\w-]{20,64}$/);
      expect(tokenB).not.toBe(tokenA);
      const c = await createUpload({ name: 'Vitest Classic 2004', site: 'Vitest Hall', format: 'team', contact: '' });
      tokenC = (c as { token: string }).token;
      expect(await query(`SELECT site, contact FROM uploads WHERE name = 'Vitest Open' AND format = 'round-robin'`)).toEqual([{ site: null, contact: null }]);
    });
  });

  describe('findUpload', () => {
    it('returns the pending upload for its token', async () => {
      const u = await findUpload(tokenA);
      expectUpload(u);
      uploadA = u;
      expect(u).toMatchObject({ name: 'Vitest Open', site: 'Vitest City', format: 'swiss', contact: 'vitest@example.com', status: 'pending', event_id: null });
      expect(u.id).toBeGreaterThan(0);
      expect(u.created_at).toMatch(/^\d{4}-\d\d-\d\d /);
      const b = await findUpload(tokenB);
      const c = await findUpload(tokenC);
      expectUpload(b);
      expectUpload(c);
      uploadB = b;
      uploadC = c;
      expect(b.format).toBe('round-robin');
      expect(c.format).toBe('team');
      expect(new Set([u.id, b.id, c.id]).size).toBe(3);
    });
    it('returns null for junk and for well-formed tokens nobody has', async () => {
      expect(await findUpload('')).toBeNull();
      expect(await findUpload('x')).toBeNull();
      expect(await findUpload(`${tokenA}'; DROP TABLE uploads; --`)).toBeNull();
      expect(await findUpload('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
      expect(await findUpload(tokenA.slice(0, 31) + (tokenA.endsWith('a') ? 'b' : 'a'))).toBeNull();
    });
  });

  describe('getUpload', () => {
    it('returns the same row by id', async () => {
      const u = await getUpload(uploadA.id);
      expectUpload(u);
      const { id, name, site, format, contact, status, event_id, created_at } = uploadA;
      expect(u).toMatchObject({ id, name, site, format, contact, status, event_id, created_at });
    });
    it('returns null for an unknown id', async () => {
      expect(await getUpload(2_147_483_647)).toBeNull();
      expect(await getUpload(0)).toBeNull();
    });
  });

  describe('saveRounds', () => {
    it('stores a file as the forced round and numbers the boards', async () => {
      expect(await saveRounds(uploadA, 1, ROUND1)).toEqual({ saved: [{ round: 1, games: 2 }], published: false, problems: [] });
      const [r1] = await getRounds(uploadA.id);
      expect(r1.round).toBe(1);
      expect(r1.games.map((g) => [g.white, g.black, g.round, g.result])).toEqual([
        [P.alpha, P.beta, '1.1', '1-0'],
        [P.gamma, P.delta, '1.2', '1/2-1/2'],
      ]);
      expect(r1.games[0]).toMatchObject({ whiteElo: 2100, blackElo: 2000, eco: 'C20', date: '2004-10-01', moves: M3.san, plies: M3.plies });
      const stored = await one<{ pgn: string }>('SELECT pgn FROM upload_rounds WHERE upload_id = $1 AND round = 1', [uploadA.id]);
      expect(stored.pgn).toBe(ROUND1.trim());
    });
    it('splits a file by Round tags when no round is forced', async () => {
      expect(await saveRounds(uploadA, null, ROUNDS_2_3)).toEqual({
        saved: [
          { round: 2, games: 2 },
          { round: 3, games: 1 },
        ],
        published: false,
        problems: [],
      });
      const rounds = await getRounds(uploadA.id);
      expect(rounds.map((r) => r.round)).toEqual([1, 2, 3]);
      expect(rounds[1].games.map((g) => g.round)).toEqual(['2.1', '2.2']);
      expect(rounds[2].games.map((g) => g.round)).toEqual(['3.1']);
      expect(rounds[2].games[0]).toMatchObject({ white: P.fide, whiteFide: FAKE_FIDE, whiteElo: 2300, whiteTitle: 'IM', whiteFed: 'NOR', black: P.alpha });
    });
    it('keeps a Round tag that already names the board, for an individual event', async () => {
      const text = pgn(
        { white: P.gamma, black: P.alpha, moves: M4, tags: { Round: '5.7' } },
        { white: P.delta, black: P.beta, moves: M4, tags: { Round: '5' } },
      );
      expect(await saveRounds(uploadA, null, text)).toEqual({ saved: [{ round: 5, games: 2 }], published: false, problems: [] });
      const r5 = (await getRounds(uploadA.id)).find((r) => r.round === 5)!;
      expect(r5.games.map((g) => g.round)).toEqual(['5.7', '5.2']);
      // Forced to another round, the tag's number no longer matches and the board is renumbered.
      expect(await saveRounds(uploadA, 6, text)).toEqual({ saved: [{ round: 6, games: 2 }], published: false, problems: [] });
      const r6 = (await getRounds(uploadA.id)).find((r) => r.round === 6)!;
      expect(r6.games.map((g) => g.round)).toEqual(['6.1', '6.2']);
      await deleteRound(uploadA, 5);
      await deleteRound(uploadA, 6);
    });
    it('keeps plain round numbers for a team event', async () => {
      expect(await saveRounds(uploadC, null, C_ROUND1)).toEqual({ saved: [{ round: 1, games: 1 }], published: false, problems: [] });
      const [r1] = await getRounds(uploadC.id);
      expect(r1.games.map((g) => [g.round, g.whiteTeam, g.blackTeam])).toEqual([['1', 'Vitest Team One', 'Vitest Team Two']]);
    });
    it('skips a game with an illegal move and reports its 1-based number in the file', async () => {
      expect(await saveRounds(uploadA, 4, ROUND4_WITH_BAD_GAME)).toEqual({
        saved: [{ round: 4, games: 2 }],
        published: false,
        problems: [{ game: 2, message: 'illegal or unreadable move "e4" after 1 half-moves' }],
      });
      const r4 = (await getRounds(uploadA.id)).find((r) => r.round === 4)!;
      expect(r4.games.map((g) => [g.white, g.round])).toEqual([
        [P.gamma, '4.1'],
        [P.epsilon, '4.2'],
      ]);
    });
    it('reports games without a round number when none is forced', async () => {
      const r = await saveRounds(uploadA, null, pgn({ white: P.alpha, black: P.beta, moves: M4 }, { white: P.gamma, black: P.delta, moves: M4, tags: { Round: '?' } }));
      expect(r).toEqual({
        error: 'No game in the file could be read.',
        problems: [
          { game: 1, message: 'no round number in the Round tag (choose the round in the form instead)' },
          { game: 2, message: 'no round number in the Round tag (choose the round in the form instead)' },
        ],
      });
    });
    it('rejects an empty file', async () => {
      expect(await saveRounds(uploadA, 1, '\n\n')).toEqual({ error: 'The file has no games.', problems: [] });
      expect((await getRounds(uploadA.id)).find((r) => r.round === 1)?.games).toHaveLength(2); // untouched
    });
    it('rejects a round number above LIMITS.rounds', async () => {
      expect(LIMITS.rounds).toBe(40);
      const text = pgn({ white: P.alpha, black: P.beta, moves: M4 });
      expect(await saveRounds(uploadA, LIMITS.rounds + 1, text)).toEqual({ error: 'At most 40 rounds.', problems: [] });
      expect(await saveRounds(uploadA, null, pgn({ white: P.alpha, black: P.beta, moves: M4, tags: { Round: '41' } }))).toEqual({ error: 'At most 40 rounds.', problems: [] });
      expect((await getRounds(uploadA.id)).map((r) => r.round)).toEqual([1, 2, 3, 4]);
    });
    it('rejects a file above LIMITS.bytes before reading it', async () => {
      expect(LIMITS.bytes).toBe(2_000_000);
      const big = `${ROUND1}${' '.repeat(LIMITS.bytes - ROUND1.length + 1)}`;
      expect(await saveRounds(uploadA, 1, big)).toEqual({ error: 'The file is too large (2 MB at most).' });
      // Multi-byte characters count as bytes, not characters.
      const multibyte = `${ROUND1}% ${'é'.repeat(LIMITS.bytes / 2)}`;
      expect(multibyte.length).toBeLessThan(LIMITS.bytes);
      expect(await saveRounds(uploadA, 1, multibyte)).toEqual({ error: 'The file is too large (2 MB at most).' });
    });
  });

  describe('getRounds', () => {
    it('lists the rounds in order with their parsed games', async () => {
      const rounds = await getRounds(uploadA.id);
      expect(rounds.map((r) => [r.round, r.games.length])).toEqual([
        [1, 2],
        [2, 2],
        [3, 1],
        [4, 2],
      ]);
      for (const r of rounds) {
        expect(r.uploaded_at).toMatch(/^\d{4}-\d\d-\d\d /);
        for (const g of r.games) expect(typeof g.moves).toBe('string');
      }
      const r2: ParsedGame = rounds[1].games[1];
      expect(r2).toMatchObject({ white: P.delta, black: P.epsilon, result: '0-1', date: '2004-10-02', round: '2.2', moves: M4.san, plies: 2, whiteFide: null });
    });
    it('is empty for an upload without rounds and for an unknown id', async () => {
      expect(await getRounds(uploadB.id)).toEqual([]);
      expect(await getRounds(0)).toEqual([]);
    });
  });

  describe('deleteRound', () => {
    it('removes one round of a pending upload', async () => {
      await deleteRound(uploadA, 4);
      expect((await getRounds(uploadA.id)).map((r) => r.round)).toEqual([1, 2, 3]);
      await deleteRound(uploadA, 4); // gone already: no error
      expect((await getRounds(uploadA.id)).map((r) => r.round)).toEqual([1, 2, 3]);
    });
  });

  describe('listUploads', () => {
    it('lists uploads with their round and game counts, pending first', async () => {
      const list = await listUploads();
      const a = list.find((u) => u.id === uploadA.id)!;
      expect(a).toMatchObject({ name: 'Vitest Open', format: 'swiss', status: 'pending', event_id: null, rounds: 3, games: 5 });
      expect(list.find((u) => u.id === uploadB.id)).toMatchObject({ rounds: 0, games: 0 });
      expect(list.find((u) => u.id === uploadC.id)).toMatchObject({ rounds: 1, games: 1 });
      const firstNonPending = list.findIndex((u) => u.status !== 'pending');
      if (firstNonPending >= 0) expect(list.slice(firstNonPending).every((u) => u.status !== 'pending')).toBe(true);
    });
  });

  describe('approve', () => {
    it('publishes the upload as an event with games and players above UPLOAD_ID_BASE', async () => {
      const id = await approve(uploadA.id);
      expect(id).not.toBeNull();
      eventA = id!;
      expect(eventA).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);

      const u = await getUpload(uploadA.id);
      expectUpload(u);
      expect(u).toMatchObject({ status: 'approved', event_id: eventA });
      uploadA = u;

      const ev = await eventById(eventA);
      expect(ev).toMatchObject({
        name: 'Vitest Open',
        site: 'Vitest City',
        slug: `vitest-open-${YEAR}`, // no year in the name: the first game's is appended
        games: 5,
        rounds: 3,
        twic: null,
        type: 'swiss',
        start_date: '2004-10-01',
        end_date: '2004-10-03',
      });

      const games = await eventGames(eventA);
      expect(games).toHaveLength(5);
      expect(games.map((g) => g.round)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1']);
      for (const g of games) {
        expect(g.id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
        expect(g.twic).toBe(0);
        expect(g.opening).toBeNull();
        expect(g.white_id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
        expect(g.black_id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
      }
      expect(games[0]).toMatchObject({ white_elo: 2100, black_elo: 2000, elo_avg: 2050, result: '1-0', date: '2004-10-01', eco: 'C20', moves: M3.san, plies: 7 });
      expect(games[1]).toMatchObject({ white_elo: null, black_elo: null, elo_avg: null, result: '1/2-1/2', eco: null, moves: M1.san, plies: 6 });
      firstGames = new Map(games.map((g) => [g.round!, g.id]));
    });
    it('creates the players with unique slugs and the right game counts', async () => {
      const players = await query<PlayerRow>(`SELECT * FROM players WHERE slug LIKE 'vitest-%' AND slug <> 'vitest-existing' ORDER BY id`);
      expect(players.map((p) => p.name)).toEqual([P.alpha, P.beta, P.gamma, P.delta, P.epsilon]);
      expect(players.map((p) => p.slug)).toEqual(['vitest-alpha', 'vitest-beta', 'vitest-gamma', 'vitest-delta', 'vitest-epsilon']);
      expect(players.map((p) => p.games)).toEqual([3, 1, 2, 2, 1]);
      expect(players.map((p) => p.last_date)).toEqual(['2004-10-03', '2004-10-01', '2004-10-02', '2004-10-02', '2004-10-02']);
      expect(players.map((p) => p.max_elo)).toEqual([2100, 2000, null, null, null]);
      for (const p of players) {
        expect(p.id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
        expect(p.fide_id).toBeNull();
        expect(p.search).toBe(slugify(p.name).replace(/-/g, ' '));
        expect(p.games).toBe(await gamesOf(p.id));
      }
      expect(await count(`players WHERE id < $1 AND slug LIKE 'vitest-%'`, [UPLOAD_ID_BASE])).toBe(0);
      // The games point at these players, by name.
      const games = await eventGames(eventA);
      const byName = new Map(players.map((p) => [p.name, p.id]));
      expect(games.map((g) => g.white_id)).toEqual([byName.get(P.alpha), byName.get(P.gamma), byName.get(P.alpha), byName.get(P.delta), EXISTING_ID]);
      expect(games.map((g) => g.black_id)).toEqual([byName.get(P.beta), byName.get(P.delta), byName.get(P.gamma), byName.get(P.epsilon), byName.get(P.alpha)]);
    });
    it('matches a player by FIDE ID to an existing row instead of creating one', async () => {
      expect(await playerByName(P.fide)).toBeUndefined();
      const existing = await one<PlayerRow>('SELECT * FROM players WHERE id = $1', [EXISTING_ID]);
      expect(existing).toMatchObject({ name: 'Fide M. Vitest', fide_id: FAKE_FIDE, games: 1, last_date: '2004-10-03', max_elo: 2300 });
      const game = await one<GameRow>(`SELECT * FROM games WHERE event_id = $1 AND round = '3.1'`, [eventA]);
      expect(game).toMatchObject({ white_id: EXISTING_ID, white_elo: 2300, white_title: 'IM' });
    });
    it('returns null for an unknown upload', async () => {
      expect(await approve(2_147_483_647)).toBeNull();
    });
    it('gives a second event with the same name a -2 slug', async () => {
      await saveRounds(uploadB, 1, B_ROUND1);
      eventB = (await approve(uploadB.id))!;
      expect(eventB).toBeGreaterThan(eventA);
      uploadB = (await getUpload(uploadB.id))!;
      expect(uploadB).toMatchObject({ status: 'approved', event_id: eventB });
      expect(await eventById(eventB)).toMatchObject({ name: 'Vitest Open', site: null, slug: `vitest-open-${YEAR}-2`, games: 1, rounds: 1, type: 'round robin', start_date: '2004-10-05' });
      const [g] = await eventGames(eventB);
      expect(g).toMatchObject({ round: '1.1', result: '1/2-1/2', twic: 0 });
      expect(await playerByName(P.eta)).toMatchObject({ games: 1 });
      expect(await playerByName(P.theta)).toMatchObject({ games: 1 });
    });
    it('keeps the year of a name that has one and publishes a team event with plain round numbers', async () => {
      eventC = (await approve(uploadC.id))!;
      uploadC = (await getUpload(uploadC.id))!;
      expect(await eventById(eventC)).toMatchObject({ slug: 'vitest-classic-2004', type: 'team', games: 1, rounds: 1, start_date: '2004-03-01', end_date: '2004-03-01' });
      const [g] = await eventGames(eventC);
      expect(g).toMatchObject({ round: '1', white_team: 'Vitest Team One', black_team: 'Vitest Team Two', result: '0-1' });
    });
  });

  describe('saveRounds after approval', () => {
    it('publishes a new round straight away', async () => {
      expect(await saveRounds(uploadA, 4, ROUND4_LATER)).toEqual({ saved: [{ round: 4, games: 2 }], published: true, problems: [] });
      expect(await eventById(eventA)).toMatchObject({ games: 7, rounds: 4, end_date: '2004-10-04' });
      const games = await eventGames(eventA);
      expect(games.map((g) => g.round)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '4.1', '4.2']);
      // The earlier games are untouched; the new ones follow them.
      for (const [round, id] of firstGames) expect(games.find((g) => g.round === round)?.id).toBe(id);
      const maxBefore = Math.max(...firstGames.values());
      expect(games.filter((g) => g.round!.startsWith('4.')).every((g) => g.id > maxBefore)).toBe(true);
      expect(await playerByName(P.epsilon)).toMatchObject({ games: 3, last_date: '2004-10-04' });
      expect(await playerByName(P.gamma)).toMatchObject({ games: 3 });
    });
    it('replaces the games of a re-uploaded round, with their analyses and annotations', async () => {
      const oldIds = [firstGames.get('1.1')!, firstGames.get('1.2')!];
      await query(`INSERT INTO game_analysis (game_id, status, depth, evals) VALUES ($1, 'done', 18, '[]')`, [oldIds[0]]);
      await query(`INSERT INTO game_annotation (game_id, status, summary) VALUES ($1, 'done', 'vitest')`, [oldIds[0]]);
      await query(`INSERT INTO game_analysis (game_id, status) VALUES ($1, 'queued')`, [oldIds[1]]);
      const maxBefore = (await one<{ m: number }>('SELECT max(id) AS m FROM games WHERE id >= $1', [UPLOAD_ID_BASE])).m;

      expect(await saveRounds(uploadA, 1, ROUND1_REPLACEMENT)).toEqual({ saved: [{ round: 1, games: 2 }], published: true, problems: [] });

      expect(await eventById(eventA)).toMatchObject({ games: 7, rounds: 4, start_date: '2004-10-01' });
      const games = await eventGames(eventA);
      expect(games.map((g) => g.round).sort()).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '4.1', '4.2']);
      expect(await count('games WHERE id = $1 OR id = $2', [oldIds[0], oldIds[1]])).toBe(0);
      const round1 = games.filter((g) => g.round!.startsWith('1.'));
      expect(round1.every((g) => g.id > maxBefore)).toBe(true);
      expect(round1.map((g) => [g.result, g.moves])).toEqual([
        ['1-0', M3.san],
        ['*', M4.san],
      ]);
      expect(await count('game_analysis WHERE game_id = $1 OR game_id = $2', [oldIds[0], oldIds[1]])).toBe(0);
      expect(await count('game_annotation WHERE game_id = $1', [oldIds[0]])).toBe(0);
      // Other rounds keep their ids.
      for (const [round, id] of firstGames) if (!round.startsWith('1.')) expect(games.find((g) => g.round === round)?.id).toBe(id);
    });
    it('drops players left without games and creates the new ones', async () => {
      expect(await playerByName(P.beta)).toBeUndefined();
      const zeta = await playerByName(P.zeta);
      expect(zeta).toMatchObject({ slug: 'vitest-zeta', games: 1, last_date: '2004-10-01' });
      expect(zeta!.id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
      expect(await playerByName(P.alpha)).toMatchObject({ games: 3 });
      expect(await playerByName(P.gamma)).toMatchObject({ games: 3 });
      expect(await playerByName(P.delta)).toMatchObject({ games: 3 });
      const [g] = await query<GameRow>(`SELECT * FROM games WHERE event_id = $1 AND round = '1.2'`, [eventA]);
      expect(g.black_id).toBe(zeta!.id);
      await expectConsistent();
    });
  });

  describe('deleteRound after approval', () => {
    it('takes the round off the site', async () => {
      await deleteRound(uploadA, 4);
      expect((await getRounds(uploadA.id)).map((r) => r.round)).toEqual([1, 2, 3]);
      expect(await eventById(eventA)).toMatchObject({ games: 5, rounds: 3, end_date: '2004-10-03' });
      expect((await eventGames(eventA)).map((g) => g.round)).toEqual(['2.1', '2.2', '3.1', '1.1', '1.2']);
      expect(await playerByName(P.epsilon)).toMatchObject({ games: 1 });
      await expectConsistent();
    });
  });

  describe('reject', () => {
    it('takes the tournament down but keeps the upload and its rounds', async () => {
      await reject(uploadA.id);
      const u = await getUpload(uploadA.id);
      expectUpload(u);
      expect(u).toMatchObject({ status: 'rejected', event_id: null });
      uploadA = u;
      expect((await getRounds(uploadA.id)).map((r) => [r.round, r.games.length])).toEqual([
        [1, 2],
        [2, 2],
        [3, 1],
      ]);
      expect(await eventById(eventA)).toBeUndefined();
      expect(await count('games WHERE event_id = $1', [eventA])).toBe(0);
    });
    it('removes the uploaded players left without games, including the FIDE-matched one', async () => {
      for (const name of [P.alpha, P.gamma, P.delta, P.epsilon, P.zeta]) expect(await playerByName(name), name).toBeUndefined();
      expect(await count('players WHERE id = $1', [EXISTING_ID])).toBe(0);
      // The other tournaments and their players are untouched.
      expect(await eventById(eventB)).toMatchObject({ games: 1 });
      expect(await eventById(eventC)).toMatchObject({ games: 1 });
      expect(await playerByName(P.eta)).toMatchObject({ games: 1 });
      expect(await playerByName(P.iota)).toMatchObject({ games: 1 });
      await expectConsistent();
    });
    it('is a no-op for an unknown upload', async () => {
      await reject(2_147_483_647);
      expect(await query(`SELECT status FROM uploads WHERE id IN ($1, $2, $3) ORDER BY id`, [uploadA.id, uploadB.id, uploadC.id])).toEqual([
        { status: 'rejected' },
        { status: 'approved' },
        { status: 'approved' },
      ]);
    });
  });

  describe('approve again', () => {
    it('republishes a rejected upload as a new event', async () => {
      const id = await approve(uploadA.id);
      expect(id).not.toBeNull();
      expect(id).not.toBe(eventA);
      expect(id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
      eventA = id!;
      uploadA = (await getUpload(uploadA.id))!;
      expect(uploadA).toMatchObject({ status: 'approved', event_id: eventA });
      // The old slug is free again (the second "Vitest Open" keeps its -2).
      expect(await eventById(eventA)).toMatchObject({ slug: `vitest-open-${YEAR}`, games: 5, rounds: 3, start_date: '2004-10-01', end_date: '2004-10-03' });
      expect(await eventById(eventB)).toMatchObject({ slug: `vitest-open-${YEAR}-2` });
      const games = await eventGames(eventA);
      expect(games.map((g) => g.round)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1']);
      expect(games[1]).toMatchObject({ result: '*', moves: M4.san }); // the replaced round 1
    });
    it('creates the FIDE player anew now that the matching row is gone', async () => {
      const p = await playerByName(P.fide);
      expect(p).toMatchObject({ fide_id: FAKE_FIDE, slug: 'vitest-fide-match', title: 'IM', fed: 'NOR', max_elo: 2300, games: 1 });
      expect(p!.id).toBeGreaterThanOrEqual(UPLOAD_ID_BASE);
      expect(await count(`players WHERE fide_id = $1`, [FAKE_FIDE])).toBe(1);
      const g = await one<GameRow>(`SELECT * FROM games WHERE event_id = $1 AND round = '3.1'`, [eventA]);
      expect(g.white_id).toBe(p!.id);
      await expectConsistent();
    });
  });

  describe('republishAll', () => {
    it('publishes every approved upload again and returns how many', async () => {
      const approved = await count(`uploads WHERE status = 'approved'`);
      expect(approved).toBeGreaterThanOrEqual(3);
      // Game ids may change (the old games are dropped before new ids are picked); their content must not.
      const content = async (eventId: number) => (await eventGames(eventId)).map((g) => [g.round, g.white_id, g.black_id, g.result, g.date, g.moves]);
      const before = Object.fromEntries(await Promise.all([uploadA, uploadB, uploadC].map(async (u) => [u.id, await content(u.event_id!)] as const)));
      const players = await query<PlayerRow>(`SELECT id, name, games FROM players WHERE slug LIKE 'vitest-%' ORDER BY id`);
      const maxGame = (await one<{ m: number }>('SELECT max(id) AS m FROM games WHERE id >= $1', [UPLOAD_ID_BASE])).m;

      expect(await republishAll()).toEqual({ republished: approved, removed: 0 });

      for (const u of [uploadA, uploadB, uploadC]) {
        const fresh = await getUpload(u.id);
        expectUpload(fresh);
        expect(fresh).toMatchObject({ status: 'approved', event_id: u.event_id }); // the event keeps its id and slug
        expect(await content(u.event_id!)).toEqual(before[u.id]);
      }
      // B's and C's games did not hold the highest ids, so after their event's games are dropped they get new ones.
      expect((await eventGames(eventB))[0].id).toBeGreaterThan(maxGame);
      expect((await eventGames(eventC))[0].id).toBeGreaterThan(maxGame);
      expect(await eventById(eventA)).toMatchObject({ slug: `vitest-open-${YEAR}`, games: 5, rounds: 3 });
      expect(await eventById(eventB)).toMatchObject({ slug: `vitest-open-${YEAR}-2`, games: 1 });
      expect(await eventById(eventC)).toMatchObject({ slug: 'vitest-classic-2004', games: 1 });
      // Players are reused (matched by name among uploaded players), with the same counts.
      expect(await query<PlayerRow>(`SELECT id, name, games FROM players WHERE slug LIKE 'vitest-%' ORDER BY id`)).toEqual(players);
      await expectConsistent();
    });
  });

  describe('listUploads after publishing', () => {
    it('shows the published state', async () => {
      const list = await listUploads();
      expect(list.find((u) => u.id === uploadA.id)).toMatchObject({ status: 'approved', event_id: eventA, rounds: 3, games: 5 });
      expect(list.find((u) => u.id === uploadB.id)).toMatchObject({ status: 'approved', event_id: eventB, rounds: 1, games: 1 });
      expect(list.find((u) => u.id === uploadC.id)).toMatchObject({ status: 'approved', event_id: eventC, rounds: 1, games: 1 });
    });
  });
  // Fixes from the security/correctness review (docs in src/lib/uploads.ts).
  describe('review fixes', () => {
    const newUpload = async (name: string, format = 'swiss') => {
      const r = await createUpload({ name, site: '', format, contact: '' });
      expect(r).toHaveProperty('token');
      const u = await findUpload((r as { token: string }).token);
      expectUpload(u);
      return u;
    };
    const fresh = async (id: number) => {
      const u = await getUpload(id);
      expectUpload(u);
      return u;
    };
    const roundsOf = async (eventId: number) => (await eventGames(eventId)).map((g) => g.round);

    it('republishAll takes down an uploaded event that no approved upload points to (a restore from before a rejection)', async () => {
      const u = await newUpload('Vitest Review Orphan');
      await saveRounds(u, 1, pgn({ white: P.eta, black: P.theta, moves: M4, result: '1-0' }));
      await approve(u.id);
      const eventId = (await fresh(u.id)).event_id!;
      expect(await eventGames(eventId)).toHaveLength(1);
      // As restored: the hourly backup's uploads table says rejected; the full backup's events and games still hold it.
      await query(`UPDATE uploads SET status = 'rejected', event_id = NULL WHERE id = $1`, [u.id]);
      expect((await republishAll()).removed).toBe(1);
      expect(await eventById(eventId)).toBeUndefined();
      expect(await eventGames(eventId)).toHaveLength(0);
      await expectConsistent();
    });

    it('rebuilds Round tags from the numbers, so padded tags are replaced and removed like any other', async () => {
      let u = await newUpload('Vitest Review Padded');
      const text = pgn(
        { white: P.eta, black: P.theta, moves: M4, result: '1-0', tags: { Round: '05.1' } },
        { white: P.iota, black: P.kappa, moves: M4, result: '0-1', tags: { Round: '+5.02' } },
        { white: P.eta, black: P.kappa, moves: M4, result: '1-0', tags: { Round: '6.x' } },
        { white: P.theta, black: P.iota, moves: M4, result: '1-0', tags: { Round: '6.1.3' } },
      );
      expect(await saveRounds(u, null, text)).toMatchObject({ saved: [{ round: 5, games: 2 }, { round: 6, games: 2 }], published: false });
      expect((await getRounds(u.id)).map((r) => r.games.map((g) => g.round))).toEqual([['5.1', '5.2'], ['6.1', '6.1.3']]);
      const eventId = (await approve(u.id))!;
      u = await fresh(u.id);
      expect(await eventById(eventId)).toMatchObject({ rounds: 6, games: 4 });
      // Uploading round 5 again replaces its games instead of adding to them...
      await saveRounds(u, null, text);
      expect(await roundsOf(eventId)).toEqual(['5.1', '5.2', '6.1', '6.1.3']);
      // ...and removing it takes them off the site.
      expect(await deleteRound(u, 5)).toBe(true);
      expect(await roundsOf(eventId)).toEqual(['6.1', '6.1.3']);
      await expectConsistent();
    });

    it('drops dates in the future (they would become a player\'s last game)', async () => {
      const u = await newUpload('Vitest Review Dates');
      await saveRounds(u, 1, pgn({ white: P.eta, black: P.theta, moves: M4, tags: { Date: '2099.12.31' } }, { white: P.iota, black: P.kappa, moves: M4, tags: { Date: '2004.10.09' } }));
      expect((await getRounds(u.id))[0].games.map((g) => g.date)).toEqual([null, '2004-10-09']);
    });

    it('counts games before parsing any, per round and per tournament, and caps moves per file', async () => {
      const u = await newUpload('Vitest Review Limits');
      const many = (n: number) => pgn(...Array.from({ length: n }, () => ({ white: P.eta, black: P.theta, moves: M4 })));
      expect(await saveRounds(u, 1, many(LIMITS.gamesPerRound + 1))).toEqual({ error: `Round 1 has more than ${LIMITS.gamesPerRound} games.` });
      expect(await saveRounds(u, null, many(LIMITS.games + 1))).toEqual({ error: `At most ${LIMITS.games} games per tournament.` });
      // Four rounds of 500 games fit; one game more in another round goes over the tournament's total.
      for (const n of [1, 2, 3, 4]) expect(await saveRounds(u, n, many(500))).toMatchObject({ saved: [{ round: n, games: 500 }] });
      expect(await saveRounds(u, 5, many(1))).toEqual({ error: `At most ${LIMITS.games} games per tournament.`, problems: [] });
      // Replacing a round counts its new games instead of the old ones.
      expect(await saveRounds(u, 4, many(499))).toMatchObject({ saved: [{ round: 4, games: 499 }] });
      // Moves: 151 games of 1000 plies are more than LIMITS.plies.
      const long = { pgn: Array.from({ length: 250 }, (_, i) => `${2 * i + 1}. Nf3 Nf6 ${2 * i + 2}. Ng1 Ng8`).join(' ') };
      const u2 = await newUpload('Vitest Review Plies');
      const r = await saveRounds(u2, 1, pgn(...Array.from({ length: 151 }, () => ({ white: P.eta, black: P.theta, moves: long }))));
      expect(r).toMatchObject({ error: 'The file has too many moves to read at once: please upload it a few rounds at a time.' });
      expect(await getRounds(u2.id)).toEqual([]);
    });

    it('refuses changes once the tournament was rejected, even from a page loaded before', async () => {
      const u = await newUpload('Vitest Review Rejected');
      await saveRounds(u, 1, pgn({ white: P.eta, black: P.theta, moves: M4, result: '1-0' }));
      await approve(u.id);
      const stale = await fresh(u.id); // the organiser's page, loaded while it was approved
      await reject(u.id);
      expect(await saveRounds(stale, 2, pgn({ white: P.iota, black: P.kappa, moves: M4, result: '1-0' }))).toEqual({ error: REJECTED, problems: [] });
      expect(await deleteRound(stale, 1)).toBe(false);
      expect(await fresh(u.id)).toMatchObject({ status: 'rejected', event_id: null });
      expect(await count('events WHERE id = $1', [stale.event_id])).toBe(0);
      expect((await getRounds(u.id)).map((r) => r.round)).toEqual([1]);
    });

    it('links a FIDE ID to an existing player only when the names agree', async () => {
      const u = await newUpload('Vitest Review Fide');
      await saveRounds(u, 1, pgn({ white: 'Vitest, Imposter', black: P.theta, moves: M4, result: '0-1', tags: { WhiteFideId: String(FAKE_FIDE) } }));
      const owner = await one<PlayerRow>('SELECT * FROM players WHERE fide_id = $1 ORDER BY games DESC LIMIT 1', [FAKE_FIDE]);
      expect(owner.name).toBe(P.fide);
      const before = owner.games;
      expect(await fideLinks(await getRounds(u.id))).toEqual([{ name: 'Vitest, Imposter', fide: FAKE_FIDE, player: { fide_id: FAKE_FIDE, name: P.fide, slug: owner.slug }, linked: false }]);
      const eventId = (await approve(u.id))!;
      const [g] = await eventGames(eventId);
      expect(g.white_id).not.toBe(owner.id);
      expect(await playerByName('Vitest, Imposter')).toMatchObject({ fide_id: null, games: 1 }); // the ID is not copied either
      expect((await one<PlayerRow>('SELECT * FROM players WHERE id = $1', [owner.id])).games).toBe(before);
      // The same ID with the owner's name written another way is linked.
      const u2 = await newUpload('Vitest Review Fide Two');
      await saveRounds(u2, 1, pgn({ white: 'Fide Match Vitest', black: P.theta, moves: M4, result: '1-0', tags: { WhiteFideId: String(FAKE_FIDE) } }));
      expect((await fideLinks(await getRounds(u2.id)))[0]).toMatchObject({ linked: true });
      const e2 = (await approve(u2.id))!;
      expect((await eventGames(e2))[0].white_id).toBe(owner.id);
      await expectConsistent();
    });

    it("doesn't give a new tournament the event id an approved one still holds (after a --reset reload)", async () => {
      const x = await newUpload('Vitest Review Reset X');
      await saveRounds(x, 1, pgn({ white: P.eta, black: P.theta, moves: M4, result: '1-0' }));
      const ex = (await approve(x.id))!;
      // --reset drops events and games; uploads keep their event ids.
      await query('DELETE FROM games WHERE event_id = $1', [ex]);
      await query('DELETE FROM events WHERE id = $1', [ex]);
      const y = await newUpload('Vitest Review Reset Y');
      await saveRounds(y, 1, pgn({ white: P.iota, black: P.kappa, moves: M4, result: '0-1' }));
      const ey = (await approve(y.id))!;
      expect(ey).toBeGreaterThan(ex);
      expect((await approve(x.id))!).toBe(ex); // "Republish all" gives X its id back
      expect(await count('games WHERE event_id = $1', [ex])).toBe(1);
      expect(await count('games WHERE event_id = $1', [ey])).toBe(1);
      // An id two uploads hold (given out before this fix) is not reused for the second one.
      await query('UPDATE uploads SET event_id = $2 WHERE id = $1', [y.id, ex]);
      const again = (await approve(y.id))!;
      expect(again).not.toBe(ex);
      expect((await eventById(ex)).name).toBe('Vitest Review Reset X');
      expect(await count('games WHERE event_id = $1', [ex])).toBe(1);
      // Y's old event is orphaned by the manual change above; take it down like unpublish() would.
      await query('DELETE FROM games WHERE event_id = $1', [ey]);
      await query('DELETE FROM events WHERE id = $1', [ey]);
      await query(
        `UPDATE players p SET games = (SELECT count(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id) WHERE p.id >= $1 AND p.slug LIKE 'vitest-%'`,
        [UPLOAD_ID_BASE],
      );
      await query(`DELETE FROM players WHERE id >= $1 AND slug LIKE 'vitest-%' AND games = 0`, [UPLOAD_ID_BASE]);
      await expectConsistent();
    });

    it('publishes two tournaments at the same moment without clashing ids', async () => {
      const [a, b] = [await newUpload('Vitest Review Race A'), await newUpload('Vitest Review Race B')];
      for (const u of [a, b]) {
        await saveRounds(u, 1, pgn({ white: P.eta, black: P.theta, moves: M4, result: '1-0' }));
        await approve(u.id);
      }
      const round = (w: string) => pgn(...Array.from({ length: 40 }, (_, i) => ({ white: `${w} ${i}`, black: P.kappa, moves: M4, result: '1-0' as const })));
      const [ra, rb] = await Promise.all([saveRounds(await fresh(a.id), 2, round('Vitest, Racer A')), saveRounds(await fresh(b.id), 2, round('Vitest, Racer B'))]);
      expect(ra).toMatchObject({ saved: [{ round: 2, games: 40 }], published: true });
      expect(rb).toMatchObject({ saved: [{ round: 2, games: 40 }], published: true });
      await expectConsistent();
    });

    it('drops tournaments that got no games within a week when a new one is created', async () => {
      const old = await newUpload('Vitest Review Stale');
      await query(`UPDATE uploads SET created_at = now() - interval '8 days' WHERE id = $1`, [old.id]);
      const kept = await newUpload('Vitest Review Stale Kept');
      await saveRounds(kept, 1, pgn({ white: P.eta, black: P.theta, moves: M4 }));
      await query(`UPDATE uploads SET created_at = now() - interval '8 days' WHERE id = $1`, [kept.id]);
      await newUpload('Vitest Review Trigger');
      expect(await getUpload(old.id)).toBeNull();
      expect(await getUpload(kept.id)).not.toBeNull(); // it has a round
    });
  });
});
