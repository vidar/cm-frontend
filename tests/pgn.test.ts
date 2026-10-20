// Tests for src/lib/pgn.ts: splitting a PGN file into games (splitPgn), Date tags (normDate), reading one
// game's tags and replaying its mainline with chess.js (parseGame), whole-file parsing with 1-based problem
// numbering (parsePgn) and round numbers from Round tags (roundOf). Pure functions; fixtures are small
// hand-written games with expected values worked out by hand.
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { normDate, parseGame, parsePgn, roundOf, splitPgn, type ParsedGame } from '../src/lib/pgn';

const WHITE = 'Carlsen, Magnus';
const BLACK = 'Nakamura, Hikaru';

/** One game's text: tags (White/Black filled in unless overridden; undefined drops a tag) and movetext. */
function game(movetext: string, tags: Record<string, string | undefined> = {}): string {
  const all: Record<string, string | undefined> = { White: WHITE, Black: BLACK, ...tags };
  const head = Object.entries(all)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n');
  return `${head}\n\n${movetext}`;
}

/** parseGame that must succeed. */
function parsed(text: string): ParsedGame {
  const r = parseGame(text);
  if (typeof r === 'string') throw new Error(`parseGame failed: ${r}`);
  return r;
}

/** The mainline as chess.js itself serialises it. */
function san(moves: string[]): string {
  const c = new Chess();
  for (const m of moves) c.move(m);
  return c.history().join(' ');
}

describe('splitPgn', () => {
  const g1 = '[White "a"]\n[Black "b"]\n\n1. e4 e5 *';
  const g2 = '[White "c"]\n[Black "d"]\n\n1. d4 d5 *';

  it('returns a single game as is', () => {
    expect(splitPgn(g1)).toEqual([g1]);
  });

  it('splits two games at the tag line that follows movetext', () => {
    const games = splitPgn(`${g1}\n\n${g2}\n`);
    expect(games).toHaveLength(2);
    expect(games[0].trim()).toBe(g1);
    expect(games[1].trim()).toBe(g2);
  });

  it('strips a byte-order mark', () => {
    expect(splitPgn(`﻿${g1}`)).toEqual([g1]);
  });

  it('accepts CRLF line endings and joins lines with LF', () => {
    const games = splitPgn([g1, '', g2, ''].join('\n').replace(/\n/g, '\r\n'));
    expect(games).toHaveLength(2);
    expect(games.some((g) => g.includes('\r'))).toBe(false);
    expect(games[0].trim()).toBe(g1);
    expect(parsed(games[1]).white).toBe('c');
  });

  it('keeps movetext split over several lines in one game', () => {
    const text = '[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 Nc6\n3. Bb5 a6\n4. Ba4 Nf6 *';
    expect(splitPgn(text)).toEqual([text]);
    expect(parsed(text).plies).toBe(8);
  });

  it('merges a tag-only block without any movetext into the following game', () => {
    // A game only starts at a tag line that follows movetext, so tags with no movetext (not even a
    // result) are read together with the next game's tags, which then take precedence.
    const games = splitPgn(`[White "a"]\n[Black "b"]\n\n${g2}`);
    expect(games).toHaveLength(1);
    expect(parsed(games[0]).white).toBe('c');
  });

  it('counts a lone result as movetext, so a game without moves ends', () => {
    const games = splitPgn(`[White "a"]\n[Black "b"]\n\n*\n\n${g2}`);
    expect(games).toHaveLength(2);
    expect(parsed(games[0])).toMatchObject({ white: 'a', plies: 0, result: '*' });
    expect(parsed(games[1]).white).toBe('c');
  });

  it('does not count % escape lines as movetext', () => {
    const text = `% exported by a test\n[White "a"]\n% between the tags\n[Black "b"]\n\n1. e4 e5 *\n% after the game\n${g2}`;
    const games = splitPgn(text);
    expect(games).toHaveLength(2);
    expect(games[0]).toContain('[Black "b"]');
    expect(games[1]).toBe(g2);
  });

  it('ignores leading and trailing blank lines', () => {
    const games = splitPgn(`\n\n  \n${g1}\n\n\n`);
    expect(games).toHaveLength(1);
    expect(games[0].trim()).toBe(g1);
  });

  it('returns nothing for an empty or blank file', () => {
    expect(splitPgn('')).toEqual([]);
    expect(splitPgn('\n\n  \n')).toEqual([]);
  });
});

