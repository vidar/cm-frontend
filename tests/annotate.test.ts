// Unit tests for the AI-notes prompt helpers: plyOf() and buildPrompt() in src/lib/annotate.ts, and
// contextFromAnalysis() in src/lib/annotate-context.ts (the tournament situation around a game, from an
// event analysis). Fixtures are hand-built: a 7-ply miniature with made-up evals for the prompt, and small
// round robin, Swiss, knockout, match and team events run through analyseEvent() for the context, with every
// expected line worked out by hand. No database, network or model calls (generate() is never touched).
import { describe, expect, it } from 'vitest';
import type { Evals } from '../src/lib/analysis';
import { buildPrompt, plyOf } from '../src/lib/annotate';
import { contextFromAnalysis } from '../src/lib/annotate-context';
import { analyseEvent, type EventGame } from '../src/lib/event';
import type { FullGame } from '../src/lib/games';

// ---- fixtures ---------------------------------------------------------------------------------

// A 50-ply move list with real moves at the plies the tests look up; the other entries are placeholders.
const SANS = Array.from({ length: 50 }, (_, i) => `x${i + 1}`);
SANS[8] = 'O-O'; // ply 9  = 5.O-O
SANS[9] = 'O-O'; // ply 10 = 5...O-O (both sides castle at move 5)
SANS[18] = 'O-O-O'; // ply 19 = 10.O-O-O
SANS[31] = 'Bf5+'; // ply 32 = 16...Bf5+
SANS[40] = 'Bb3'; // ply 41 = 21.Bb3
SANS[45] = 'Bc2'; // ply 46 = 23...Bc2

// Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#. UCI: e2e4 e7e5 f1c4 b8c6 d1h5 g8f6 h5f7.
const MOVES = 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#';

function fullGame(extra: Partial<FullGame> = {}): FullGame {
  return {
    id: 42,
    event_id: 7,
    white_id: 1,
    black_id: 2,
    white_elo: 2500,
    black_elo: null,
    white_title: 'GM',
    black_title: null,
    elo_avg: null,
    result: '1-0',
    date: '2024-01-12',
    round: '3',
    eco: 'C50',
    opening: 'italian-game',
    plies: 7,
    twic: 1500,
    white_name: 'Alice',
    white_slug: 'alice',
    black_name: 'Bob',
    black_slug: 'bob',
    event_name: 'Test Open',
    event_slug: 'test-open',
    moves: MOVES,
    event_site: null,
    ...extra,
  };
}

// Evals per position (ply 0 = start). Win chances: wc(30)=0.055, wc(113)=0.205, wc(-25)=-0.046, mate=1.
//   2...Nc6 (ply 4): Black's drop 0.205-0.055 = 0.15  -> ?! inaccuracy (best g8f6)
//   3.Qh5   (ply 5): White's drop 0.205+0.046 = 0.25  -> ?  mistake    (best g1f3)
//   3...Nf6 (ply 6): Black's drop 1+0.046     = 1.05  -> ?? blunder    (best g7g6)
// The other moves either match the engine's best or lose under 0.1; the final position has no eval.
const EVALS: Evals = {
  e: [30, 20, 25, 30, 113, -25, '#1', null],
  b: ['e2e4', 'e7e5', 'f1c4', 'g8f6', 'g1f3', 'g7g6', 'h5f7', null],
  p: [null, null, null, 'g8f6 b1c3', 'g1f3 g8f6 b1c3', 'g7g6 h5f3 g8f6', null, null],
};

