// Unit tests for src/lib/event.ts: the small helpers (parseRound, whiteScore, pts, performance),
// format detection in analyseEvent (round robin, double round robin, Swiss, knockout, match, team,
// loose games), individual standings with tie-breaks worked out by hand for a 4-player round robin,
// coverage/complete, team matches/standings/rosters, knockout brackets, highlights, winners(),
// roundStory() and FORMAT_LABEL. All fixtures are hand-built; no database or network.
import { describe, expect, it } from 'vitest';
import {
  analyseEvent,
  FORMAT_LABEL,
  highlights,
  parseRound,
  performance as perfRating,
  pts,
  roundStory,
  whiteScore,
  winners,
  type EventGame,
} from '../src/lib/event';

// ---- fixtures ---------------------------------------------------------------------------------

const NAMES = ['', 'Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi'];

function game(id: number, w: number, b: number, result: string, round: string | null, extra: Partial<EventGame> = {}): EventGame {
  return {
    id,
    white_id: w,
    black_id: b,
    white_elo: null,
    black_elo: null,
    white_title: null,
    black_title: null,
    result,
    date: null,
    round,
    plies: 80,
    eco: null,
    opening: null,
    opening_name: null,
    white_team: null,
    black_team: null,
    white_name: NAMES[w],
    white_slug: NAMES[w].toLowerCase(),
    white_fed: null,
    black_name: NAMES[b],
    black_slug: NAMES[b].toLowerCase(),
    black_fed: null,
    event_name: 'Test Open',
    event_slug: 'test-open',
    ...extra,
  };
}

/** Sets white_elo/black_elo from a player id -> rating map (players missing from it stay unrated). */
const withElos = (games: EventGame[], elo: Record<number, number>) =>
  games.map((g) => ({ ...g, white_elo: elo[g.white_id] ?? null, black_elo: elo[g.black_id] ?? null }));

const ids = (games: EventGame[]) => games.map((g) => g.id);

const RR_ELO = { 1: 2500, 2: 2400, 3: 2300, 4: 2200 };

// 4-player single round robin (Berger pairings): Alice 1, Bob 2, Carol 3, Dave 4.
//   R1: Alice beat Dave, Bob–Carol drew.   R2: Dave–Carol drew, Bob beat Alice.   R3: Bob–Dave drew, Alice beat Carol.
// Final: Bob 2 (SB 3), Alice 2 (SB 2), Carol 1 (SB 1½), Dave 1 (SB 1½).
const roundRobin = () =>
  withElos(
    [
      game(1, 1, 4, '1-0', '1', { date: '2024-01-10' }),
      game(2, 2, 3, '1/2-1/2', '1', { date: '2024-01-10' }),
      game(3, 4, 3, '1/2-1/2', '2', { date: '2024-01-11' }),
      game(4, 1, 2, '0-1', '2', { date: '2024-01-12' }),
      game(5, 2, 4, '1/2-1/2', '3', { date: '2024-01-13' }),
      game(6, 3, 1, '0-1', '3', { date: '2024-01-13' }),
    ],
    RR_ELO,
  );

// The same six pairings again with colours reversed (rounds 4–6).
const doubleRoundRobin = () => [
  ...roundRobin(),
  ...withElos(
    [
      game(7, 4, 1, '0-1', '4'),
      game(8, 3, 2, '1/2-1/2', '4'),
      game(9, 3, 4, '1-0', '5'),
      game(10, 2, 1, '1/2-1/2', '5'),
      game(11, 4, 2, '1/2-1/2', '6'),
      game(12, 1, 3, '1-0', '6'),
    ],
    RR_ELO,
  ),
];

// 8-player, 3-round Swiss: nobody meets twice and only 12 of the 28 pairs play. Bob and Carol are
// rated so their tie on points, Buchholz and SB is broken by rating.
const swiss = () =>
  withElos(
    [
      game(1, 1, 5, '1-0', '1'),
      game(2, 2, 6, '1-0', '1'),
      game(3, 3, 7, '1/2-1/2', '1'),
      game(4, 4, 8, '0-1', '1'),
      game(5, 1, 2, '1-0', '2'),
      game(6, 8, 3, '1-0', '2'),
      game(7, 7, 5, '1/2-1/2', '2'),
      game(8, 6, 4, '1-0', '2'),
      game(9, 8, 1, '1/2-1/2', '3'),
      game(10, 2, 7, '1/2-1/2', '3'),
      game(11, 6, 3, '0-1', '3'),
      game(12, 5, 4, '1-0', '3'),
    ],
    { 2: 2200, 3: 2300 },
  );

// Knockout: two 2-game semi-finals (tags round.match.game) and a 2-game final Alice–Dave.
const knockout = (final: [string, string] = ['1-0', '1/2-1/2']) =>
  withElos(
    [
      game(1, 3, 4, '0-1', '1.2.1'),
      game(2, 4, 3, '1/2-1/2', '1.2.2'),
      game(3, 1, 2, '1-0', '1.1.1'),
      game(4, 2, 1, '1/2-1/2', '1.1.2'),
      game(5, 1, 4, final[0], '2.1.1'),
      game(6, 4, 1, final[1], '2.1.2'),
    ],
    RR_ELO,
  );

// Four-game match Alice–Bob, one game per round.
const match = (round = true) =>
  withElos(
    [
      game(1, 1, 2, '1-0', round ? '1' : null),
      game(2, 2, 1, '1/2-1/2', round ? '2' : null),
      game(3, 1, 2, '1/2-1/2', round ? '3' : null),
      game(4, 2, 1, '0-1', round ? '4' : null),
    ],
    RR_ELO,
  );

// Team league, 4 teams of 2 boards, 3 rounds ('r.m' = round r, match m). Everyone rated 2000.
//   Alpha: Alice, Bob   Bravo: Carol, Dave   Charlie: Eve, Frank   Delta: Grace, Heidi
const teamGame = (id: number, w: number, b: number, result: string, round: string, wt: string, bt: string) =>
  game(id, w, b, result, round, { white_team: wt, black_team: bt, white_elo: 2000, black_elo: 2000 });
