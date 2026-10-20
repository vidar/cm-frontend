// Integration tests for src/lib/games.ts against the LOCAL Postgres copy of the TWIC games database
// (postgres://postgres:postgres@localhost:5432/cm_games, or TEST_DATABASE_URL; see tests/db.ts and
// tests/stubs/cloudflare-workers.ts). Every database suite is wrapped in describe.skipIf so the file
// passes trivially where there is no database (e.g. CI); only the pure helpers (twicIssueDate) run there.
//
// Covers getGame, getGamePage, getPlayerPage (both colours, paging), playerGames/playerScore agreeing
// with getPlayerPage, getEventWithGames, eventRedirect, searchPlayers, topPlayers, recentEvents,
// recentTopGames, gameMoves, getMeta, headToHead, gamePath and twicIssueDate. Fixtures are real rows
// (game 3076939 Praggnanandhaa–Rapport, Magnus Carlsen, the 46th Olympiad 2026) and every expected value
// below (counts, orderings, first rows, scores) was worked out with SQL against the same database first,
// so the assertions are exact.
import { describe, expect, it } from 'vitest';
import {
  eventRedirect,
  gameMoves,
  gamePath,
  getEventWithGames,
  getGame,
  getGamePage,
  getMeta,
  getPlayerPage,
  headToHead,
  PAGE_SIZE,
  playerGames,
  playerScore,
  query,
  recentEvents,
  recentTopGames,
  searchPlayers,
  topPlayers,
  twicIssueDate,
  type GameRow,
} from '../src/lib/games';
import { dbAvailable } from './db';

const describeDb = describe.skipIf(!(await dbAvailable()));

// ---- fixtures (values checked with SQL) --------------------------------------------------------

/** Praggnanandhaa R – Richard Rapport, 2nd UzChess Cup Masters 2025, round 6.1. */
const GAME_ID = 3076939;
const PRAGG_ID = 142;
const RAPPORT_ID = 363;
const MOVES_3076939 =
  'd4 Nf6 c4 g6 f3 Bg7 e4 d6 Nc3 O-O Nge2 a6 Be3 Nbd7 Qd2 b5 h4 h5 O-O-O e5 d5 Nb6 Bxb6 cxb6 cxb5 axb5 Kb1 b4 Nb5 Nxd5 exd5 Bf5+ Ka1 Ra4 Nc1 Qd7 Bc4 Rc8 Qe2 e4 Bb3 exf3 gxf3 Ra5 Bc4 Bc2 Rd2 Ba4 Nd4 Rac5 Nc6 Bxc6 Nb3 Rxc4 Qxc4 Bb5 Qe4 Bc4 Rc2 b5 Nc1 Re8 Qf4 Qa7 Rxc4 bxc4 Qxc4 b3 Rd1 bxa2 Qxa2 Qf2 Qb3 Re3';
const MOVES_1000 =
  'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 d5 e3 c5 a3 Bxc3+ bxc3 O-O cxd5 exd5 Bd3 c4 Be2 Nc6 a4 Re8 Nf3 Bg4 O-O Ne4 Bd2 Na5 Be1 Re6 Ne5 Bxe2 Qxe2 f6 f3 Nd6 Ng4 Qe8 Bd2 h5 Nf2 Nb3 Rae1 Qxa4 e4 Qa2 Bf4 Qxe2 Rxe2 Nb5 Rc2 Rae8 h4 a5 e5 a4 Nd1 a3 Ra2 Ra6 g4 fxe5 dxe5 Nc5 Be3 Nd3 f4 hxg4 Kg2 d4 Bxd4 Nxd4 cxd4 Nb4 Ra1 Nc2 Ra2 Nxd4 Ne3 b5 Rd1 Nc6 Rd7 Re7 Rd6 Rea7 h5 Nb4 Rd8+ Kf7 Ra1 a2 f5 Ra3 e6+ Kf6 Kf2 g3+ Ke2 Rxe3+ Kxe3 Nc2+ Kf4 g5+ hxg6 Nxa1 e7 Kxe7 g7 Kxd8 g8=Q+ Kc7 Qg7+ Kb6 Qd4+ Kb7 Qg7+';

