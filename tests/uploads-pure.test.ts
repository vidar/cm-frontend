// Unit tests for the pure parts of src/lib/uploads.ts (UPLOAD_ID_BASE, isUploaded, FORMATS, LIMITS and
// previewAnalysis over rounds of games parsed from small PGN strings) and the pure helpers of
// src/lib/games.ts (slugify, gamePath, scoreFor, resultLabel). Nothing here touches the database:
// no query(), createUpload(), saveRounds(), approve() or the like. Fixtures are hand-built and the
// expected standings are worked out by hand.
import { describe, expect, it } from 'vitest';
import { FORMATS, isUploaded, LIMITS, previewAnalysis, sameName, UPLOAD_ID_BASE, type Upload, type UploadFormat, type UploadRound } from '../src/lib/uploads';
import { gamePath, resultLabel, scoreFor, slugify } from '../src/lib/games';
import { parsePgn, type ParsedGame } from '../src/lib/pgn';

// ---- fixtures ---------------------------------------------------------------------------------

interface Spec {
  w: string;
  b: string;
  r: ParsedGame['result'];
  round: string;
  wt?: string;
  bt?: string;
  welo?: number;
  belo?: number;
  date?: string;
}

/** One PGN game. Every game is the same short legal line, so each has 4 plies. */
const pgnGame = (s: Spec) => {
  const tags: [string, string | number | undefined][] = [
    ['Event', '?'],
    ['Date', s.date ?? '????.??.??'],
    ['Round', s.round],
    ['White', s.w],
    ['Black', s.b],
    ['Result', s.r],
    ['WhiteElo', s.welo],
    ['BlackElo', s.belo],
    ['WhiteTeam', s.wt],
    ['BlackTeam', s.bt],
  ];
  const lines = tags.filter(([, v]) => v !== undefined).map(([k, v]) => `[${k} "${v}"]`);
  return `${lines.join('\n')}\n\n1. e4 e5 2. Nf3 Nc6 ${s.r}\n`;
};

/** One uploaded round as getRounds() would return it: the games parsed from a PGN string. */
function round(n: number, specs: Spec[]): UploadRound {
  const { games, problems } = parsePgn(specs.map(pgnGame).join('\n'));
  if (problems.length) throw new Error(`fixture PGN problems: ${JSON.stringify(problems)}`);
  return { round: n, games, uploaded_at: '2026-03-01 12:00:00' };
}

const upload = (format: UploadFormat, name = 'Spring Open'): Upload => ({
  id: 7,
  name,
  site: null,
  format,
  contact: null,
  status: 'pending',
  event_id: null,
  created_at: '2026-03-01 12:00:00',
});

// 4-player, 2-round Swiss with the Round tags saveRounds() stores for individual events ('N.board').
// Alice 2400, Bob 2300, Carol 2200, Dave 2100.
//   R1: board 1 Alice beat Dave, board 2 Bob–Carol drew.
//   R2: board 1 Bob–Alice drew, board 2 Carol–Dave drew (the file lists board 2 first).
// Final: Alice 1½, Bob 1 (Buchholz 2½), Carol 1 (Buchholz 1½), Dave ½.
const swissRounds = () => [
  round(1, [
    { w: 'Alice', b: 'Dave', r: '1-0', round: '1.1', welo: 2400, belo: 2100, date: '2026.03.01' },
    { w: 'Bob', b: 'Carol', r: '1/2-1/2', round: '1.2', welo: 2300, belo: 2200, date: '2026.03.01' },
  ]),
  round(2, [
    { w: 'Carol', b: 'Dave', r: '1/2-1/2', round: '2.2', welo: 2200, belo: 2100, date: '2026.03.02' },
    { w: 'Bob', b: 'Alice', r: '1/2-1/2', round: '2.1', welo: 2300, belo: 2400, date: '2026.03.02' },
  ]),
];