const teamEvent = () => [
  teamGame(1, 1, 3, '1-0', '1.1', 'Alpha', 'Bravo'),
  teamGame(2, 4, 2, '1/2-1/2', '1.1', 'Bravo', 'Alpha'),
  teamGame(3, 5, 7, '0-1', '1.2', 'Charlie', 'Delta'),
  teamGame(4, 8, 6, '1-0', '1.2', 'Delta', 'Charlie'),
  teamGame(5, 5, 1, '1/2-1/2', '2.1', 'Charlie', 'Alpha'),
  teamGame(6, 2, 6, '1/2-1/2', '2.1', 'Alpha', 'Charlie'),
  teamGame(7, 7, 3, '1-0', '2.2', 'Delta', 'Bravo'),
  teamGame(8, 4, 8, '0-1', '2.2', 'Bravo', 'Delta'),
  teamGame(9, 1, 7, '1/2-1/2', '3.1', 'Alpha', 'Delta'),
  teamGame(10, 8, 2, '0-1', '3.1', 'Delta', 'Alpha'),
  teamGame(11, 3, 5, '1-0', '3.2', 'Bravo', 'Charlie'),
  teamGame(12, 6, 4, '1/2-1/2', '3.2', 'Charlie', 'Bravo'),
];

// Games with no usable Round tags and more than two players.
const loose = () => [game(1, 1, 2, '1-0', null), game(2, 2, 3, '1/2-1/2', null), game(3, 3, 1, '0-1', '?')];

// ---- helpers ----------------------------------------------------------------------------------

describe('parseRound', () => {
  it('reads a plain round number', () => {
    expect(parseRound('5')).toEqual({ n: 5, sub: [] });
  });
  it('reads round.board / round.match', () => {
    expect(parseRound('5.3')).toEqual({ n: 5, sub: [3] });
  });
  it('reads knockout round.match.game', () => {
    expect(parseRound('5.3.2')).toEqual({ n: 5, sub: [3, 2] });
  });
  it('returns no round for null, empty and junk', () => {
    expect(parseRound(null)).toEqual({ n: null, sub: [] });
    expect(parseRound('')).toEqual({ n: null, sub: [] });
    expect(parseRound('?')).toEqual({ n: null, sub: [] });
    expect(parseRound('junk')).toEqual({ n: null, sub: [] });
    expect(parseRound('-1')).toEqual({ n: null, sub: [] });
  });
  it('accepts 1..60 only', () => {
    expect(parseRound('0')).toEqual({ n: null, sub: [] });
    expect(parseRound('1')).toEqual({ n: 1, sub: [] });
    expect(parseRound('60')).toEqual({ n: 60, sub: [] });
    expect(parseRound('61')).toEqual({ n: null, sub: [] });
  });
  it('tolerates leading whitespace and trailing text', () => {
    expect(parseRound(' 7')).toEqual({ n: 7, sub: [] });
    expect(parseRound('7a')).toEqual({ n: 7, sub: [] });
    expect(parseRound('7.')).toEqual({ n: 7, sub: [] });
  });
});

describe('whiteScore', () => {
  it('scores results from white’s side', () => {
    expect(whiteScore('1-0')).toBe(1);
    expect(whiteScore('0-1')).toBe(0);
    expect(whiteScore('1/2-1/2')).toBe(0.5);
  });
  it('gives an unfinished or unknown result no score', () => {
    expect(whiteScore('*')).toBeNull();
    expect(whiteScore('')).toBeNull();
  });
});

describe('pts', () => {
  it('formats whole and half points', () => {
    expect(pts(0)).toBe('0');
    expect(pts(0.5)).toBe('½');
    expect(pts(1)).toBe('1');
    expect(pts(1.5)).toBe('1½');
    expect(pts(10)).toBe('10');
    expect(pts(10.5)).toBe('10½');
  });
  it('survives floating-point sums of halves', () => {
    expect(pts(0.5 + 0.5 + 0.5)).toBe('1½');
    expect(pts(0.1 + 0.2 + 0.7)).toBe('1');
  });
});

describe('performance', () => {
  it('needs at least three rated opponents', () => {
    expect(perfRating([], 0)).toBeNull();
    expect(perfRating([2000, 2100], 2)).toBeNull();
    expect(perfRating([2000, 2100, 2200], 1.5)).not.toBeNull();
  });
  it('is the opponents’ average at 50%', () => {
    expect(perfRating([2000, 2000, 2000], 1.5)).toBe(2000);
    expect(perfRating([2001, 2002, 2004], 1.5)).toBe(2002);
  });
  it('adds ±800 for 100% and 0%', () => {
    expect(perfRating([2000, 2000, 2000], 3)).toBe(2800);
    expect(perfRating([2000, 2000, 2000], 0)).toBe(1200);
  });
  it('rounds the percentage half up before the table lookup, on both sides of 50%', () => {
    // 17/40 = 42.5% -> 43% -> dp -50 (rounding |p - 50%| instead would give 8 and -57).
    expect(perfRating(Array(40).fill(2000), 17)).toBe(1950);
    // 23/40 = 57.5% -> 58% -> dp +57.
    expect(perfRating(Array(40).fill(2000), 23)).toBe(2057);
  });
  it('uses the FIDE table in between', () => {
    // p = 0.75 -> +193; p = 0.25 -> -193; p = 0.60 -> +72; p = 0.57 -> +50.
    expect(perfRating([2400, 2500, 2600, 2700], 3)).toBe(2743);
    expect(perfRating([2400, 2500, 2600, 2700], 1)).toBe(2357);
    expect(perfRating([2000, 2000, 2000, 2000, 2000], 3)).toBe(2072);
    expect(perfRating([2000, 2000, 2000, 2000, 2000, 2000, 2000], 4)).toBe(2050);
  });
});

describe('FORMAT_LABEL', () => {
  it('has a label for every format', () => {
    expect(FORMAT_LABEL).toEqual({
      'round-robin': 'Round robin',
      swiss: 'Swiss',
      knockout: 'Knockout',
      match: 'Match',
      team: 'Team event',
      games: 'Games',
    });
  });
});

// ---- analyseEvent: formats --------------------------------------------------------------------