const GAME_3076939 = {
  id: GAME_ID,
  event_id: 16010,
  white_id: PRAGG_ID,
  black_id: RAPPORT_ID,
  white_elo: 2767,
  black_elo: 2714,
  white_title: 'GM',
  black_title: 'GM',
  elo_avg: 2740,
  result: '0-1',
  date: '2025-06-24',
  round: '6.1',
  eco: 'E81',
  opening: 'indian-defense-anti-grunfeld-alekhine-variation',
  plies: 74,
  twic: 1599,
  white_name: 'Praggnanandhaa R',
  white_slug: 'praggnanandhaa-r',
  black_name: 'Richard Rapport',
  black_slug: 'richard-rapport',
  event_name: '2nd UzChess Cup Masters',
  event_slug: '2nd-uzchess-cup-masters-2025',
  event_site: 'Tashkent UZB',
};

/** All games between Praggnanandhaa and Rapport, newest first (dates are distinct, so the order is exact). */
const H2H_IDS = [3546622, 3420340, 3255783, 3251621, 3169817, GAME_ID, 2495871, 2055398, 1773343, 1727294];

/** Magnus Carlsen: 6501 games (3292 as White, 3209 as Black), +3774 =1802 -925. */
const CARLSEN_ID = 9;
const CARLSEN = {
  id: CARLSEN_ID,
  fide_id: 1503014,
  name: 'Magnus Carlsen',
  slug: 'magnus-carlsen',
  title: 'GM',
  fed: 'NOR',
  born: 1990,
  max_elo: 2882,
  games: 6501,
  last_date: '2026-09-24',
};
const CARLSEN_SCORE = { w: 3774, d: 1802, l: 925 };
// Rows 1, 50, 51 and 100 of his games ordered by date DESC NULLS LAST, id DESC.
const CARLSEN_ROW = { 1: 3543925, 50: 3492844, 51: 3492841, 100: 3432613 };
// His first games as White in the same order.
const CARLSEN_WHITE_FIRST = [3543825, 3543766, 3543537];

const OLYMPIAD = {
  id: 17979,
  name: '46th Olympiad 2026',
  site: 'Samarkand UZB',
  slug: '46th-olympiad-2026',
  start_date: '2026-09-16',
  end_date: '2026-09-27',
  games: 4480,
  twic: 1663,
  type: 'team',
  rounds: 11,
};
const OLYMPIAD_FIRST_GAME = {
  id: 3531411,
  white_id: 7430,
  black_id: 96,
  white_elo: 2216,
  black_elo: 2762,
  white_title: 'FM',
  black_title: 'GM',
  result: '0-1',
  date: '2026-09-16',
  round: '1.1',
  plies: 76,
  eco: 'A05',
  opening: 'zukertort-opening-2',
  opening_name: 'Zukertort Opening',
  white_team: 'Jamaica',
  black_team: 'Uzbekistan',
  white_name: 'Joshua Christie',
  white_slug: 'joshua-christie',
  white_fed: 'JAM',
  black_name: 'Nodirbek Abdusattorov',
  black_slug: 'nodirbek-abdusattorov',
  black_fed: 'UZB',
  event_name: '46th Olympiad 2026',
  event_slug: '46th-olympiad-2026',
};
const OLYMPIAD_LAST_GAME_ID = 3547026;

// ---- helpers ----------------------------------------------------------------------------------

const ids = (games: { id: number }[]) => games.map((g) => g.id);

/** True when the rows are ordered by date DESC (NULLS LAST) and then id DESC, as the player pages promise. */
function isNewestFirst(games: Pick<GameRow, 'date' | 'id'>[]) {
  for (let i = 1; i < games.length; i++) {
    const a = games[i - 1];
    const b = games[i];
    if (a.date === b.date) {
      if (!(a.id > b.id)) return false;
    } else if (a.date === null || (b.date !== null && a.date < b.date)) return false;
  }
  return true;
}

// ---- getGame ----------------------------------------------------------------------------------