// Team event: 4 teams of 2 boards over 2 rounds, board 1 first within each match.
//   Alpha: Alice, Bob   Bravo: Carol, Dave   Charlie: Eve, Frank   Delta: Grace, Heidi
//   R1: Alpha 1½–½ Bravo, Charlie 0–2 Delta.   R2: Alpha 1½–½ Delta, Bravo 1½–½ Charlie.
// `tag` builds the Round tag: 'N.match' (kept by saveRounds) or plain 'N' (what it stores otherwise).
const teamRounds = (tag: (n: number, match: number) => string = (n, m) => `${n}.${m}`) => [
  round(1, [
    { w: 'Alice', b: 'Carol', r: '1-0', round: tag(1, 1), wt: 'Alpha', bt: 'Bravo' },
    { w: 'Dave', b: 'Bob', r: '1/2-1/2', round: tag(1, 1), wt: 'Bravo', bt: 'Alpha' },
    { w: 'Eve', b: 'Grace', r: '0-1', round: tag(1, 2), wt: 'Charlie', bt: 'Delta' },
    { w: 'Heidi', b: 'Frank', r: '1-0', round: tag(1, 2), wt: 'Delta', bt: 'Charlie' },
  ]),
  round(2, [
    { w: 'Alice', b: 'Grace', r: '1/2-1/2', round: tag(2, 1), wt: 'Alpha', bt: 'Delta' },
    { w: 'Heidi', b: 'Bob', r: '0-1', round: tag(2, 1), wt: 'Delta', bt: 'Alpha' },
    { w: 'Carol', b: 'Eve', r: '1-0', round: tag(2, 2), wt: 'Bravo', bt: 'Charlie' },
    { w: 'Frank', b: 'Dave', r: '1/2-1/2', round: tag(2, 2), wt: 'Charlie', bt: 'Bravo' },
  ]),
];

// Single-game knockout: two semi-finals and a final (two-part tags carry no structural hint).
const koRounds = () => [
  round(1, [
    { w: 'Alice', b: 'Bob', r: '1-0', round: '1.1' },
    { w: 'Carol', b: 'Dave', r: '1-0', round: '1.2' },
  ]),
  round(2, [{ w: 'Alice', b: 'Carol', r: '1-0', round: '2.1' }]),
];

// 3-player round robin, one game a round.
const rrRounds = () => [
  round(1, [{ w: 'Alice', b: 'Bob', r: '1-0', round: '1.1' }]),
  round(2, [{ w: 'Bob', b: 'Carol', r: '1/2-1/2', round: '2.1' }]),
  round(3, [{ w: 'Carol', b: 'Alice', r: '0-1', round: '3.1' }]),
];

// ---- constants --------------------------------------------------------------------------------

describe('UPLOAD_ID_BASE / isUploaded', () => {
  it('uploaded ids start at 100 000 000', () => {
    expect(UPLOAD_ID_BASE).toBe(100_000_000);
  });
  it('is true from the base up and false below it', () => {
    expect(isUploaded(UPLOAD_ID_BASE)).toBe(true);
    expect(isUploaded(UPLOAD_ID_BASE + 1)).toBe(true);
    expect(isUploaded(UPLOAD_ID_BASE - 1)).toBe(false);
    expect(isUploaded(1)).toBe(false);
    expect(isUploaded(0)).toBe(false);
  });
});

describe('FORMATS', () => {
  it('labels the four upload formats', () => {
    expect(FORMATS).toEqual({ swiss: 'Swiss', 'round-robin': 'Round robin', knockout: 'Knockout', team: 'Team event' });
  });
});

describe('LIMITS', () => {
  it('caps file size, games per round and tournament, moves per file, rounds, pending and new uploads', () => {
    expect(LIMITS).toEqual({ bytes: 2_000_000, gamesPerRound: 600, rounds: 40, games: 2_000, plies: 150_000, pending: 50, perDay: 200 });
  });
});

// ---- previewAnalysis --------------------------------------------------------------------------