const NAMES = ['', 'Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];

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

const withElos = (games: EventGame[], elo: Record<number, number>) =>
  games.map((g) => ({ ...g, white_elo: elo[g.white_id] ?? null, black_elo: elo[g.black_id] ?? null }));

const RR_ELO = { 1: 2500, 2: 2400, 3: 2300, 4: 2200 };

// 4-player single round robin: Alice 1, Bob 2, Carol 3, Dave 4.
//   R1: Alice beat Dave, Bob–Carol drew.  R2: Dave–Carol drew, Bob beat Alice.  R3: Bob–Dave drew, Alice beat Carol.
// After R1: Alice 1, Bob ½ (SB ¼), Carol ½ (SB ¼, lower rated), Dave 0.
// After R2: Bob 1½, Carol 1 (SB 1), Alice 1 (SB ½), Dave ½.
// After R3: Bob 2 (SB 3), Alice 2 (SB 2), Carol 1 (SB 1½, higher rated), Dave 1 (SB 1½).
const roundRobin = () =>
  withElos(
    [
      game(1, 1, 4, '1-0', '1'),
      game(2, 2, 3, '1/2-1/2', '1'),
      game(3, 4, 3, '1/2-1/2', '2'),
      game(4, 1, 2, '0-1', '2'),
      game(5, 2, 4, '1/2-1/2', '3'),
      game(6, 3, 1, '0-1', '3'),
    ],
    RR_ELO,
  );

// The round robin plus the first three games of the return cycle: 9 of the 12 games of a double round
// robin, so coverage is 0.75 and the event counts as incomplete.
const incompleteRoundRobin = () => [...roundRobin(), ...withElos([game(7, 4, 1, '0-1', '4'), game(8, 3, 2, '1/2-1/2', '4'), game(9, 3, 4, '1-0', '5')], RR_ELO)];

// 10-player, 2-round Swiss (nobody rated). R1: players 1-5 beat 6-10. R2: 1–2 1-0, 3–4 1-0, 5–6 ½, 7–8 1-0, 9–10 ½.
// After R2 (points, Buchholz): Alice 2 (1½), Carol 2 (1), Eve 1½, Bob 1 (3), Dave 1 (2½), Grace 1 (1),
// Frank ½ (3½), Judy ½ (2), Ivan ½ (1½), Heidi 0.
const swiss = () => [
  game(1, 1, 6, '1-0', '1'),
  game(2, 2, 7, '1-0', '1'),
  game(3, 3, 8, '1-0', '1'),
  game(4, 4, 9, '1-0', '1'),
  game(5, 5, 10, '1-0', '1'),
  game(6, 1, 2, '1-0', '2'),
  game(7, 3, 4, '1-0', '2'),
  game(8, 5, 6, '1/2-1/2', '2'),
  game(9, 7, 8, '1-0', '2'),
  game(10, 9, 10, '1/2-1/2', '2'),
];

// Knockout: two 2-game semi-finals (tags round.match.game) and a 2-game final Alice–Dave.
const knockout = () =>
  withElos(
    [
      game(1, 3, 4, '0-1', '1.2.1'),
      game(2, 4, 3, '1/2-1/2', '1.2.2'),
      game(3, 1, 2, '1-0', '1.1.1'),
      game(4, 2, 1, '1/2-1/2', '1.1.2'),
      game(5, 1, 4, '1-0', '2.1.1'),
      game(6, 4, 1, '1/2-1/2', '2.1.2'),
    ],
    RR_ELO,
  );

// Four-game match Alice–Bob, one game per round: 1-0, ½, ½, 0-1 (Alice wins 3–1).
const match = () => withElos([game(1, 1, 2, '1-0', '1'), game(2, 2, 1, '1/2-1/2', '2'), game(3, 1, 2, '1/2-1/2', '3'), game(4, 2, 1, '0-1', '4')], RR_ELO);

// Team league, 4 teams of 2 boards, 3 rounds ('r.m' = round r, match m).
//   Alpha: Alice, Bob   Bravo: Carol, Dave   Charlie: Eve, Frank   Delta: Grace, Heidi
//   R1: Alpha 1½–½ Bravo, Charlie 0–2 Delta.  R2: Charlie 1–1 Alpha, Delta 2–0 Bravo.  R3: Alpha 1½–½ Delta, Bravo 1½–½ Charlie.
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

// Mostly round-less games with three players: format 'games'.
const loose = () => [game(1, 1, 2, '1-0', '1'), game(2, 2, 3, '1/2-1/2', null), game(3, 3, 1, '0-1', null)];

/** The context of game `id` in the event made of `games`. */
const context = (games: EventGame[], id: number) => contextFromAnalysis(games.find((g) => g.id === id)!, analyseEvent(games, null));

const KEY_FACTS = 'Key facts (copy these numbers and places exactly; do not work them out from the tables):';
const INCOMPLETE = 'Not every game of the event is in the database, so the standings below may be incomplete; treat them as approximate.';

// ---- plyOf -------------------------------------------------------------------------------------

describe('plyOf', () => {
  it('finds White’s move from "21.Bb3"', () => {
    expect(plyOf('21.Bb3', SANS)).toBe(41);
  });
  it('finds Black’s move from "23...Bc2"', () => {
    expect(plyOf('23...Bc2', SANS)).toBe(46);
  });
  it('allows spaces around the dots', () => {
    expect(plyOf('23... Bc2', SANS)).toBe(46);
    expect(plyOf('23 ... Bc2', SANS)).toBe(46);
    expect(plyOf(' 21. Bb3', SANS)).toBe(41);
  });
  it('matches a check in the game and ignores annotation marks in the note', () => {
    expect(plyOf('16...Bf5', SANS)).toBe(32);
    expect(plyOf('16...Bf5+', SANS)).toBe(32);
    expect(plyOf('21.Bb3!?', SANS)).toBe(41);
    expect(plyOf('21.Bb3??', SANS)).toBe(41);
  });
  it('handles castling', () => {
    expect(plyOf('10.O-O-O', SANS)).toBe(19);
  });
  it('lets the dots decide when both sides played the same move', () => {
    expect(plyOf('5.O-O', SANS)).toBe(9);
    expect(plyOf('5...O-O', SANS)).toBe(10);
  });
  it('trusts the move over the dots when they disagree', () => {
    expect(plyOf('21...Bb3', SANS)).toBe(41);
    expect(plyOf('23.Bc2', SANS)).toBe(46);
    expect(plyOf('10...O-O-O', SANS)).toBe(19);
  });
  it('returns null for a move that is not in the game', () => {
    expect(plyOf('21.Bc3', SANS)).toBeNull();
    expect(plyOf('22.Bb3', SANS)).toBeNull();
    expect(plyOf('99.Bb3', SANS)).toBeNull();
    expect(plyOf('0.Bb3', SANS)).toBeNull();
  });
  it('returns null for junk', () => {
    expect(plyOf('', SANS)).toBeNull();
    expect(plyOf('Bb3', SANS)).toBeNull();
    expect(plyOf('hello', SANS)).toBeNull();
    expect(plyOf('21.', SANS)).toBeNull();
    expect(plyOf('.Bb3', SANS)).toBeNull();
  });
  it('returns null on an empty move list', () => {
    expect(plyOf('1.e4', [])).toBeNull();
  });
  // "5…O-O" is Black's castling even when both sides castled at move 5.
  it('reads the ellipsis character as Black’s move', () => {
    expect(plyOf('5…O-O', SANS)).toBe(10);
  });
});

// ---- buildPrompt -------------------------------------------------------------------------------

describe('buildPrompt', () => {
  it('writes the whole prompt for a game without tournament information', () => {
    expect(buildPrompt(fullGame(), 'Italian Game', EVALS)).toBe(
      [
        'White: GM Alice (2500)',
        'Black: Bob',
        'Event: Test Open, round 3, 2024-01-12',
        'Opening: Italian Game (C50)',
        'Result: 1-0',
        "Starting eval: +0.30. Evals are in pawns from White's point of view (+ White better, - Black better, #n mate).",
        '',
        'No tournament information is available for this game.',
        '',
        'Moves:',
        '1.e4  eval +0.20',
        '1...e5  eval +0.25',
        '2.Bc4  eval +0.30',
        '2...Nc6  eval +1.13  ?! inaccuracy; engine preferred 2...Nf6 3.Nc3 (eval +0.30)',
        '3.Qh5  eval -0.25  ? mistake; engine preferred 3.Nf3 Nf6 4.Nc3 (eval +1.13)',
        '3...Nf6  eval #1  ?? blunder; engine preferred 3...g6 4.Qf3 Nf6 (eval -0.25)',
        '4.Qxf7#  eval –',
      ].join('\n'),
    );
  });

  it('leaves out a missing title and rating', () => {
    const lines = buildPrompt(fullGame({ white_title: null, white_elo: null, black_title: 'IM', black_elo: 2450 }), null, EVALS).split('\n');
    expect(lines[0]).toBe('White: Alice');
    expect(lines[1]).toBe('Black: IM Bob (2450)');
  });

  it('writes the event line without round and date when unknown', () => {
    expect(buildPrompt(fullGame({ round: null, date: null }), null, EVALS).split('\n')[2]).toBe('Event: Test Open');
    expect(buildPrompt(fullGame({ date: null }), null, EVALS).split('\n')[2]).toBe('Event: Test Open, round 3');
  });

  it('falls back from the opening name to the ECO code, or to no line at all', () => {
    expect(buildPrompt(fullGame({ eco: null }), 'Italian Game', EVALS).split('\n')[3]).toBe('Opening: Italian Game');
    expect(buildPrompt(fullGame(), null, EVALS).split('\n')[3]).toBe('ECO: C50');
    const lines = buildPrompt(fullGame({ eco: null }), null, EVALS).split('\n');
    expect(lines[3]).toBe('Result: 1-0');
    expect(lines.some((l) => l.startsWith('Opening:') || l.startsWith('ECO:'))).toBe(false);
  });

  it('marks a draw in the result line', () => {
    expect(buildPrompt(fullGame({ result: '1/2-1/2' }), null, EVALS)).toContain('\nResult: 1/2-1/2 (draw)\n');
    expect(buildPrompt(fullGame({ result: '0-1' }), null, EVALS)).toContain('\nResult: 0-1\n');
  });

  it('puts the tournament information block in place of the "no information" line', () => {
    const prompt = buildPrompt(fullGame(), null, EVALS, 'Tournament: Test Open, round robin, 3 rounds, 4 players.\nThis was the first round.');
    expect(prompt).toContain(
      '\n\nTournament information (only what was known at the time):\nTournament: Test Open, round robin, 3 rounds, 4 players.\nThis was the first round.\n\nMoves:\n',
    );
    expect(prompt).not.toContain('No tournament information');
  });

  it('gives an unflagged move only its eval', () => {
    const lines = buildPrompt(fullGame(), null, EVALS).split('\n');
    const e4 = lines.find((l) => l.startsWith('1.e4'));
    expect(e4).toBe('1.e4  eval +0.20');
    expect(e4).not.toContain('engine preferred');
    expect(lines.filter((l) => l.includes('engine preferred')).map((l) => l.split('  ')[0])).toEqual(['2...Nc6', '3.Qh5', '3...Nf6']);
  });

  it('uses the best move alone when the analysis has no engine lines', () => {
    const prompt = buildPrompt(fullGame(), null, { e: EVALS.e, b: EVALS.b });
    expect(prompt).toContain('2...Nc6  eval +1.13  ?! inaccuracy; engine preferred 2...Nf6 (eval +0.30)');
    expect(prompt).toContain('3.Qh5  eval -0.25  ? mistake; engine preferred 3.Nf3 (eval +1.13)');
    expect(prompt).toContain('3...Nf6  eval #1  ?? blunder; engine preferred 3...g6 (eval -0.25)');
  });

  it('writes "?" when the engine preferred nothing usable', () => {
    const b = [...EVALS.b];
    b[5] = null;
    expect(buildPrompt(fullGame(), null, { e: EVALS.e, b })).toContain('3...Nf6  eval #1  ?? blunder; engine preferred ? (eval -0.25)');
    const p = [...EVALS.p!];
    p[5] = 'e1e2 a7a6'; // illegal first move: the line stops before it
    expect(buildPrompt(fullGame(), null, { e: EVALS.e, b: EVALS.b, p })).toContain('3...Nf6  eval #1  ?? blunder; engine preferred ? (eval -0.25)');
  });

  it('cuts an engine line at its first illegal move', () => {
    const p = [...EVALS.p!];
    p[5] = 'g7g6 h5f3 e1e2';
    expect(buildPrompt(fullGame(), null, { e: EVALS.e, b: EVALS.b, p })).toContain('engine preferred 3...g6 4.Qf3 (eval -0.25)');
  });

  it('does not flag a move the engine itself chose, however the eval moved', () => {
    const b = [...EVALS.b];
    b[5] = 'g8f6'; // the blunder was the engine's own choice
    const prompt = buildPrompt(fullGame(), null, { e: EVALS.e, b });
    expect(prompt).toContain('\n3...Nf6  eval #1\n');
  });

  it('formats a mate eval and the final position', () => {
    const lines = buildPrompt(fullGame(), null, EVALS).split('\n');
    expect(lines.at(-2)).toContain('eval #1');
    expect(lines.at(-1)).toBe('4.Qxf7#  eval –');
  });

  it('writes a game without moves as headers only', () => {
    const prompt = buildPrompt(fullGame({ moves: '' }), null, { e: [30], b: [null] });
    expect(prompt.split('\n').at(-1)).toBe('Moves:');
    expect(prompt).toContain('Starting eval: +0.30.');
  });
});

// ---- contextFromAnalysis -----------------------------------------------------------------------

describe('contextFromAnalysis', () => {
  describe('round robin', () => {
    it('gives standings before and after a middle round with key facts', () => {
      expect(context(roundRobin(), 4)).toBe(
        [
          'Tournament: Test Open, round robin, 3 rounds, 4 players.',
          'This game was played in round 2 of 3.',
          'Standings going into round 2 (rank, player, points/games):',
          '  1. Alice 1/1',
          '  2. Bob ½/1',
          '  3. Carol ½/1',
          '  4. Dave 0/1',
          'Standings after round 2:',
          '  1. Bob 1½/2',
          '  2. Carol 1/2',
          '  3. Alice 1/2',
          '  4. Dave ½/2',
          KEY_FACTS,
          '- Leader(s) going into the round: Alice (1/1).',
          '- Leader(s) after the round: Bob (1½/2).',
          '- Alice: 1st with 1/1 going into the round; shared 2nd-3rd with 1/2 after it.',
          '- Bob: shared 2nd-3rd with ½/1 going into the round; 1st with 1½/2 after it.',
        ].join('\n'),
      );
    });

    it('says so in the first round and gives no standings before it', () => {
      expect(context(roundRobin(), 1)).toBe(
        [
          'Tournament: Test Open, round robin, 3 rounds, 4 players.',
          'This game was played in round 1 of 3.',
          'This was the first round.',
          'Standings after round 1:',
          '  1. Alice 1/1',
          '  2. Bob ½/1',
          '  3. Carol ½/1',
          '  4. Dave 0/1',
          KEY_FACTS,
          '- Leader(s) after the round: Alice (1/1).',
          '- Alice: no games before this round; 1st with 1/1 after it.',
          '- Dave: no games before this round; 4th with 0/1 after it.',
        ].join('\n'),
      );
    });

    it('names the last round and a shared lead', () => {
      const text = context(roundRobin(), 6)!;
      const lines = text.split('\n');
      expect(lines[1]).toBe('This game was played in round 3, the last round.');
      expect(lines).toContain('Standings going into round 3 (rank, player, points/games):');
      expect(text).toContain('Standings after round 3:\n  1. Bob 2/3\n  2. Alice 2/3\n  3. Carol 1/3\n  4. Dave 1/3\n');
      expect(lines.slice(-4)).toEqual([
        '- Leader(s) going into the round: Bob (1½/2).',
        '- Leader(s) after the round: Bob, Alice (2/3, shared lead).',
        '- Carol: shared 2nd-3rd with 1/2 going into the round; shared 3rd-4th with 1/3 after it.',
        '- Alice: shared 2nd-3rd with 1/2 going into the round; shared 1st-2nd with 2/3 after it.',
      ]);
      expect(text).not.toContain(INCOMPLETE);
    });

    it('warns when the event is incomplete', () => {
      const lines = context(incompleteRoundRobin(), 4)!.split('\n');
      expect(lines[0]).toBe('Tournament: Test Open, round robin, 5 rounds, 4 players.');
      expect(lines[1]).toBe('This game was played in round 2 of 5.');
      expect(lines[2]).toBe(INCOMPLETE);
      expect(lines[3]).toBe('Standings going into round 2 (rank, player, points/games):');
    });
  });

  describe('swiss', () => {
    it('shows the top of a long table plus the players’ own lines after an ellipsis', () => {
      expect(context(swiss(), 9)).toBe(
        [
          'Tournament: Test Open, swiss, 2 rounds, 10 players.',
          'This game was played in round 2, the last round.',
          'Standings going into round 2 (rank, player, points/games):',
          '  1. Alice 1/1',
          '  2. Bob 1/1',
          '  3. Carol 1/1',
          '  4. Dave 1/1',
          '  5. Eve 1/1',
          '  6. Frank 0/1',
          '  7. Grace 0/1',
          '  8. Heidi 0/1',
          'Standings after round 2:',
          '  1. Alice 2/2',
          '  2. Carol 2/2',
          '  3. Eve 1½/2',
          '  4. Bob 1/2',
          '  5. Dave 1/2',
          '  6. Grace 1/2',
          '  7. Frank ½/2',
          '  8. Judy ½/2',
          '  …',
          '  10. Heidi 0/2',
          KEY_FACTS,
          '- Leader(s) going into the round: Alice, Bob, Carol, Dave, Eve (1/1, shared lead).',
          '- Leader(s) after the round: Alice, Carol (2/2, shared lead).',
          '- Grace: shared 6th-10th with 0/1 going into the round; shared 4th-6th with 1/2 after it.',
          '- Heidi: shared 6th-10th with 0/1 going into the round; 10th with 0/2 after it.',
        ].join('\n'),
      );
    });

    it('needs no ellipsis when both players are in the top eight', () => {
      const text = context(swiss(), 6)!; // Alice–Bob, ranks 1 and 4 after round 2
      expect(text).not.toContain('…');
      expect(text).toContain('\n  8. Judy ½/2\n' + KEY_FACTS);
      expect(text).toContain('- Bob: shared 1st-5th with 1/1 going into the round; shared 4th-6th with 1/2 after it.');
    });
  });

  describe('team event', () => {
    it('describes the team match, standings, key facts and scores so far', () => {
      expect(context(teamEvent(), 5)).toBe(
        [
          'Tournament: Test Open, team event, 3 rounds.',
          'This game was played in round 2 of 3.',
          'Team match in round 2: Charlie vs Alpha, 2 boards; this game was board 1. Eve played for Charlie, Alice for Alpha.',
          'Final score of the team match (known only after the round; for the postamble): Charlie 1, Alpha 1.',
          'Team standings going into round 2:',
          '  1. Delta 2 match points, 2 game points (1 matches)',
          '  2. Alpha 2 match points, 1½ game points (1 matches)',
          '  3. Bravo 0 match points, ½ game points (1 matches)',
          '  4. Charlie 0 match points, 0 game points (1 matches)',
          'Team standings after round 2:',
          '  1. Delta 4 match points, 4 game points (2 matches)',
          '  2. Alpha 3 match points, 2½ game points (2 matches)',
          '  3. Charlie 1 match points, 1 game points (2 matches)',
          '  4. Bravo 0 match points, ½ game points (2 matches)',
          KEY_FACTS,
          '- Leader(s) going into the round: Delta, Alpha (2 match points, shared lead).',
          '- Leader(s) after the round: Delta (4 match points).',
          "- Charlie (Eve's team): shared 3rd-4th with 0 match points going into the round; 3rd with 1 match points after it.",
          "- Alpha (Alice's team): shared 1st-2nd with 2 match points going into the round; 2nd with 3 match points after it.",
          'Eve had scored 0/1 in the event before this game.',
          'Alice had scored 1/1 in the event before this game.',
        ].join('\n'),
      );
    });

    it('numbers the boards in id order within the match', () => {
      const lines = context(teamEvent(), 6)!.split('\n');
      expect(lines[2]).toBe('Team match in round 2: Charlie vs Alpha, 2 boards; this game was board 2. Bob played for Alpha, Frank for Charlie.');
      expect(lines.slice(-2)).toEqual(['Bob had scored ½/1 in the event before this game.', 'Frank had scored 0/1 in the event before this game.']);
    });

    it('has no earlier standings or scores in the first round', () => {
      expect(context(teamEvent(), 1)).toBe(
        [
          'Tournament: Test Open, team event, 3 rounds.',
          'This game was played in round 1 of 3.',
          'Team match in round 1: Alpha vs Bravo, 2 boards; this game was board 1. Alice played for Alpha, Carol for Bravo.',
          'Final score of the team match (known only after the round; for the postamble): Alpha 1½, Bravo ½.',
          'Team standings after round 1:',
          '  1. Delta 2 match points, 2 game points (1 matches)',
          '  2. Alpha 2 match points, 1½ game points (1 matches)',
          '  3. Bravo 0 match points, ½ game points (1 matches)',
          '  4. Charlie 0 match points, 0 game points (1 matches)',
          KEY_FACTS,
          '- Leader(s) after the round: Delta, Alpha (2 match points, shared lead).',
          "- Alpha (Alice's team): no games before this round; shared 1st-2nd with 2 match points after it.",
          "- Bravo (Carol's team): no games before this round; shared 3rd-4th with 0 match points after it.",
        ].join('\n'),
      );
    });

    it('names the last round', () => {
      const lines = context(teamEvent(), 9)!.split('\n');
      expect(lines[1]).toBe('This game was played in round 3, the last round.');
      expect(lines[2]).toBe('Team match in round 3: Alpha vs Delta, 2 boards; this game was board 1. Alice played for Alpha, Grace for Delta.');
      expect(lines.slice(-2)).toEqual(['Alice had scored 1½/2 in the event before this game.', 'Grace had scored 2/2 in the event before this game.']);
    });
  });

  describe('match', () => {
    it('gives the match score before and after a middle game', () => {
      expect(context(match(), 2)).toBe(
        [
          'Tournament: Test Open, match, 4 rounds, 2 players.',
          'This game was played in round 2 of 4.',
          'Match between Alice and Bob, 4 games in all.',
          'This was game 2 of the match. Score before it: Alice 1, Bob 0.',
          'Score after it: Alice 1½, Bob ½.',
          '2 more game(s) followed in the match.',
        ].join('\n'),
      );
    });

    it('starts from 0-0 in the first game', () => {
      const lines = context(match(), 1)!.split('\n');
      expect(lines[3]).toBe('This was game 1 of the match. Score before it: Alice 0, Bob 0.');
      expect(lines[4]).toBe('Score after it: Alice 1, Bob 0.');
      expect(lines[5]).toBe('3 more game(s) followed in the match.');
    });

    it('knows the last game of the match', () => {
      expect(context(match(), 4)).toBe(
        [
          'Tournament: Test Open, match, 4 rounds, 2 players.',
          'This game was played in round 4, the last round.',
          'Match between Alice and Bob, 4 games in all.',
          'This was game 4 of the match. Score before it: Alice 2, Bob 1.',
          'Score after it: Alice 3, Bob 1.',
          'This was the last game of the match.',
        ].join('\n'),
      );
    });
  });

  describe('knockout', () => {
    it('names the stage and the match score', () => {
      expect(context(knockout(), 1)).toBe(
        [
          'Tournament: Test Open, knockout, 2 rounds, 4 players.',
          'This game was played in round 1 of 2.',
          'Knockout stage: Semi-finals between Carol and Dave, 2 games in all.',
          'This was game 1 of the match. Score before it: Carol 0, Dave 0.',
          'Score after it: Carol 0, Dave 1.',
          '1 more game(s) followed in the match.',
        ].join('\n'),
      );
    });

    it('handles the final', () => {
      expect(context(knockout(), 6)).toBe(
        [
          'Tournament: Test Open, knockout, 2 rounds, 4 players.',
          'This game was played in round 2, the last round.',
          'Knockout stage: Final between Alice and Dave, 2 games in all.',
          'This was game 2 of the match. Score before it: Alice 1, Dave 0.',
          'Score after it: Alice 1½, Dave ½.',
          'This was the last game of the match.',
        ].join('\n'),
      );
    });
  });

  describe('nothing to say', () => {
    it('returns null when the game has no round', () => {
      const games = roundRobin();
      expect(contextFromAnalysis({ ...games[3], round: null }, analyseEvent(games, null))).toBeNull();
      expect(contextFromAnalysis({ ...games[3], round: '?' }, analyseEvent(games, null))).toBeNull();
    });

    it('returns null when the game is not in the analysis', () => {
      const a = analyseEvent(roundRobin(), null);
      expect(contextFromAnalysis(game(99, 1, 2, '1-0', '2'), a)).toBeNull();
      expect(contextFromAnalysis(game(4, 1, 2, '0-1', '7'), a)).toBeNull();
    });

    it('returns null for a loose collection of games', () => {
      const games = loose();
      const a = analyseEvent(games, null);
      expect(a.format).toBe('games');
      expect(contextFromAnalysis(games[0], a)).toBeNull();
    });
  });
});