describeDb('getGame', () => {
  it('returns the full row of game 3076939 with player and event names and moves', async () => {
    const g = await getGame(GAME_ID);
    expect(g).not.toBeNull();
    expect(g).toMatchObject(GAME_3076939);
    expect(g!.moves.startsWith('d4 Nf6')).toBe(true);
    expect(g!.moves).toBe(MOVES_3076939);
    expect(g!.moves.split(' ')).toHaveLength(g!.plies);
  });

  it('returns null for an id that does not exist', async () => {
    expect(await getGame(999999999)).toBeNull();
  });
});

// ---- getGamePage ------------------------------------------------------------------------------

describeDb('getGamePage', () => {
  it('returns the game with the opening name from the openings table', async () => {
    const page = await getGamePage(GAME_ID);
    expect(page).not.toBeNull();
    const { game } = page!;
    expect(game).toMatchObject(GAME_3076939);
    expect(game.moves).toBe(MOVES_3076939);
    // SELECT name FROM openings WHERE slug = 'indian-defense-anti-grunfeld-alekhine-variation'
    expect(game.opening_name).toBe('Indian Defense: Anti-Grünfeld, Alekhine Variation');
    expect('h2h' in game).toBe(false);
  });

  it('lists the other games between the same two players in either colour, newest first, without the game itself', async () => {
    const { others } = (await getGamePage(GAME_ID))!;
    const [{ n }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM games
       WHERE ((white_id = $1 AND black_id = $2) OR (white_id = $2 AND black_id = $1)) AND id <> $3`,
      [PRAGG_ID, RAPPORT_ID, GAME_ID],
    );
    expect(n).toBe(9);
    expect(others).toHaveLength(n);
    expect(ids(others)).toEqual(H2H_IDS.filter((id) => id !== GAME_ID));
    expect(others.some((g) => g.id === GAME_ID)).toBe(false);
    for (const g of others) {
      expect([g.white_id, g.black_id].sort()).toEqual([PRAGG_ID, RAPPORT_ID]);
      expect(g.event_slug).toBeTruthy();
    }
    // Both colours appear among the other games.
    expect(others.filter((g) => g.white_id === PRAGG_ID)).toHaveLength(5);
    expect(others.filter((g) => g.black_id === PRAGG_ID)).toHaveLength(4);
  });

  it('honours the limit on other games', async () => {
    const { others } = (await getGamePage(GAME_ID, 3))!;
    expect(ids(others)).toEqual(H2H_IDS.filter((id) => id !== GAME_ID).slice(0, 3));
  });

  it('returns null for an unknown id', async () => {
    expect(await getGamePage(999999999)).toBeNull();
  });
});

// ---- getPlayerPage ----------------------------------------------------------------------------

describeDb('getPlayerPage', () => {
  it('returns the player row, the first page of games newest first and the overall score', async () => {
    const page = await getPlayerPage('magnus-carlsen', 1);
    expect(page).not.toBeNull();
    const { player, games, hasMore, score } = page!;
    expect(player).toMatchObject(CARLSEN);
    expect(games).toHaveLength(PAGE_SIZE);
    expect(games).toHaveLength(50);
    expect(hasMore).toBe(true);
    expect(games[0].id).toBe(CARLSEN_ROW[1]);
    expect(games[49].id).toBe(CARLSEN_ROW[50]);
    expect(isNewestFirst(games)).toBe(true);
    for (const g of games) expect([g.white_id, g.black_id]).toContain(CARLSEN_ID);
    expect(score).toEqual(CARLSEN_SCORE);
    expect(score.w + score.d + score.l).toBe(player.games);
  });

  it("restricts to the player's games as White with color 'w'", async () => {
    const { games, hasMore, score } = (await getPlayerPage('magnus-carlsen', 1, 'w'))!;
    expect(games).toHaveLength(50);
    expect(hasMore).toBe(true);
    for (const g of games) expect(g.white_id).toBe(CARLSEN_ID);
    expect(ids(games).slice(0, 3)).toEqual(CARLSEN_WHITE_FIRST);
    expect(isNewestFirst(games)).toBe(true);
    // The score is overall, not per colour.
    expect(score).toEqual(CARLSEN_SCORE);
  });

  it("restricts to the player's games as Black with color 'b'", async () => {
    const { games } = (await getPlayerPage('magnus-carlsen', 1, 'b'))!;
    expect(games).toHaveLength(50);
    for (const g of games) expect(g.black_id).toBe(CARLSEN_ID);
    expect(isNewestFirst(games)).toBe(true);
  });

  it('continues on page 2 exactly where page 1 stopped, without overlap', async () => {
    const [p1, p2] = await Promise.all([getPlayerPage('magnus-carlsen', 1), getPlayerPage('magnus-carlsen', 2)]);
    expect(p2!.games).toHaveLength(50);
    expect(p2!.hasMore).toBe(true);
    expect(p2!.games[0].id).toBe(CARLSEN_ROW[51]);
    expect(p2!.games[49].id).toBe(CARLSEN_ROW[100]);
    const first = new Set(ids(p1!.games));
    expect(ids(p2!.games).filter((id) => first.has(id))).toEqual([]);
    expect(isNewestFirst([...p1!.games, ...p2!.games])).toBe(true);
  });

  it('returns null for an unknown player slug', async () => {
    expect(await getPlayerPage('no-such-player', 1)).toBeNull();
  });
});

// ---- playerGames / playerScore ----------------------------------------------------------------

describeDb('playerGames and playerScore', () => {
  it('playerGames gives the same page as getPlayerPage', async () => {
    const [page, both, white] = await Promise.all([
      getPlayerPage('magnus-carlsen', 1),
      playerGames(CARLSEN_ID, 1),
      playerGames(CARLSEN_ID, 1, 'w'),
    ]);
    expect(ids(both.games)).toEqual(ids(page!.games));
    expect(both.hasMore).toBe(page!.hasMore);
    const pageWhite = await getPlayerPage('magnus-carlsen', 1, 'w');
    expect(ids(white.games)).toEqual(ids(pageWhite!.games));
  });

  it('playerGames page 2 matches getPlayerPage page 2', async () => {
    const [page, games] = await Promise.all([getPlayerPage('magnus-carlsen', 2), playerGames(CARLSEN_ID, 2)]);
    expect(ids(games.games)).toEqual(ids(page!.games));
  });

  it('playerScore gives the same score as getPlayerPage', async () => {
    const [page, score] = await Promise.all([getPlayerPage('magnus-carlsen', 1), playerScore(CARLSEN_ID)]);
    expect(score).toEqual(CARLSEN_SCORE);
    expect(score).toEqual(page!.score);
  });

  it('playerScore is all zeros for an unknown player id', async () => {
    expect(await playerScore(999999999)).toEqual({ w: 0, d: 0, l: 0 });
  });
});

// ---- getEventWithGames ------------------------------------------------------------------------

describeDb('getEventWithGames', () => {
  it('returns the 46th Olympiad with all 4480 games ordered by id and opening names joined', async () => {
    const res = await getEventWithGames('46th-olympiad-2026');
    expect(res).not.toBeNull();
    const { event, games } = res!;
    expect(event).toEqual(OLYMPIAD);
    expect(event.games).toBe(4480);
    expect(games).toHaveLength(4480);
    expect(games[0]).toEqual(OLYMPIAD_FIRST_GAME);
    expect(games[games.length - 1].id).toBe(OLYMPIAD_LAST_GAME_ID);
    for (let i = 1; i < games.length; i++) expect(games[i].id).toBeGreaterThan(games[i - 1].id);
    // Every Olympiad game has an opening tag that resolves to a name in `openings` (checked with SQL).
    expect(games.every((g) => typeof g.opening_name === 'string' && g.opening_name.length > 0)).toBe(true);
    expect(games.every((g) => g.event_slug === '46th-olympiad-2026' && g.event_name === '46th Olympiad 2026')).toBe(true);
    expect(games.every((g) => typeof g.white_team === 'string' && typeof g.black_team === 'string')).toBe(true);
  });

  it('returns null for an unknown event slug', async () => {
    expect(await getEventWithGames('nope')).toBeNull();
  });
});

// ---- eventRedirect ----------------------------------------------------------------------------

describeDb('eventRedirect', () => {
  it('maps an old slug in event_redirects to the current slug of its event', async () => {
    // event_redirects: '10th-balagne-rapid-ko-2013-2' -> event 886, whose slug is '10th-balagne-rapid-ko-2013'.
    expect(await eventRedirect('10th-balagne-rapid-ko-2013-2')).toBe('10th-balagne-rapid-ko-2013');
  });

  it('returns null for a slug with no redirect (unknown, or already the current slug)', async () => {
    expect(await eventRedirect('no-such-event-slug')).toBeNull();
    expect(await eventRedirect('10th-balagne-rapid-ko-2013')).toBeNull();
  });
});

// ---- searchPlayers / topPlayers ---------------------------------------------------------------

describeDb('searchPlayers', () => {
  it("finds every player whose search text contains 'carlsen', most games first", async () => {
    const players = await searchPlayers('carlsen');
    // SELECT slug FROM players WHERE search LIKE '%carlsen%' -> 7 rows.
    expect(players).toHaveLength(7);
    expect(players[0].slug).toBe('magnus-carlsen');
    expect(players[0]).toMatchObject(CARLSEN);
    expect(players.slice(0, 4).map((p) => [p.slug, p.games])).toEqual([
      ['magnus-carlsen', 6501],
      ['henrik-carlsen', 39],
      ['ellen-oen-carlsen', 9],
      ['magnus-carlsen-chris-flowers', 3],
    ]);
    expect(players.map((p) => p.slug).sort()).toEqual(
      ['magnus-carlsen', 'henrik-carlsen', 'ellen-oen-carlsen', 'magnus-carlsen-chris-flowers', 'team-randy-carlsen-m', 'christian-heen-carlsen', 'carlsen-m'].sort(),
    );
    for (let i = 1; i < players.length; i++) expect(players[i].games).toBeLessThanOrEqual(players[i - 1].games);
  });

  it('is case-insensitive and matches on the slugified term', async () => {
    expect(ids(await searchPlayers('CARLSEN'))).toEqual(ids(await searchPlayers('carlsen')));
    expect((await searchPlayers('magnus carlsen'))[0].slug).toBe('magnus-carlsen');
  });

  it('honours the limit', async () => {
    const players = await searchPlayers('carlsen', 2);
    expect(players.map((p) => p.slug)).toEqual(['magnus-carlsen', 'henrik-carlsen']);
  });

  it('returns nothing for a term shorter than two characters without querying', async () => {
    expect(await searchPlayers('c')).toEqual([]);
    expect(await searchPlayers('')).toEqual([]);
    expect(await searchPlayers('-')).toEqual([]);
  });
});

describeDb('topPlayers', () => {
  it('returns the players with the most games, most first', async () => {
    const players = await topPlayers(3);
    expect(players.map((p) => [p.id, p.slug, p.games])).toEqual([
      [1, 'hikaru-nakamura', 9331],
      [2, 'alexey-sarana', 8753],
      [3, 'olexandr-bortnyk', 7466],
    ]);
  });
});

// ---- recentEvents / recentTopGames ------------------------------------------------------------

describeDb('recentEvents', () => {
  it('returns the latest events by start date, newest first', async () => {
    const events = await recentEvents(5);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.start_date)).toEqual(['2026-09-27', '2026-09-26', '2026-09-25', '2026-09-25', '2026-09-24']);
    expect(events.slice(0, 2).map((e) => [e.id, e.slug])).toEqual([
      [18001, 'tch-bel-2026-27'],
      [18000, '6th-gambit-gm-closed-2026'],
    ]);
    // The two events starting 2026-09-25 (order between them is not defined).
    expect(events.slice(2, 4).map((e) => e.slug).sort()).toEqual(['hull-4ncl-congress-2026', 'volyn-championship-2026']);
    expect(events[4].slug).toMatch(/^(1st|2nd|3rd)-3-0-thu-24th-sep-2026$/);
  });
});

describeDb('recentTopGames', () => {
  it('returns the most recent games with an average rating of at least 2600, strongest first on a day', async () => {
    const games = await recentTopGames(5);
    expect(games).toHaveLength(5);
    // The 3000 most recent games cover every game of the last date (905 on 2026-09-27), so this is exact.
    expect(ids(games)).toEqual([3546626, 3546630, 3546622, 3546658, 3546623]);
    expect(games.map((g) => g.elo_avg)).toEqual([2760, 2752, 2743, 2740, 2717]);
    for (const g of games) {
      expect(g.elo_avg).toBeGreaterThanOrEqual(2600);
      expect(g.date).toBe('2026-09-27');
      expect(g.white_name).toBeTruthy();
      expect(g.event_slug).toBeTruthy();
    }
  });
});

// ---- gameMoves / getMeta ----------------------------------------------------------------------

describeDb('gameMoves', () => {
  it('returns the moves of the requested games keyed by id', async () => {
    const moves = await gameMoves([GAME_ID, 1000]);
    expect(moves.size).toBe(2);
    expect(moves.get(GAME_ID)).toBe(MOVES_3076939);
    expect(moves.get(1000)).toBe(MOVES_1000);
    expect(moves.get(1000)!.split(' ')).toHaveLength(117); // plies of game 1000
  });

  it('leaves out ids that do not exist and returns an empty map for no ids', async () => {
    expect((await gameMoves([999999999])).size).toBe(0);
    const mixed = await gameMoves([999999999, 1000]);
    expect([...mixed.keys()]).toEqual([1000]);
    expect((await gameMoves([])).size).toBe(0);
  });
});

describeDb('getMeta', () => {
  it('returns the totals from the meta table as numbers', async () => {
    const meta = await getMeta();
    expect(meta.games).toBe(3547522);
    expect(meta.players).toBe(120492);
    expect(meta.events).toBe(17617);
    expect(meta.first_issue).toBe(920);
    expect(meta.last_issue).toBe(1664);
  });
});

// ---- headToHead -------------------------------------------------------------------------------

describeDb('headToHead', () => {
  it('returns all games between two players newest first, in either colour, including the fixture game', async () => {
    const games = await headToHead(PRAGG_ID, RAPPORT_ID);
    expect(ids(games)).toEqual(H2H_IDS);
    expect(games).toHaveLength(10);
    expect(games.find((g) => g.id === GAME_ID)).toMatchObject({ white_name: 'Praggnanandhaa R', black_name: 'Richard Rapport', result: '0-1' });
  });

  it('is symmetric in the order of its arguments', async () => {
    const [ab, ba] = await Promise.all([headToHead(PRAGG_ID, RAPPORT_ID), headToHead(RAPPORT_ID, PRAGG_ID)]);
    expect(ids(ba)).toEqual(ids(ab));
    expect(ba).toEqual(ab);
  });

  it('honours the limit', async () => {
    expect(ids(await headToHead(RAPPORT_ID, PRAGG_ID, 3))).toEqual(H2H_IDS.slice(0, 3));
  });

  it('returns nothing for two players who never met', async () => {
    expect(await headToHead(PRAGG_ID, 999999999)).toEqual([]);
  });
});

// ---- gamePath ---------------------------------------------------------------------------------

describeDb('gamePath', () => {
  it('builds the canonical path of game 3076939 from its row', async () => {
    const g = await getGame(GAME_ID);
    expect(gamePath(g!)).toBe('/games/3076939-r-vs-rapport-2nd-uzchess-cup-masters-2025/');
  });

  it('does not repeat the year when the event name already has it', async () => {
    const { games } = (await getEventWithGames('46th-olympiad-2026'))!;
    expect(gamePath({ ...games[0], date: games[0].date })).toBe('/games/3531411-christie-vs-abdusattorov-46th-olympiad-2026/');
  });
});

// ---- twicIssueDate (pure, runs without the database) ------------------------------------------

describe('twicIssueDate', () => {
  it('starts at issue 920 on 2012-06-25 and adds a week per issue', () => {
    expect(twicIssueDate(920)).toBe('2012-06-25');
    expect(twicIssueDate(921)).toBe('2012-07-02');
    expect(twicIssueDate(1664)).toBe('2026-09-28');
  });

  it('always lands on a Monday', () => {
    for (const n of [920, 1000, 1599, 1663, 1664]) expect(new Date(twicIssueDate(n)).getUTCDay()).toBe(1);
  });
});