describe('previewAnalysis', () => {
  describe('4-player Swiss over 2 rounds', () => {
    const a = previewAnalysis(upload('swiss'), swissRounds());

    it('is a complete Swiss with four players and two rounds', () => {
      expect(a.format).toBe('swiss');
      expect(a.players.size).toBe(4);
      expect(a.rounds.map((r) => r.n)).toEqual([1, 2]);
      expect(a.coverage).toBe(1);
      expect(a.complete).toBe(true);
      expect(a.teams).toBeUndefined();
      expect(a.knockout).toBeUndefined();
    });
    it('numbers players in order of first appearance, without slugs', () => {
      expect(a.players.get(1)).toEqual({ id: 1, name: 'Alice', slug: '', title: null, fed: null, elo: 2400, team: null });
      expect([2, 3, 4].map((id) => a.players.get(id)!.name)).toEqual(['Dave', 'Bob', 'Carol']);
      expect(a.avgElo).toBe(2250);
    });
    it('final standings: points, results and tie-breaks', () => {
      const rows = a.standingsAfter(Infinity).map((l) => [l.player.name, l.rank, l.points, l.games, l.wins, l.draws, l.losses, l.buchholz, l.sb]);
      expect(rows).toEqual([
        ['Alice', 1, 1.5, 2, 1, 1, 0, 1.5, 1],
        ['Bob', 2, 1, 2, 0, 2, 0, 2.5, 1.25],
        ['Carol', 3, 1, 2, 0, 2, 0, 1.5, 0.75],
        ['Dave', 4, 0.5, 2, 0, 1, 1, 2.5, 0.5],
      ]);
      // Two rated opponents are not enough for a performance rating.
      expect(a.standingsAfter(Infinity).map((l) => l.perf)).toEqual([null, null, null, null]);
    });
    it('standings before play and after round 1', () => {
      expect(a.standingsAfter(0).map((l) => [l.player.name, l.points, l.games])).toEqual([
        ['Alice', 0, 0],
        ['Bob', 0, 0],
        ['Carol', 0, 0],
        ['Dave', 0, 0],
      ]);
      // Bob and Carol are level on everything after their draw; the rating splits them.
      expect(a.standingsAfter(1).map((l) => [l.player.name, l.rank, l.points])).toEqual([
        ['Alice', 1, 1],
        ['Bob', 2, 0.5],
        ['Carol', 3, 0.5],
        ['Dave', 4, 0],
      ]);
    });
    it('records each result with round, opponent, colour and score', () => {
      const alice = a.standingsAfter(Infinity).find((l) => l.player.name === 'Alice')!;
      expect(alice.results.map((r) => [r.round, a.players.get(r.opp)!.name, r.color, r.score])).toEqual([
        [1, 'Dave', 'w', 1],
        [2, 'Bob', 'b', 0.5],
      ]);
    });
    it('orders the boards of a round by the N.board tag, not by file order', () => {
      // Round 2 lists board 2 first; it gets id 3 and board 1 gets id 4.
      expect(a.rounds[1].games.map((g) => [g.id, g.round, g.white_name])).toEqual([
        [4, '2.1', 'Bob'],
        [3, '2.2', 'Carol'],
      ]);
      expect(a.rounds[0].games.map((g) => g.round)).toEqual(['1.1', '1.2']);
    });
    it('carries the upload name, the dates and the stats', () => {
      expect(a.rounds[0].games[0].event_name).toBe('Spring Open');
      expect(a.rounds[0].games[0].event_slug).toBe('');
      expect([a.rounds[0].first, a.rounds[0].last, a.rounds[1].first]).toEqual(['2026-03-01', '2026-03-01', '2026-03-02']);
      expect(a.stats).toEqual({ games: 4, white: 1, draws: 3, black: 0, avgMoves: 2, topOpening: null });
      expect(a.highlights).toEqual([]);
    });
  });

  describe('team event', () => {
    const a = previewAnalysis(upload('team', 'Club League'), teamRounds());
    const line = (l: { team: string; rank: number; mp: number; gp: number; played: number; w: number; d: number; l: number }) => [l.team, l.rank, l.mp, l.gp, l.played, l.w, l.d, l.l];

    it('is a team event with teams defined', () => {
      expect(a.format).toBe('team');
      expect(a.teams).toBeDefined();
      expect(a.teams!.boards).toBe(2);
      expect(a.teams!.roundRobin).toBe(false);
      expect(a.players.size).toBe(8);
      expect(a.players.get(1)).toMatchObject({ name: 'Alice', team: 'Alpha' });
      expect(a.players.get(8)).toMatchObject({ name: 'Frank', team: 'Charlie' });
    });
    it('groups boards into matches with the home side from board 1', () => {
      expect(a.teams!.matches.map((m) => [m.round, m.home, m.away, m.homePts, m.awayPts, m.complete, m.games.map((g) => g.id)])).toEqual([
        [1, 'Alpha', 'Bravo', 1.5, 0.5, true, [1, 2]],
        [1, 'Charlie', 'Delta', 0, 2, true, [3, 4]],
        [2, 'Alpha', 'Delta', 1.5, 0.5, true, [5, 6]],
        [2, 'Bravo', 'Charlie', 1.5, 0.5, true, [7, 8]],
      ]);
    });
    it('team standings by match points then game points', () => {
      expect(a.teams!.standingsAfter(1).map(line)).toEqual([
        ['Delta', 1, 2, 2, 1, 1, 0, 0],
        ['Alpha', 2, 2, 1.5, 1, 1, 0, 0],
        ['Bravo', 3, 0, 0.5, 1, 0, 0, 1],
        ['Charlie', 4, 0, 0, 1, 0, 0, 1],
      ]);
      expect(a.teams!.standingsAfter(Infinity).map(line)).toEqual([
        ['Alpha', 1, 4, 3, 2, 2, 0, 0],
        ['Delta', 2, 2, 2.5, 2, 1, 0, 1],
        ['Bravo', 3, 2, 2, 2, 1, 0, 1],
        ['Charlie', 4, 0, 0.5, 2, 0, 0, 2],
      ]);
      expect(a.teams!.standingsAfter(0)).toEqual([]);
    });
    it('rosters give each player a board and a score', () => {
      expect(a.teams!.rosters.get('Alpha')!.map((r) => [r.player.name, r.board, r.games, r.points, r.perf])).toEqual([
        ['Alice', 1, 2, 1.5, null],
        ['Bob', 2, 2, 1.5, null],
      ]);
    });
    it('plain round numbers (what saveRounds stores for team events) give the same matches', () => {
      const b = previewAnalysis(upload('team', 'Club League'), teamRounds((n) => String(n)));
      expect(b.format).toBe('team');
      expect(b.rounds.map((r) => r.n)).toEqual([1, 2]);
      expect(b.teams!.matches.map((m) => [m.round, m.home, m.away, m.homePts, m.awayPts])).toEqual(
        a.teams!.matches.map((m) => [m.round, m.home, m.away, m.homePts, m.awayPts]),
      );
      expect(b.teams!.standingsAfter(Infinity).map(line)).toEqual(a.teams!.standingsAfter(Infinity).map(line));
    });
  });

  describe('other formats', () => {
    it('the knockout format is the hint that makes two-part tags a bracket', () => {
      const ko = previewAnalysis(upload('knockout', 'City Cup'), koRounds());
      expect(ko.format).toBe('knockout');
      expect(ko.knockout!.map((r) => [r.n, r.name, r.matches.length])).toEqual([
        [1, 'Semi-finals', 2],
        [2, 'Final', 1],
      ]);
      const final = ko.knockout![1].matches[0];
      expect([final.a.name, final.b.name, final.aPts, final.bPts, ko.players.get(final.winner!)!.name]).toEqual(['Alice', 'Carol', 1, 0, 'Alice']);
      // The same games uploaded as a Swiss stay a Swiss.
      const sw = previewAnalysis(upload('swiss', 'City Cup'), koRounds());
      expect(sw.format).toBe('swiss');
      expect(sw.knockout).toBeUndefined();
    });
    it('a round robin is recognised from the pairings', () => {
      const a = previewAnalysis(upload('round-robin'), rrRounds());
      expect(a.format).toBe('round-robin');
      expect(a.cycles).toBe(1);
      expect(a.players.size).toBe(3);
      expect(a.rounds.map((r) => r.n)).toEqual([1, 2, 3]);
      expect(a.coverage).toBe(1);
      expect(a.complete).toBe(true);
      expect(a.category).toBeNull();
      const s = a.standingsAfter(Infinity);
      expect(s[0].player.name).toBe('Alice');
      expect(s.map((l) => l.points)).toEqual([2, 0.5, 0.5]);
    });
    it('a single game between two players previews as a match', () => {
      const a = previewAnalysis(upload('swiss'), [round(1, [{ w: 'Alice', b: 'Bob', r: '*', round: '1.1' }])]);
      expect(a.format).toBe('match');
      expect(a.players.size).toBe(2);
      expect(a.knockout![0].matches[0]).toMatchObject({ aPts: 0.5, bPts: 0.5, winner: null });
    });
    it('matches player names case-insensitively, keeping the first spelling', () => {
      const a = previewAnalysis(upload('swiss'), [
        round(1, [{ w: 'Alice', b: 'Bob', r: '1-0', round: '1.1' }]),
        round(2, [{ w: 'bob', b: 'ALICE', r: '0-1', round: '2.1' }]),
      ]);
      expect(a.players.size).toBe(2);
      expect([...a.players.values()].map((p) => p.name)).toEqual(['Alice', 'Bob']);
      expect(a.standingsAfter(Infinity).map((l) => [l.player.name, l.points, l.games])).toEqual([
        ['Alice', 2, 2],
        ['Bob', 0, 2],
      ]);
    });
    it('no rounds, or a round without games, is just "games"', () => {
      for (const rounds of [[], [round(1, [])]]) {
        const a = previewAnalysis(upload('swiss'), rounds);
        expect(a.format).toBe('games');
        expect(a.players.size).toBe(0);
        expect(a.rounds).toEqual([]);
        expect(a.standingsAfter(Infinity)).toEqual([]);
        expect(a.stats.games).toBe(0);
      }
    });
  });
});