describe('normDate', () => {
  it('converts a full date', () => {
    expect(normDate('2026.10.09')).toBe('2026-10-09');
  });

  it('keeps year and month when the day is unknown', () => {
    expect(normDate('2026.10.??')).toBe('2026-10');
  });

  it('keeps the year when the month is unknown', () => {
    expect(normDate('2026.??.??')).toBe('2026');
  });

  it('is null when the year is unknown', () => {
    expect(normDate('????.??.??')).toBeNull();
  });

  it('is null for a missing or empty tag', () => {
    expect(normDate(undefined)).toBeNull();
    expect(normDate('')).toBeNull();
  });

  it('accepts years 1800 to 2100 only', () => {
    expect(normDate('1799.01.01')).toBeNull();
    expect(normDate('1800.01.01')).toBe('1800-01-01');
    expect(normDate('2100.12.31')).toBe('2100-12-31');
    expect(normDate('2101.01.01')).toBeNull();
  });

  it('drops an impossible month and the day after it', () => {
    expect(normDate('2026.13.01')).toBe('2026');
    expect(normDate('2026.00.01')).toBe('2026');
  });

  it('only checks that the day is 1 to 31, not the length of the month', () => {
    // No calendar validation: 31 February is kept (dates are stored as text, as a prefix-preserving key).
    expect(normDate('2026.02.31')).toBe('2026-02-31');
    expect(normDate('2026.02.32')).toBe('2026-02');
    expect(normDate('2026.02.00')).toBe('2026-02');
  });

  it('requires two-digit month and day', () => {
    expect(normDate('2026.1.5')).toBe('2026');
    expect(normDate('2026.10.5')).toBe('2026-10');
    expect(normDate('2026')).toBe('2026');
  });

  it('does not accept dashes as separators', () => {
    expect(normDate('2026-10-09')).toBeNull();
  });
});