describe('analyseEvent format detection', () => {
  it('single round robin: 4 players, 3 rounds, one cycle', () => {
    const a = analyseEvent(roundRobin(), null);
    expect(a.format).toBe('round-robin');
    expect(a.cycles).toBe(1);
    expect(a.players.size).toBe(4);
    expect(a.rounds.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(a.coverage).toBe(1);
    expect(a.complete).toBe(true);
  });
  it('double round robin: two cycles', () => {
    const a = analyseEvent(doubleRoundRobin(), null);
    expect(a.format).toBe('round-robin');
    expect(a.cycles).toBe(2);
    expect(a.rounds.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.coverage).toBe(1);
    expect(a.complete).toBe(true);
  });
  it('Swiss: more players than rounds, not everyone meets', () => {
    const a = analyseEvent(swiss(), null);
    expect(a.format).toBe('swiss');
    expect(a.cycles).toBe(1);
    expect(a.players.size).toBe(8);
    expect(a.rounds).toHaveLength(3);
    expect(a.coverage).toBe(1);
    expect(a.complete).toBe(true);
  });
  it('knockout from three-part Round tags', () => {
    expect(analyseEvent(knockout(), null).format).toBe('knockout');
  });
  it('knockout from the "k.o" type hint', () => {
    // Single-game matches with two-part tags carry no structural hint, so the type decides.
    const games = [game(1, 1, 2, '1-0', '1.1'), game(2, 3, 4, '1-0', '1.2'), game(3, 1, 3, '1-0', '2.1')];
    expect(analyseEvent(games, null).format).toBe('swiss');
    expect(analyseEvent(games, 'K.O. tournament').format).toBe('knockout');
  });
  it('knockout from repeated pairings within a round', () => {
    const games = knockout().map((g) => ({ ...g, round: g.round!.split('.')[0] }));
    expect(games.map((g) => g.round)).toEqual(['1', '1', '1', '1', '2', '2']);
    expect(analyseEvent(games, null).format).toBe('knockout');
  });
  it('match: two players, several games', () => {
    expect(analyseEvent(match(), null).format).toBe('match');
    expect(analyseEvent(match(false), null).format).toBe('match');
    expect(analyseEvent(match(), 'match').format).toBe('match');
  });
  it('a single game is not a match (unless the event says so)', () => {
    const one = analyseEvent([game(1, 1, 2, '1-0', '1')], null);
    expect(one.format).toBe('games');
    expect(winners(one)).toEqual([]);
    expect(analyseEvent([game(1, 1, 2, '1-0', '1')], 'match').format).toBe('match');
    // Playoffs and tiebreak matches are often typed like the tournament they belong to.
    expect(analyseEvent(match(), 'swiss').format).toBe('match');
  });
  it('team event from team tags on most games', () => {
    expect(analyseEvent(teamEvent(), null).format).toBe('team');
    const oneUntagged = teamEvent().map((g) => (g.id === 12 ? { ...g, white_team: null, black_team: null } : g));
    expect(analyseEvent(oneUntagged, null).format).toBe('team');
  });
  it('team tags alone don’t make a team event: an individual Swiss with countries as teams', () => {
    // Germany meets Turkey and Belgium in round 1, on one board each: player pairings, not team matches.
    const t = (id: number, w: number, b: number, result: string, round: string, wt: string, bt: string) => game(id, w, b, result, round, { white_team: wt, black_team: bt });
    const swissByCountry = [
      t(1, 1, 3, '1-0', '1.1', 'Germany', 'Turkey'),
      t(2, 4, 2, '0-1', '1.2', 'Belgium', 'Germany'),
      t(3, 5, 7, '1/2-1/2', '1.3', 'Belgium', 'Netherlands'),
      t(4, 6, 8, '1-0', '1.4', 'Turkey', 'Netherlands'),
      t(5, 1, 2, '1/2-1/2', '2.1', 'Germany', 'Germany'),
      t(6, 6, 4, '1-0', '2.2', 'Turkey', 'Belgium'),
      t(7, 3, 5, '0-1', '2.3', 'Turkey', 'Belgium'),
      t(8, 8, 7, '1/2-1/2', '2.4', 'Netherlands', 'Netherlands'),
    ];
    const a = analyseEvent(swissByCountry, 'swiss');
    expect(a.format).toBe('swiss');
    expect(a.teams).toBeUndefined();
    expect(a.standingsAfter(Infinity)[0].player.name).toBe('Frank');
  });
  it('games: no usable Round tags and more than two players', () => {
    const a = analyseEvent(loose(), null);
    expect(a.format).toBe('games');
    expect(a.rounds).toEqual([]);
    expect(a.coverage).toBe(0);
    expect(a.complete).toBe(true);
  });
  it('empty input', () => {
    const a = analyseEvent([], null);
    expect(a.format).toBe('games');
    expect(a.players.size).toBe(0);
    expect(a.rounds).toEqual([]);
    expect(a.standingsAfter(Infinity)).toEqual([]);
    expect(a.highlights).toEqual([]);
    expect(a.stats).toEqual({ games: 0, white: 0, draws: 0, black: 0, avgMoves: 0, topOpening: null });
    expect(a.avgElo).toBeNull();
    expect(a.category).toBeNull();
    expect(winners(a)).toEqual([]);
  });
});

describe('analyseEvent players and rounds', () => {
  it('collects players with rating (mode), title and team', () => {
    const games = [
      game(1, 1, 2, '1-0', '1', { white_elo: 2500, black_elo: 2400, white_title: 'GM' }),
      game(2, 2, 1, '1-0', '2', { white_elo: 2400, black_elo: 2510, black_title: null }),
      game(3, 1, 2, '1-0', '3', { white_elo: 2500, black_elo: null, white_team: 'Alpha', black_team: 'Bravo' }),
    ];
    const a = analyseEvent(games, null);
    expect(a.players.get(1)).toEqual({ id: 1, name: 'Alice', slug: 'alice', title: 'GM', fed: null, elo: 2500, team: 'Alpha' });
    expect(a.players.get(2)).toEqual({ id: 2, name: 'Bob', slug: 'bob', title: null, fed: null, elo: 2400, team: 'Bravo' });
  });
  it('orders rounds by number with first/last dates', () => {
    const a = analyseEvent(roundRobin(), null);
    expect(a.rounds[0]).toMatchObject({ n: 1, first: '2024-01-10', last: '2024-01-10' });
    expect(a.rounds[1]).toMatchObject({ n: 2, first: '2024-01-11', last: '2024-01-12' });
    expect(ids(a.rounds[0].games)).toEqual([1, 2]);
  });
  it('orders the games of a round by board number in individual events', () => {
    // Swap boards 1 and 4 of round 1 via the tags: the board from the tag wins over the id.
    const games = swiss().map((g) => (g.id === 1 ? { ...g, round: '1.4' } : g.id === 4 ? { ...g, round: '1.1' } : g.id <= 4 ? { ...g, round: `1.${g.id}` } : g));
    const a = analyseEvent(games, null);
    expect(a.format).toBe('swiss');
    expect(ids(a.rounds[0].games)).toEqual([4, 2, 3, 1]);
  });
  it('average rating and FIDE category for a round robin', () => {
    const a = analyseEvent(roundRobin(), null);
    expect(a.avgElo).toBe(2350);
    expect(a.category).toBe(4);
    const stronger = analyseEvent(withElos(roundRobin(), { 1: 2500, 2: 2400, 3: 2300, 4: 2204 }), null);
    expect(stronger.avgElo).toBe(2351);
    expect(stronger.category).toBe(5);
    expect(analyseEvent(swiss(), null).category).toBeNull();
  });
});

describe('analyseEvent stats', () => {
  it('counts results, average moves and the top opening family', () => {
    const games = [
      game(1, 1, 2, '1-0', '1', { plies: 61, opening: 'sicilian-defense-najdorf', opening_name: 'Sicilian Defense: Najdorf Variation' }),
      game(2, 3, 4, '0-1', '1', { plies: 40, opening: 'sicilian-defense', opening_name: 'Sicilian Defense' }),
      game(3, 1, 3, '1/2-1/2', '2', { plies: 100, opening: 'french-defense', opening_name: 'French Defense' }),
      game(4, 2, 4, '1/2-1/2', '2', { plies: 20 }),
    ];
    expect(analyseEvent(games, null).stats).toEqual({
      games: 4,
      white: 1,
      black: 1,
      draws: 2,
      avgMoves: 28,
      topOpening: { slug: 'sicilian-defense', name: 'Sicilian Defense', count: 2 },
    });
    expect(analyseEvent(games.slice(2), null).stats.topOpening).toBeNull();
  });
});

// ---- individual standings ---------------------------------------------------------------------

describe('standingsAfter (round robin)', () => {
  const a = analyseEvent(roundRobin(), null);
  const row = (l: ReturnType<typeof a.standingsAfter>[number]) => ({
    name: l.player.name,
    rank: l.rank,
    points: l.points,
    games: l.games,
    wins: l.wins,
    draws: l.draws,
    losses: l.losses,
    sb: l.sb,
    buchholz: l.buchholz,
    perf: l.perf,
  });

  it('before any round: everyone on zero, ordered by rating', () => {
    const s = a.standingsAfter(0);
    expect(s.map((l) => [l.player.name, l.rank, l.points, l.games])).toEqual([
      ['Alice', 1, 0, 0],
      ['Bob', 2, 0, 0],
      ['Carol', 3, 0, 0],
      ['Dave', 4, 0, 0],
    ]);
  });
  it('after round 1', () => {
    expect(a.standingsAfter(1).map(row)).toEqual([
      { name: 'Alice', rank: 1, points: 1, games: 1, wins: 1, draws: 0, losses: 0, sb: 0, buchholz: 0, perf: null },
      { name: 'Bob', rank: 2, points: 0.5, games: 1, wins: 0, draws: 1, losses: 0, sb: 0.25, buchholz: 0.5, perf: null },
      { name: 'Carol', rank: 3, points: 0.5, games: 1, wins: 0, draws: 1, losses: 0, sb: 0.25, buchholz: 0.5, perf: null },
      { name: 'Dave', rank: 4, points: 0, games: 1, wins: 0, draws: 0, losses: 1, sb: 0, buchholz: 1, perf: null },
    ]);
  });
  it('after round 2: Sonneborn-Berger splits Carol and Alice', () => {
    expect(a.standingsAfter(2).map(row)).toEqual([
      { name: 'Bob', rank: 1, points: 1.5, games: 2, wins: 1, draws: 1, losses: 0, sb: 1.5, buchholz: 2, perf: null },
      { name: 'Carol', rank: 2, points: 1, games: 2, wins: 0, draws: 2, losses: 0, sb: 1, buchholz: 2, perf: null },
      { name: 'Alice', rank: 3, points: 1, games: 2, wins: 1, draws: 0, losses: 1, sb: 0.5, buchholz: 2, perf: null },
      { name: 'Dave', rank: 4, points: 0.5, games: 2, wins: 0, draws: 1, losses: 1, sb: 0.5, buchholz: 2, perf: null },
    ]);
  });
  it('after round 3: final table with performance ratings', () => {
    expect(a.standingsAfter(3).map(row)).toEqual([
      { name: 'Bob', rank: 1, points: 2, games: 3, wins: 1, draws: 2, losses: 0, sb: 3, buchholz: 4, perf: 2458 },
      { name: 'Alice', rank: 2, points: 2, games: 3, wins: 2, draws: 0, losses: 1, sb: 2, buchholz: 4, perf: 2425 },
      { name: 'Carol', rank: 3, points: 1, games: 3, wins: 0, draws: 2, losses: 1, sb: 1.5, buchholz: 5, perf: 2242 },
      { name: 'Dave', rank: 4, points: 1, games: 3, wins: 0, draws: 2, losses: 1, sb: 1.5, buchholz: 5, perf: 2275 },
    ]);
  });
  it('standingsAfter(Infinity) is the final table', () => {
    expect(a.standingsAfter(Infinity)).toBe(a.standingsAfter(3));
    expect(a.standingsAfter(99).map(row)).toEqual(a.standingsAfter(3).map(row));
  });
  it('records each result with round, opponent, colour and score', () => {
    const alice = a.standingsAfter(3).find((l) => l.player.id === 1)!;
    expect(alice.results.map((r) => [r.round, r.opp, r.color, r.score, r.game.id])).toEqual([
      [1, 4, 'w', 1, 1],
      [2, 2, 'w', 0, 4],
      [3, 3, 'b', 1, 6],
    ]);
  });
  it('a Swiss ranks by points, Buchholz, SB, then rating', () => {
    const s = analyseEvent(swiss(), null).standingsAfter(Infinity);
    expect(s.map((l) => [l.player.name, l.points, l.buchholz, l.sb])).toEqual([
      ['Alice', 2.5, 5.5, 4.25],
      ['Heidi', 2.5, 4, 2.75],
      ['Carol', 1.5, 5, 1.75],
      ['Bob', 1.5, 5, 1.75],
      ['Grace', 1.5, 4.5, 2.25],
      ['Eve', 1.5, 4, 0.75],
      ['Frank', 1, 3, 0],
      ['Dave', 0, 5, 0],
    ]);
    expect(s.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('complete / coverage', () => {
  it('round robin with one missing game is still a (nearly complete) round robin', () => {
    // 6-player Berger schedule, all draws, without the round-5 game Eve–Alice.
    const schedule: [number, number, number][] = [
      [1, 1, 6], [1, 2, 5], [1, 3, 4],
      [2, 6, 4], [2, 5, 3], [2, 1, 2],
      [3, 2, 6], [3, 3, 1], [3, 4, 5],
      [4, 6, 5], [4, 1, 4], [4, 2, 3],
      [5, 3, 6], [5, 4, 2],
    ];
    const games = schedule.map(([r, w, b], i) => game(i + 1, w, b, '1/2-1/2', String(r)));
    const a = analyseEvent(games, null);
    expect(a.format).toBe('round-robin');
    expect(a.cycles).toBe(1);
    expect(a.coverage).toBeCloseTo(14 / 15, 10);
    expect(a.complete).toBe(true);
  });
  it('double round robin missing a round is incomplete', () => {
    const a = analyseEvent(doubleRoundRobin().slice(0, 10), null);
    expect(a.format).toBe('round-robin');
    expect(a.cycles).toBe(2);
    expect(a.coverage).toBeCloseTo(10 / 12, 10);
    expect(a.complete).toBe(false);
    expect(winners(a)).toEqual([]);
  });
  it('a Swiss with only the top board published is incomplete', () => {
    const games = [game(1, 1, 2, '1-0', '1'), game(2, 3, 4, '1-0', '2'), game(3, 5, 6, '1-0', '3'), game(4, 7, 8, '1-0', '4'), game(5, 1, 3, '1-0', '5')];
    const a = analyseEvent(games, null);
    expect(a.format).toBe('swiss');
    expect(a.coverage).toBeCloseTo(1 / 5, 10);
    expect(a.complete).toBe(false);
    expect(winners(a)).toEqual([]);
  });
});

// ---- team events ------------------------------------------------------------------------------

describe('team analysis', () => {
  const a = analyseEvent(teamEvent(), null);
  const t = a.teams!;

  it('groups boards into matches by round and team pair, boards in id order', () => {
    expect(t.boards).toBe(2);
    expect(t.roundRobin).toBe(true);
    expect(t.matches.map((m) => [m.round, m.home, m.away, m.homePts, m.awayPts, m.complete, ids(m.games)])).toEqual([
      [1, 'Alpha', 'Bravo', 1.5, 0.5, true, [1, 2]],
      [1, 'Charlie', 'Delta', 0, 2, true, [3, 4]],
      [2, 'Charlie', 'Alpha', 1, 1, true, [5, 6]],
      [2, 'Delta', 'Bravo', 2, 0, true, [7, 8]],
      [3, 'Alpha', 'Delta', 1.5, 0.5, true, [9, 10]],
      [3, 'Bravo', 'Charlie', 1.5, 0.5, true, [11, 12]],
    ]);
  });
  it('keeps id order for boards whatever the input order or the match number in the tag', () => {
    const b = analyseEvent([...teamEvent()].reverse(), null).teams!;
    expect(b.matches.map((m) => ids(m.games))).toEqual(t.matches.map((m) => ids(m.games)));
    // '5.3' is round 5, match 3: the match number does not reorder the boards.
    const r5 = [
      teamGame(21, 1, 3, '1-0', '5.3', 'Alpha', 'Bravo'),
      teamGame(20, 4, 2, '1-0', '5.3', 'Bravo', 'Alpha'),
      teamGame(23, 5, 7, '1-0', '5.1', 'Charlie', 'Delta'),
      teamGame(22, 8, 6, '1-0', '5.1', 'Delta', 'Charlie'),
    ];
    const c = analyseEvent(r5, null);
    expect(c.format).toBe('team');
    expect(c.rounds.map((r) => r.n)).toEqual([5]);
    expect(ids(c.rounds[0].games)).toEqual([20, 21, 22, 23]);
    expect(c.teams!.matches.map((m) => [m.round, m.home, m.away, ids(m.games)])).toEqual([
      [5, 'Bravo', 'Alpha', [20, 21]],
      [5, 'Delta', 'Charlie', [22, 23]],
    ]);
  });
  it('marks a match with fewer boards than usual as incomplete', () => {
    const b = analyseEvent(teamEvent().slice(0, 11), null).teams!;
    expect(b.boards).toBe(2);
    expect(b.matches.at(-1)).toMatchObject({ home: 'Bravo', away: 'Charlie', homePts: 1, awayPts: 0, complete: false });
    expect(b.matches.filter((m) => !m.complete)).toHaveLength(1);
  });
  it('a match the missing board could still turn gets game points but no match points', () => {
    const b = analyseEvent(teamEvent().slice(0, 11), null);
    expect(b.complete).toBe(false);
    expect(b.teams!.matches.at(-1)).toMatchObject({ complete: false, decided: false });
    const row = (l: ReturnType<typeof t.standingsAfter>[number]) => [l.team, l.rank, l.mp, l.gp, l.played, l.w, l.d, l.l];
    expect(b.teams!.standingsAfter(3).map(row)).toEqual([
      ['Alpha', 1, 5, 4, 3, 2, 1, 0],
      ['Delta', 2, 4, 4.5, 3, 2, 0, 1],
      ['Charlie', 3, 1, 1, 3, 0, 1, 1],
      ['Bravo', 4, 0, 1.5, 3, 0, 0, 2],
    ]);
  });
  it('a partial match whose winner is settled still counts', () => {
    // Three boards; round 2 has two, both won by Alpha: 2–0 with one board open is a win whatever it was.
    const games = [
      teamGame(1, 1, 4, '1-0', '1.1', 'Alpha', 'Bravo'),
      teamGame(2, 5, 2, '0-1', '1.1', 'Bravo', 'Alpha'),
      teamGame(3, 3, 6, '0-1', '1.1', 'Alpha', 'Bravo'),
      teamGame(4, 4, 1, '0-1', '2.1', 'Bravo', 'Alpha'),
      teamGame(5, 2, 5, '1-0', '2.1', 'Alpha', 'Bravo'),
    ];
    const c = analyseEvent(games, null);
    expect(c.format).toBe('team');
    expect(c.teams!.boards).toBe(3);
    expect(c.teams!.matches.map((m) => [m.round, m.homePts, m.awayPts, m.complete, m.decided])).toEqual([
      [1, 2, 1, true, true],
      [2, 0, 2, false, true],
    ]);
    expect(c.teams!.standingsAfter(2).map((l) => [l.team, l.mp, l.gp, l.w, l.l])).toEqual([
      ['Alpha', 4, 4, 2, 0],
      ['Bravo', 0, 1, 0, 2],
    ]);
  });
  it('an unfinished board leaves the match open and scores for nobody', () => {
    const games = teamEvent().map((g) => (g.id === 2 ? { ...g, result: '*' } : g));
    const m = analyseEvent(games, null).teams!.matches[0];
    expect([m.homePts, m.awayPts, m.complete, m.decided]).toEqual([1, 0, false, false]);
  });
  it('a round without any match between two teams has no story (and no crash)', () => {
    // Round 1 only has club-internal games; rounds 2 and 3 are team matches.
    const games = teamEvent().map((g) => (g.id <= 4 ? { ...g, black_team: g.white_team } : g));
    const c = analyseEvent(games, null);
    expect(c.format).toBe('team');
    expect(c.teams!.standingsAfter(1)).toEqual([]);
    expect(roundStory(c, 1)).toEqual([]);
    expect(roundStory(c, 2)).toHaveLength(2);
  });
  it('standings after each round: match points, game points, ranking', () => {
    const row = (l: ReturnType<typeof t.standingsAfter>[number]) => [l.team, l.rank, l.mp, l.gp, l.played, l.w, l.d, l.l];
    expect(t.standingsAfter(1).map(row)).toEqual([
      ['Delta', 1, 2, 2, 1, 1, 0, 0],
      ['Alpha', 2, 2, 1.5, 1, 1, 0, 0],
      ['Bravo', 3, 0, 0.5, 1, 0, 0, 1],
      ['Charlie', 4, 0, 0, 1, 0, 0, 1],
    ]);
    expect(t.standingsAfter(2).map(row)).toEqual([
      ['Delta', 1, 4, 4, 2, 2, 0, 0],
      ['Alpha', 2, 3, 2.5, 2, 1, 1, 0],
      ['Charlie', 3, 1, 1, 2, 0, 1, 1],
      ['Bravo', 4, 0, 0.5, 2, 0, 0, 2],
    ]);
    expect(t.standingsAfter(3).map(row)).toEqual([
      ['Alpha', 1, 5, 4, 3, 2, 1, 0],
      ['Delta', 2, 4, 4.5, 3, 2, 0, 1],
      ['Bravo', 3, 2, 2, 3, 1, 0, 2],
      ['Charlie', 4, 1, 1.5, 3, 0, 1, 2],
    ]);
    expect(t.standingsAfter(Infinity).map(row)).toEqual(t.standingsAfter(3).map(row));
    expect(t.standingsAfter(0)).toEqual([]);
  });
  it('lists each team’s matches from its own side', () => {
    const alpha = t.standingsAfter(3).find((l) => l.team === 'Alpha')!;
    expect(alpha.matches.map((m) => [m.round, m.opp, m.my, m.their])).toEqual([
      [1, 'Bravo', 1.5, 0.5],
      [2, 'Charlie', 1, 1],
      [3, 'Delta', 1.5, 0.5],
    ]);
  });
  it('rosters: usual board, games, points and performance', () => {
    const line = (r: { player: { name: string }; board: number; games: number; points: number; perf: number | null }) => [r.player.name, r.board, r.games, r.points, r.perf];
    expect(t.rosters.get('Alpha')!.map(line)).toEqual([
      ['Alice', 1, 3, 2, 2125],
      ['Bob', 2, 3, 2, 2125],
    ]);
    // Grace played board 2 once and board 1 twice; 2½/3 against 2000-rated opponents.
    expect(t.rosters.get('Delta')!.map(line)).toEqual([
      ['Grace', 1, 3, 2.5, 2273],
      ['Heidi', 2, 3, 2, 2125],
    ]);
    expect([...t.rosters.keys()].sort()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });
  it('players carry their team', () => {
    expect(a.players.get(1)!.team).toBe('Alpha');
    expect(a.players.get(8)!.team).toBe('Delta');
  });
  it('winners: the top team', () => {
    expect(winners(a)).toEqual(['Alpha']);
  });
  it('round stories follow the leaders', () => {
    expect(roundStory(a, 1)).toEqual(['Delta beat Charlie 2–0.', 'Delta and Alpha share the lead on 2 match points.']);
    expect(roundStory(a, 2)).toEqual(['Delta beat Bravo 2–0.', 'Delta lead with 4 match points.']);
    expect(roundStory(a, 3)).toEqual(['Alpha beat Delta 1½–½.', 'Alpha finish first with 5 match points.']);
    expect(roundStory(a, 4)).toEqual([]);
  });
});

// ---- knockouts and matches --------------------------------------------------------------------

describe('knockout analysis', () => {
  it('builds rounds with matches in tag order and games in id order', () => {
    const ko = analyseEvent(knockout(), 'k.o').knockout!;
    expect(ko.map((r) => [r.n, r.name, r.matches.length])).toEqual([
      [1, 'Semi-finals', 2],
      [2, 'Final', 1],
    ]);
    // Match 1 (Alice–Bob) has the higher ids but the lower match number in '1.1.x'.
    expect(ko[0].matches.map((m) => [m.a.name, m.b.name, m.aPts, m.bPts, m.winner, ids(m.games)])).toEqual([
      ['Alice', 'Bob', 1.5, 0.5, 1, [3, 4]],
      ['Carol', 'Dave', 0.5, 1.5, 4, [1, 2]],
    ]);
    expect(ko[1].matches[0]).toMatchObject({ round: 2, aPts: 1.5, bPts: 0.5, winner: 1 });
    expect(ko[1].matches[0].a.name).toBe('Alice');
    expect(ko[1].matches[0].b.name).toBe('Dave');
  });
  it('a tied match has no winner', () => {
    const a = analyseEvent(knockout(['1-0', '1-0']), 'k.o');
    expect(a.knockout![1].matches[0]).toMatchObject({ aPts: 1, bPts: 1, winner: null });
    expect(winners(a)).toEqual([]);
    expect(roundStory(a, 2)).toEqual(['Alice and Dave are level 1–1 in the games in the database.']);
  });
  it('an unfinished game scores for nobody', () => {
    const a = analyseEvent([...match(), game(5, 1, 2, '*', '5')], null);
    expect(a.knockout![0].matches[0]).toMatchObject({ aPts: 3, bPts: 1, winner: 1 });
  });
  it('a level match goes to the player seen in the next round', () => {
    // Semi-final Alice–Bob 1–1, and Alice plays the final.
    const a = analyseEvent(knockout().map((g) => (g.id === 4 ? { ...g, result: '1-0' } : g)), 'k.o');
    expect(a.knockout![0].matches[0]).toMatchObject({ aPts: 1, bPts: 1, winner: 1 });
  });
  it('an odd number of games ending in a draw is won by Black of the last game (armageddon)', () => {
    const games = [...knockout(['1-0', '1-0']), game(7, 1, 4, '1/2-1/2', '2.1.3')];
    const a = analyseEvent(withElos(games, RR_ELO), 'k.o');
    expect(a.knockout![1].matches[0]).toMatchObject({ aPts: 1.5, bPts: 1.5, winner: 4 });
    expect(winners(a)).toEqual(['Dave']);
    expect(roundStory(a, 2)).toEqual(['Dave beat Alice in the final on tiebreak after 1½–1½.']);
  });
  it('a last round of several matches is not a final: no winner', () => {
    const games = [game(1, 1, 8, '1-0', '1.1.1'), game(2, 2, 7, '1-0', '1.2.1'), game(3, 3, 6, '1-0', '1.3.1'), game(4, 4, 5, '1-0', '1.4.1')];
    const a = analyseEvent(games, 'k.o');
    expect(a.format).toBe('knockout');
    expect(a.knockout!.map((r) => [r.name, r.matches.length])).toEqual([['Round 1', 4]]);
    expect(winners(a)).toEqual([]);
    expect(roundStory(a, 1)).toEqual(['4 matches.']);
  });
  it('names quarter-finals, semi-finals and final', () => {
    const games = [
      game(1, 1, 8, '1-0', '1.1.1'),
      game(2, 2, 7, '1-0', '1.2.1'),
      game(3, 3, 6, '1-0', '1.3.1'),
      game(4, 4, 5, '1-0', '1.4.1'),
      game(5, 1, 4, '1-0', '2.1.1'),
      game(6, 2, 3, '1-0', '2.2.1'),
      game(7, 1, 2, '1-0', '3.1.1'),
    ];
    const a = analyseEvent(games, null);
    expect(a.format).toBe('knockout');
    expect(a.knockout!.map((r) => [r.name, r.matches.length])).toEqual([
      ['Quarter-finals', 4],
      ['Semi-finals', 2],
      ['Final', 1],
    ]);
    expect(winners(a)).toEqual(['Alice']);
  });
  it('puts the final before the third-place match', () => {
    const games = [game(1, 1, 2, '1-0', '1.1.1'), game(2, 3, 4, '1-0', '1.2.1'), game(3, 2, 4, '1-0', '2.1.1'), game(4, 1, 3, '1-0', '2.2.1')];
    const a = analyseEvent(games, null);
    expect(a.knockout!.map((r) => r.name)).toEqual(['Semi-finals', 'Final and third place']);
    expect(a.knockout![1].matches.map((m) => [m.a.name, m.b.name])).toEqual([
      ['Alice', 'Carol'],
      ['Bob', 'Dave'],
    ]);
    expect(winners(a)).toEqual(['Alice']);
    expect(roundStory(a, 2)).toEqual(['Alice beat Carol 1–0 in the final.']);
  });
  it('winners and round stories', () => {
    const a = analyseEvent(knockout(), 'k.o');
    expect(winners(a)).toEqual(['Alice']);
    expect(roundStory(a, 1)).toEqual(['2 matches.', 'Upsets: Dave knocked out Carol.']);
    expect(roundStory(a, 2)).toEqual(['Alice beat Dave 1½–½ in the final.']);
  });
});

describe('match analysis', () => {
  it('is one knockout round with every game', () => {
    for (const games of [match(), match(false)]) {
      const a = analyseEvent(games, null);
      expect(a.format).toBe('match');
      expect(a.knockout).toHaveLength(1);
      expect(a.knockout![0]).toMatchObject({ n: 1, name: 'Match' });
      const m = a.knockout![0].matches[0];
      expect([m.a.name, m.b.name, m.aPts, m.bPts, m.winner, ids(m.games)]).toEqual(['Alice', 'Bob', 3, 1, 1, [1, 2, 3, 4]]);
      expect(winners(a)).toEqual(['Alice']);
    }
    expect(analyseEvent(match(), null).rounds.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(analyseEvent(match(false), null).rounds).toEqual([]);
  });
  it('story: each game and the running score, the result after the last game', () => {
    const a = analyseEvent(match(), null);
    expect(roundStory(a, 1)).toEqual(['Alice won game 1 with White.', 'Alice leads 1–0.']);
    expect(roundStory(a, 2)).toEqual(['Game 2 was drawn.', 'Alice leads 1½–½.']);
    expect(roundStory(a, 4)).toEqual(['Alice won game 4 with Black.', 'Alice wins the match 3–1.']);
    const level = analyseEvent(match().map((g) => (g.id === 1 ? { ...g, result: '0-1' } : g)), null);
    expect(roundStory(level, 1)).toEqual(['Bob won game 1 with Black.', 'Bob leads 1–0.']);
    expect(roundStory(level, 4)).toEqual(['Alice won game 4 with Black.', 'The match ends level, 2–2.']);
    const unfinished = analyseEvent([...match(), game(5, 1, 2, '*', '5')], null);
    expect(roundStory(unfinished, 5)).toEqual(['Game 5 has no result yet.', 'Alice wins the match 3–1.']);
  });
});

// ---- highlights ---------------------------------------------------------------------------------

describe('highlights', () => {
  it('is empty with no games', () => {
    expect(highlights([])).toEqual([]);
  });
  it('is empty for ordinary drawn games', () => {
    expect(highlights([game(1, 1, 2, '1/2-1/2', '1', { white_elo: 2000, black_elo: 2400 })])).toEqual([]);
  });
  it('picks the biggest upset, the longest game and the quickest win', () => {
    const games = [
      game(1, 1, 2, '1-0', '1', { white_elo: 2200, black_elo: 2400, plies: 80 }),
      game(2, 3, 4, '0-1', '1', { white_elo: 2450, black_elo: 2300, plies: 70 }),
      game(3, 1, 3, '1/2-1/2', '2', { plies: 150 }),
      game(4, 2, 4, '0-1', '2', { plies: 41 }),
    ];
    expect(highlights(games).map((h) => [h.label, h.game.id, h.note])).toEqual([
      ['Biggest upset', 1, 'won against a player rated 200 points higher'],
      ['Longest game', 3, '75 moves'],
      ['Quickest win', 4, '21 moves'],
    ]);
  });
  it('an upset needs a rating gap of at least 100', () => {
    const at = (gap: number) => highlights([game(1, 1, 2, '0-1', '1', { white_elo: 2300 + gap, black_elo: 2300 })]).map((h) => h.label);
    expect(at(100)).toEqual(['Biggest upset']);
    expect(at(99)).toEqual([]);
  });
  it('the longest game needs 120 plies', () => {
    const at = (plies: number) => highlights([game(1, 1, 2, '1/2-1/2', '1', { plies })]).map((h) => [h.label, h.note]);
    expect(at(120)).toEqual([['Longest game', '60 moves']]);
    expect(at(119)).toEqual([]);
  });
  it('unfinished games are never a quickest win, an upset or the longest game', () => {
    const h = highlights([
      game(1, 1, 2, '*', '1', { plies: 20, white_elo: 2000, black_elo: 2500 }),
      game(2, 3, 4, '*', '1', { plies: 200 }),
      game(3, 5, 6, '1-0', '1', { plies: 50 }),
    ]);
    expect(h.map((x) => [x.label, x.game.id])).toEqual([['Quickest win', 3]]);
  });
  it('the quickest win is between 10 and 60 plies', () => {
    const at = (plies: number) => highlights([game(1, 1, 2, '1-0', '1', { plies })]).map((h) => [h.label, h.note]);
    expect(at(60)).toEqual([['Quickest win', '30 moves']]);
    expect(at(61)).toEqual([]);
    expect(at(10)).toEqual([['Quickest win', '5 moves']]);
    expect(at(9)).toEqual([]);
  });
  it('is attached to the analysis', () => {
    // Bob (2400) beat Alice (2500) in round 2: exactly a 100-point upset.
    const hs = analyseEvent(roundRobin(), null).highlights;
    expect(hs.map((h) => [h.label, h.game.id, h.note])).toEqual([['Biggest upset', 4, 'won against a player rated 100 points higher']]);
    expect(analyseEvent(swiss(), null).highlights).toEqual([]);
  });
});

// ---- winners and round stories ------------------------------------------------------------------

describe('winners', () => {
  it('everyone on top of a complete individual event', () => {
    expect(winners(analyseEvent(roundRobin(), null))).toEqual(['Bob', 'Alice']);
    expect(winners(analyseEvent(doubleRoundRobin(), null))).toEqual(['Alice']);
    expect(winners(analyseEvent(swiss(), null))).toEqual(['Alice', 'Heidi']);
  });
  // Loose games without rounds have no standings, so nobody wins (fixed in winners()).

  it('nobody for loose games without rounds', () => {
    expect(winners(analyseEvent(loose(), null))).toEqual([]);
  });
});

describe('roundStory (round robin)', () => {
  const a = analyseEvent(roundRobin(), null);
  it('round 1: board 1 result, decisive count, new leader', () => {
    expect(roundStory(a, 1)).toEqual(['On board 1, Alice beat Dave with the white pieces.', '1 of 2 games was decisive.', 'Alice moves into the sole lead with 1/1.']);
  });
  it('round 2: a draw on board 1 and a new leader', () => {
    expect(roundStory(a, 2)).toEqual(['On board 1, Dave and Carol drew.', '1 of 2 games was decisive.', 'Bob moves into the sole lead with 1½/2.']);
  });
  it('last round: shared first place', () => {
    expect(roundStory(a, 3)).toEqual(['On board 1, Bob and Dave drew.', '1 of 2 games was decisive.', 'Bob and Alice finish level on 2/3.']);
  });
  it('unknown round', () => {
    expect(roundStory(a, 4)).toEqual([]);
  });
  it('double round robin: taking, keeping and winning', () => {
    const d = analyseEvent(doubleRoundRobin(), null);
    expect(roundStory(d, 4)).toEqual(['On board 1, Alice beat Dave with the black pieces.', '1 of 2 games was decisive.', 'Alice takes the sole lead with 3/4.']);
    expect(roundStory(d, 5)).toEqual(['On board 1, Carol beat Dave with the white pieces.', '1 of 2 games was decisive.', 'Alice keeps the sole lead with 3½/5.']);
    expect(roundStory(d, 6)).toEqual(['On board 1, Dave and Bob drew.', '1 of 2 games was decisive.', 'Alice wins the tournament with 4½/6.']);
  });
  it('all games drawn / all decisive', () => {
    const drawn = roundRobin().map((g) => ({ ...g, result: '1/2-1/2' }));
    expect(roundStory(analyseEvent(drawn, null), 1)).toEqual(['On board 1, Alice and Dave drew.', 'All 2 games were drawn.', 'Everyone is level on ½/1.']);
    const decisive = roundRobin().map((g) => ({ ...g, result: '1-0' }));
    expect(roundStory(analyseEvent(decisive, null), 1)).toEqual(['On board 1, Alice beat Dave with the white pieces.', 'All 2 games were decisive.', 'Alice and Bob share the lead on 1/1.']);
  });
  it('unfinished games: no result on board 1, and not counted as decisive or drawn', () => {
    const games = roundRobin().map((g) => (g.id === 1 ? { ...g, result: '*' } : g));
    const a = analyseEvent(games, null);
    expect(roundStory(a, 1)[0]).toBe('On board 1, the game between Alice and Dave has no result yet.');
    expect(roundStory(a, 1)).toHaveLength(2); // one finished game: no decisive count
    const after1 = a.standingsAfter(1).map((l) => [l.player.name, l.points, l.games, l.draws]);
    expect(after1).toEqual([
      ['Bob', 0.5, 1, 1],
      ['Carol', 0.5, 1, 1],
    ]);
    expect(a.stats).toMatchObject({ games: 6, white: 0, black: 2, draws: 3 });
  });
  it('a round with no finished game says nothing about the lead', () => {
    const a = analyseEvent(roundRobin().map((g) => (g.round === '1' ? { ...g, result: '*' } : g)), null);
    expect(roundStory(a, 1)).toEqual(['On board 1, the game between Alice and Dave has no result yet.']);
  });
  it('incomplete events only describe the top board', () => {
    const a = analyseEvent(doubleRoundRobin().slice(0, 10), null);
    expect(a.complete).toBe(false);
    expect(roundStory(a, 1)).toEqual(['On the top board, Alice beat Dave with the white pieces.', '1 of 2 games was decisive.']);
  });
});