// ---- games.ts helpers -------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Magnus Carlsen')).toBe('magnus-carlsen');
    expect(slugify('Nepomniachtchi, Ian')).toBe('nepomniachtchi-ian');
    expect(slugify('Round 5')).toBe('round-5');
    expect(slugify('ABC')).toBe('abc');
  });
  it('strips accents', () => {
    expect(slugify('José Raúl Capablanca')).toBe('jose-raul-capablanca');
    expect(slugify('Vachier-Lagrave, Maxime')).toBe('vachier-lagrave-maxime');
    expect(slugify('Müller')).toBe('muller');
    expect(slugify('Ştefan')).toBe('stefan');
    expect(slugify('ﬁsh')).toBe('fish');
  });
  it('drops apostrophes without a dash', () => {
    expect(slugify("O'Neill")).toBe('oneill');
    expect(slugify('D’Costa')).toBe('dcosta');
  });
  it('turns runs of punctuation into one dash', () => {
    expect(slugify('Tata Steel (Wijk aan Zee) 2024!')).toBe('tata-steel-wijk-aan-zee-2024');
    expect(slugify('a_b.c/d')).toBe('a-b-c-d');
    expect(slugify('a   b')).toBe('a-b');
  });
  it('removes leading and trailing dashes', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
    expect(slugify('-x-')).toBe('x');
    expect(slugify('(Open)')).toBe('open');
  });
  it('is empty for empty or all-punctuation input', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
  it('keeps only ASCII letters and digits (uniqueSlug falls back to "unnamed" for an empty slug)', () => {
    expect(slugify('Крамник')).toBe('');
  });
  it('is idempotent', () => {
    for (const s of ['Magnus Carlsen', 'José Raúl Capablanca', "O'Neill", '  --Hello--  ']) expect(slugify(slugify(s))).toBe(slugify(s));
  });
});