describe('parseGame', () => {
  it('reads the names and replays the mainline', () => {
    expect(parsed(game('1. e4 c5 2. Nf3 *'))).toMatchObject({
      white: WHITE,
      black: BLACK,
      moves: 'e4 c5 Nf3',
      plies: 3,
      result: '*',
    });
  });

  it('re-serialises moves as chess.js SAN', () => {
    // Long algebraic, "from-to" with a dash, an explicit capture square and over-disambiguation all
    // come out in standard SAN.
    const r = parsed(game('1.e2e4 c7c5 2.Ng1f3 d7d6 3.d2-d4 cxd4 4.Nf3xd4 Ngf6 *'));
    const expected = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'];
    expect(r.moves).toBe(san(expected));
    expect(r.moves).toBe('e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6');
    expect(r.plies).toBe(8);
  });

  it('accepts move numbers without spaces and black move numbers', () => {
    expect(parsed(game('1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 *'))).toMatchObject({ plies: 7 });
    expect(parsed(game('1. e4 {open} 1... c5 2. Nf3 *'))).toMatchObject({ moves: 'e4 c5 Nf3', plies: 3 });
  });

  it('unescapes quotes and backslashes in tag values', () => {
    const text = String.raw`[White "O\"Neil, Pat"]
[Black "A \\ B"]

1. e4 *`;
    expect(parsed(text)).toMatchObject({ white: 'O"Neil, Pat', black: 'A \\ B' });
  });

  it('collapses whitespace in names and truncates them to 100 characters', () => {
    const long = 'x'.repeat(120);
    const r = parsed(game('*', { White: '  Carlsen,   Magnus ', Black: long }));
    expect(r.white).toBe('Carlsen, Magnus');
    expect(r.black).toBe('x'.repeat(100));
  });

  it('drops brace and semicolon comments, even ones that contain moves', () => {
    const text = game('1. e4 {a comment with 1... e5 2. Nf3 in it} c5 ; to end of line 2. d4 d5\n2. Nf3 {multi\nline\n3. d4} d6 *');
    expect(parsed(text)).toMatchObject({ moves: 'e4 c5 Nf3 d6', plies: 4 });
  });

  it('drops nested variations', () => {
    const text = game('1. e4 e5 (1... c5 2. Nf3 (2. c3 d5 (2... Nf6)) d6) 2. Nf3 (2. f4 exf4) Nc6 *');
    expect(parsed(text)).toMatchObject({ moves: 'e4 e5 Nf3 Nc6', plies: 4 });
  });

  it('drops NAGs', () => {
    expect(parsed(game('1. e4 $1 e5 $14 2. Nf3 $140 Nc6 *'))).toMatchObject({ moves: 'e4 e5 Nf3 Nc6', plies: 4 });
  });

  it('drops ! and ? annotation suffixes', () => {
    const r = parsed(game('1. e4!? e5?! 2. Nf3!! Nc6?? 3. Bb5! a6? *'));
    expect(r.moves).toBe('e4 e5 Nf3 Nc6 Bb5 a6');
    expect(r.plies).toBe(6);
  });

  it('accepts castling written with zeros', () => {
    const r = parsed(game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 Nf6 5. d3 d6 6. Nc3 Bg4 7. Be3 Qd7 8. Qd2 0-0-0 *'));
    const expected = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'Nc3', 'Bg4', 'Be3', 'Qd7', 'Qd2', 'O-O-O'];
    expect(r.moves).toBe(san(expected));
    expect(r.moves).toBe('e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 d6 Nc3 Bg4 Be3 Qd7 Qd2 O-O-O');
    expect(r.plies).toBe(16);
  });

  it('accepts promotions', () => {
    const queen = parsed(game('1. d4 e5 2. dxe5 Ke7 3. e6 Kf6 4. e7 Kg6 5. e8=Q *'));
    expect(queen.moves).toBe('d4 e5 dxe5 Ke7 e6 Kf6 e7 Kg6 e8=Q');
    expect(queen.plies).toBe(9);
    const knight = parsed(game('1. d4 e5 2. dxe5 Ke7 3. e6 Kf6 4. e7 Kg6 5. e8=N *'));
    expect(knight.moves.split(' ').at(-1)).toBe('e8=N');
    const capture = parsed(game('1. e4 f5 2. exf5 g6 3. fxg6 Nf6 4. gxh7 Rg8 5. hxg8=Q *'));
    expect(capture.moves.split(' ').at(-1)).toBe('hxg8=Q');
    expect(capture.plies).toBe(9);
  });

  it('writes check and mate suffixes from the position, whether or not the file had them', () => {
    expect(parsed(game('1. e4 e5 2. Nf3 d6 3. Bb5 *')).moves).toBe('e4 e5 Nf3 d6 Bb5+');
    expect(parsed(game('1. e4 e5 2. Nf3 d6 3. Bb5+ *')).moves).toBe('e4 e5 Nf3 d6 Bb5+');
    expect(parsed(game('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0')).moves).toBe('e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#');
    expect(parsed(game('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7 1-0')).moves).toBe('e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#');
  });

  describe('result', () => {
    it('comes from the Result tag when it is valid', () => {
      expect(parsed(game('1. e4 0-1', { Result: '1-0' })).result).toBe('1-0');
      expect(parsed(game('1. e4 1-0', { Result: '*' })).result).toBe('*');
      expect(parsed(game('1. e4 *', { Result: ' 1/2-1/2 ' })).result).toBe('1/2-1/2');
    });

    it('falls back to the movetext terminator', () => {
      expect(parsed(game('1. e4 1/2-1/2')).result).toBe('1/2-1/2');
      expect(parsed(game('1. e4 0-1', { Result: '?' })).result).toBe('0-1');
      expect(parsed(game('1. e4 e5\n1-0')).result).toBe('1-0');
    });

    it('is * when neither tag nor terminator give one', () => {
      expect(parsed(game('1. e4 e5')).result).toBe('*');
      expect(parsed(game('1. e4 e5', { Result: 'draw' })).result).toBe('*');
    });

    it('does not read the terminator as a move', () => {
      expect(parsed(game('1. e4 e5 1-0'))).toMatchObject({ moves: 'e4 e5', plies: 2, result: '1-0' });
    });
  });

  it('accepts Elo ratings from 100 to 3500 only', () => {
    expect(parsed(game('*', { WhiteElo: '99', BlackElo: '3501' }))).toMatchObject({ whiteElo: null, blackElo: null });
    expect(parsed(game('*', { WhiteElo: '100', BlackElo: '3500' }))).toMatchObject({ whiteElo: 100, blackElo: 3500 });
    expect(parsed(game('*', { WhiteElo: '2850' }))).toMatchObject({ whiteElo: 2850, blackElo: null });
    expect(parsed(game('*', { WhiteElo: '?', BlackElo: '' }))).toMatchObject({ whiteElo: null, blackElo: null });
    expect(parsed(game('*', { WhiteElo: 'unrated' })).whiteElo).toBeNull();
  });

  it('keeps titles, truncated to 4 characters', () => {
    expect(parsed(game('*', { WhiteTitle: 'GM', BlackTitle: ' WGM ' }))).toMatchObject({ whiteTitle: 'GM', blackTitle: 'WGM' });
    expect(parsed(game('*', { WhiteTitle: 'Grandmaster' })).whiteTitle).toBe('Gran');
    expect(parsed(game('*', { WhiteTitle: '?', BlackTitle: '-' }))).toMatchObject({ whiteTitle: null, blackTitle: null });
    expect(parsed(game('*'))).toMatchObject({ whiteTitle: null, blackTitle: null });
  });

  it('reads FIDE ids as positive integers', () => {
    expect(parsed(game('*', { WhiteFideId: '1503014', BlackFideId: '2016192' }))).toMatchObject({ whiteFide: 1503014, blackFide: 2016192 });
    expect(parsed(game('*', { WhiteFideId: '0', BlackFideId: '?' }))).toMatchObject({ whiteFide: null, blackFide: null });
    expect(parsed(game('*', { WhiteFideId: '2000000000', BlackFideId: '2000000001' }))).toMatchObject({ whiteFide: 2000000000, blackFide: null });
    expect(parsed(game('*'))).toMatchObject({ whiteFide: null, blackFide: null });
  });

  it('takes the federation from WhiteFed, else WhiteCountry', () => {
    expect(parsed(game('*', { WhiteFed: 'NOR', BlackCountry: 'USA' }))).toMatchObject({ whiteFed: 'NOR', blackFed: 'USA' });
    expect(parsed(game('*', { WhiteFed: 'NOR', WhiteCountry: 'SWE' })).whiteFed).toBe('NOR');
    expect(parsed(game('*', { WhiteFed: 'GERMANY' })).whiteFed).toBe('GER');
    expect(parsed(game('*', { WhiteFed: '?', BlackCountry: '-' }))).toMatchObject({ whiteFed: null, blackFed: null });
    expect(parsed(game('*'))).toMatchObject({ whiteFed: null, blackFed: null });
  });

  it('reads team names', () => {
    const r = parsed(game('*', { WhiteTeam: 'Oslo   Schakselskap', BlackTeam: '-' }));
    expect(r).toMatchObject({ whiteTeam: 'Oslo Schakselskap', blackTeam: null });
    expect(parsed(game('*'))).toMatchObject({ whiteTeam: null, blackTeam: null });
  });

  it('reads the Round tag, truncated to 20 characters', () => {
    expect(parsed(game('*', { Round: '7.3' })).round).toBe('7.3');
    expect(parsed(game('*', { Round: '?' })).round).toBeNull();
    expect(parsed(game('*', { Round: '-' })).round).toBeNull();
    expect(parsed(game('*', { Round: '1'.repeat(25) })).round).toBe('1'.repeat(20));
    expect(parsed(game('*')).round).toBeNull();
  });

  it('reads the Date tag', () => {
    expect(parsed(game('*', { Date: '2026.10.09' })).date).toBe('2026-10-09');
    expect(parsed(game('*', { Date: '2026.??.??' })).date).toBe('2026');
    expect(parsed(game('*')).date).toBeNull();
  });

  it('keeps only well-formed ECO codes', () => {
    expect(parsed(game('*', { ECO: 'B90' })).eco).toBe('B90');
    expect(parsed(game('*', { ECO: 'E99' })).eco).toBe('E99');
    expect(parsed(game('*', { ECO: 'B9' })).eco).toBeNull();
    expect(parsed(game('*', { ECO: 'B901' })).eco).toBeNull();
    expect(parsed(game('*', { ECO: 'F00' })).eco).toBeNull();
    expect(parsed(game('*', { ECO: 'b90' })).eco).toBeNull();
    expect(parsed(game('*', { ECO: '?' })).eco).toBeNull();
    expect(parsed(game('*')).eco).toBeNull();
  });

  it('rejects games from a set-up position', () => {
    const msg = 'games from a set-up position are not supported';
    expect(parseGame(game('1. Kf2 *', { FEN: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', SetUp: '1' }))).toBe(msg);
    expect(parseGame(game('*', { FEN: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }))).toBe(msg);
    expect(parseGame(game('*', { SetUp: '1' }))).toBe(msg);
    expect(parsed(game('1. e4 *', { SetUp: '0' })).plies).toBe(1);
  });

  it('rejects variants other than standard chess', () => {
    expect(parseGame(game('1. e4 *', { Variant: 'Chess960' }))).toBe('variant "Chess960" is not supported');
    expect(parseGame(game('1. e4 *', { Variant: 'From Position' }))).toBe('variant "From Position" is not supported');
    expect(parsed(game('1. e4 *', { Variant: 'Standard' })).plies).toBe(1);
    expect(parsed(game('1. e4 *', { Variant: 'standard' })).plies).toBe(1);
  });

  it('rejects a game without both player names', () => {
    const msg = 'missing White or Black name';
    expect(parseGame(game('1. e4 *', { White: undefined }))).toBe(msg);
    expect(parseGame(game('1. e4 *', { Black: undefined }))).toBe(msg);
    expect(parseGame(game('1. e4 *', { White: '?' }))).toBe(msg);
    expect(parseGame(game('1. e4 *', { Black: '' }))).toBe(msg);
    expect(parseGame(game('1. e4 *', { Black: '   ' }))).toBe(msg);
  });

  it('reports an illegal or unreadable move with the number of half-moves played', () => {
    expect(parseGame(game('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. Kxe5 *'))).toBe(
      'illegal or unreadable move "Kxe5" after 8 half-moves',
    );
    expect(parseGame(game('1. e4 e4 *'))).toBe('illegal or unreadable move "e4" after 1 half-moves');
    expect(parseGame(game('1. xyz *'))).toBe('illegal or unreadable move "xyz" after 0 half-moves');
    // The token in the message is the cleaned one (suffixes stripped, castling normalised).
    expect(parseGame(game('1. e4 e5 2. 0-0!? *'))).toBe('illegal or unreadable move "O-O" after 2 half-moves');
  });

  it('accepts a game with no moves', () => {
    expect(parsed(game('*'))).toMatchObject({ moves: '', plies: 0, result: '*' });
    expect(parsed(game('1-0', { Result: '1-0' }))).toMatchObject({ moves: '', plies: 0, result: '1-0' });
    expect(parsed(game(''))).toMatchObject({ moves: '', plies: 0, result: '*' });
  });

  // PGN escape lines ("%" in column 1, PGN standard section 6) are dropped before the moves are read.

  it('ignores % escape lines inside the movetext', () => {
    expect(parsed(game('% a line for PGN scanners, not a move\n1. e4 e5 *'))).toMatchObject({ moves: 'e4 e5', plies: 2 });
  });
});

describe('parsePgn', () => {
  it('numbers games and problems from 1 in file order', () => {
    const text = [game('1. e4 c5 *', { White: 'a' }), game('1. e4 e4 *', { White: 'b' }), game('1. d4 d5 *', { White: 'c' })].join('\n\n');
    const { games, problems } = parsePgn(text);
    expect(games.map((g) => g.white)).toEqual(['a', 'c']);
    expect(games.map((g) => g.moves)).toEqual(['e4 c5', 'd4 d5']);
    expect(problems).toEqual([{ game: 2, message: 'illegal or unreadable move "e4" after 1 half-moves' }]);
  });

  it('reports every broken game with its own number', () => {
    const text = [
      game('1. e4 *', { White: '?' }),
      game('1. e4 *'),
      game('*', { FEN: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }),
    ].join('\n\n');
    const { games, problems } = parsePgn(text);
    expect(games).toHaveLength(1);
    expect(problems).toEqual([
      { game: 1, message: 'missing White or Black name' },
      { game: 3, message: 'games from a set-up position are not supported' },
    ]);
  });

  it('parses a single game', () => {
    const { games, problems } = parsePgn(`﻿${game('1. e4 c5 *')}\r\n`);
    expect(problems).toEqual([]);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ white: WHITE, moves: 'e4 c5', plies: 2 });
  });

  it('returns nothing for an empty file', () => {
    expect(parsePgn('')).toEqual({ games: [], problems: [] });
  });
});

describe('roundOf', () => {
  it('reads the round number before the first dot', () => {
    expect(roundOf('7')).toBe(7);
    expect(roundOf('7.3')).toBe(7);
    expect(roundOf('7.3.1')).toBe(7);
    expect(roundOf('1')).toBe(1);
  });

  it('is null when the round is absent or not a number', () => {
    expect(roundOf('')).toBeNull();
    expect(roundOf(null)).toBeNull();
    expect(roundOf('x')).toBeNull();
    expect(roundOf('?')).toBeNull();
  });

  it('is null for zero or negative rounds', () => {
    expect(roundOf('0')).toBeNull();
    expect(roundOf('0.1')).toBeNull();
    expect(roundOf('-1')).toBeNull();
  });
});