describe('gamePath', () => {
  const g = (over: Partial<Parameters<typeof gamePath>[0]> = {}) => ({
    id: 123,
    white_name: 'Carlsen, Magnus',
    black_name: 'Caruana, Fabiano',
    event_name: 'Norway Chess',
    date: '2024-05-27',
    ...over,
  });

  it('is id, surnames, event and year', () => {
    expect(gamePath(g())).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
  });
  it('takes the surname from "Last, First" and from "First Last" alike', () => {
    expect(gamePath(g({ white_name: 'Magnus Carlsen', black_name: 'Fabiano Caruana' }))).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
    expect(gamePath(g({ white_name: 'Carlsen,Magnus', black_name: 'Caruana' }))).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
  });
  it('keeps a multi-word surname in the comma form only', () => {
    expect(gamePath(g({ white_name: 'Van Wely, Loek', black_name: 'Vachier-Lagrave, Maxime' }))).toBe('/games/123-van-wely-vs-vachier-lagrave-norway-chess-2024/');
    expect(gamePath(g({ white_name: 'Loek van Wely' }))).toBe('/games/123-wely-vs-caruana-norway-chess-2024/');
  });
  it('appends the year only when the event name lacks it', () => {
    expect(gamePath(g({ event_name: 'Norway Chess 2024' }))).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
    expect(gamePath(g({ event_name: 'Season 2023/24' }))).toBe('/games/123-carlsen-vs-caruana-season-2023-24-2024/');
    expect(gamePath(g({ date: '2024' }))).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
  });
  it('has no year when the date is unknown', () => {
    expect(gamePath(g({ date: null }))).toBe('/games/123-carlsen-vs-caruana-norway-chess/');
    expect(gamePath(g({ date: null, event_name: 'Norway Chess 2024' }))).toBe('/games/123-carlsen-vs-caruana-norway-chess-2024/');
  });
  it('slugifies accents and punctuation', () => {
    expect(gamePath(g({ id: 9, white_name: 'Nepomniachtchi, Ian', black_name: "O'Neill, Pat", event_name: 'Candidates (Madrid)', date: '2022-06-16' }))).toBe(
      '/games/9-nepomniachtchi-vs-oneill-candidates-madrid-2022/',
    );
  });
  it('works for uploaded ids', () => {
    expect(gamePath(g({ id: UPLOAD_ID_BASE + 1 }))).toBe(`/games/100000001-carlsen-vs-caruana-norway-chess-2024/`);
  });

  describe('90-character cap', () => {
    // 'aaaaaaaaaa-vs-bbbbbbbbbb-' is 25 characters; the event words fill the rest.
    const names = { id: 1, white_name: 'Aaaaaaaaaa, X', black_name: 'Bbbbbbbbbb, Y' };
    const prefix = 'aaaaaaaaaa-vs-bbbbbbbbbb-';
    const slugOf = (path: string) => path.slice('/games/1-'.length, -1);

    it('a slug of exactly 90 characters is kept whole', () => {
      const path = gamePath({ ...names, event_name: 'wordy '.repeat(11).trim(), date: null });
      expect(slugOf(path)).toBe(`${prefix}${'wordy-'.repeat(10)}wordy`);
      expect(slugOf(path)).toHaveLength(90);
    });
    it('a longer slug is cut to 90 characters', () => {
      const path = gamePath({ ...names, event_name: `${'wordy '.repeat(10)}wordyz`, date: null });
      expect(slugOf(path)).toBe(`${prefix}${'wordy-'.repeat(10)}wordy`);
      expect(slugOf(path)).toHaveLength(90);
    });
    it('a cut that lands on a dash drops the dash', () => {
      // Full slug: prefix + 13 × 'word-' + 'word' + '-2024' = 99 characters; character 90 is a dash.
      const path = gamePath({ ...names, event_name: 'word '.repeat(14).trim(), date: '2024-01-01' });
      expect(slugOf(path)).toBe(`${prefix}${'word-'.repeat(12)}word`);
      expect(slugOf(path)).toHaveLength(89);
      expect(path.endsWith('-/')).toBe(false);
    });
  });
});

describe('scoreFor', () => {
  it('a white win is 1 for white and 0 for black', () => {
    const g = { result: '1-0', white_id: 1 };
    expect(scoreFor(g, 1)).toBe('1');
    expect(scoreFor(g, 2)).toBe('0');
  });
  it('a black win is 0 for white and 1 for black', () => {
    const g = { result: '0-1', white_id: 1 };
    expect(scoreFor(g, 1)).toBe('0');
    expect(scoreFor(g, 2)).toBe('1');
  });
  it('a draw is a half for both', () => {
    const g = { result: '1/2-1/2', white_id: 1 };
    expect(scoreFor(g, 1)).toBe('½');
    expect(scoreFor(g, 2)).toBe('½');
  });
  // An unfinished game ('*', which uploaded tournaments can contain) is no win for either side.
  it('an unfinished game is not a win for black', () => {
    const g = { result: '*', white_id: 1 };
    expect(scoreFor(g, 2)).not.toBe('1');
    expect(scoreFor(g, 1)).not.toBe('0');
  });
});

describe('resultLabel', () => {
  it('uses en dashes and ½', () => {
    expect(resultLabel('1-0')).toBe('1–0');
    expect(resultLabel('0-1')).toBe('0–1');
    expect(resultLabel('1/2-1/2')).toBe('½–½');
  });
  it('leaves an unfinished game as *', () => {
    expect(resultLabel('*')).toBe('*');
  });
});

describe('sameName (FIDE-ID linking)', () => {
  it('matches the same person written another way', () => {
    expect(sameName('Nakamura, Hikaru', 'Hikaru Nakamura')).toBe(true);
    expect(sameName('Nakamura,Hikaru', 'Hikaru Nakamura')).toBe(true);
    expect(sameName('Nakamura, H.', 'Hikaru Nakamura')).toBe(true);
    expect(sameName('Nakamura', 'Hikaru Nakamura')).toBe(true);
    expect(sameName('Ding Liren', 'Ding, Liren')).toBe(true);
    expect(sameName('Gukesh D', 'Gukesh Dommaraju')).toBe(true);
    expect(sameName('Jóhann Hjartarson', 'Johann Hjartarson')).toBe(true); // accents are dropped by slugify
    expect(sameName('Hikaru Nakamura', 'Hikaru Kenji Nakamura')).toBe(true); // a middle name more
  });
  it('refuses another person or a name with nothing in full', () => {
    expect(sameName('John Doe', 'Hikaru Nakamura')).toBe(false);
    expect(sameName('Nakamura, Taro', 'Hikaru Nakamura')).toBe(false);
    expect(sameName('H. N.', 'Hikaru Nakamura')).toBe(false);
    expect(sameName('', 'Hikaru Nakamura')).toBe(false);
    expect(sameName('Nakamura Nakamura', 'Hikaru Nakamura')).toBe(false); // each part matches its own part
  });
});
