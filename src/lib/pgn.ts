// PGN parsing for organiser uploads (src/lib/uploads.ts): splits a file into games, reads the tags and
// replays the mainline with chess.js (comments, variations and NAGs are dropped). Pure; no I/O.
import { Chess } from 'chess.js';

export interface ParsedGame {
  white: string;
  black: string;
  whiteElo: number | null;
  blackElo: number | null;
  whiteTitle: string | null;
  blackTitle: string | null;
  whiteFide: number | null;
  blackFide: number | null;
  whiteFed: string | null;
  blackFed: string | null;
  whiteTeam: string | null;
  blackTeam: string | null;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  date: string | null;
  round: string | null;
  eco: string | null;
  /** Mainline in SAN, space-separated. */
  moves: string;
  plies: number;
}

export interface PgnProblem {
  game: number;
  message: string;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/** Splits PGN text into the text of each game (a game starts at a tag line after movetext). */
export function splitPgn(text: string): string[] {
  const games: string[] = [];
  let cur: string[] = [];
  let seenMoves = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && seenMoves) {
      games.push(cur.join('\n'));
      cur = [];
      seenMoves = false;
    }
    if (line && !line.startsWith('[') && !line.startsWith('%')) seenMoves = true;
    cur.push(raw);
  }
  if (cur.join('').trim()) games.push(cur.join('\n'));
  return games.filter((g) => /\S/.test(g));
}

/** "2026.10.09" -> "2026-10-09"; keeps a valid prefix ("2026-10", "2026"); null when unknown. */
export function normDate(d: string | undefined): string | null {
  const [y, m, day] = (d ?? '').split('.');
  if (!/^\d{4}$/.test(y ?? '') || +y < 1800 || +y > 2100) return null;
  if (!/^\d{2}$/.test(m ?? '') || +m < 1 || +m > 12) return y;
  if (!/^\d{2}$/.test(day ?? '') || +day < 1 || +day > 31) return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

const clean = (s: string | undefined, max = 100) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v && v !== '?' && v !== '-' ? v.slice(0, max) : null;
};
const int = (s: string | undefined, lo: number, hi: number) => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** Movetext without comments, variations, NAGs, move numbers and the result. */
function tokens(movetext: string): string[] {
  let s = movetext.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  // Variations can nest: strip innermost first.
  for (let i = 0; i < 20 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, ' ');
  s = s.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ');
  return s
    .split(/\s+/)
    .filter((t) => t && !RESULTS.has(t))
    .map((t) => t.replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O'));
}

/** Parses one game; a string is an error message. */
export function parseGame(text: string): ParsedGame | string {
  const tags: Record<string, string> = {};
  const body: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(line);
    if (m) tags[m[1]] = m[2].replace(/\\(.)/g, '$1');
    else body.push(line);
  }
  if (tags.FEN || (tags.SetUp && tags.SetUp !== '0')) return 'games from a set-up position are not supported';
  if (tags.Variant && !/^standard$/i.test(tags.Variant)) return `variant "${tags.Variant}" is not supported`;
  const white = clean(tags.White);
  const black = clean(tags.Black);
  if (!white || !black) return 'missing White or Black name';
  const chess = new Chess();
  const sans: string[] = [];
  for (const t of tokens(body.join('\n'))) {
    try {
      sans.push(chess.move(t).san);
    } catch {
      return `illegal or unreadable move "${t}" after ${sans.length} half-moves`;
    }
  }
  const tagResult = (tags.Result ?? '').trim();
  const term = body.join(' ').trim().split(/\s+/).at(-1) ?? '';
  const result = (RESULTS.has(tagResult) ? tagResult : RESULTS.has(term) ? term : '*') as ParsedGame['result'];
  return {
    white,
    black,
    whiteElo: int(tags.WhiteElo, 100, 3500),
    blackElo: int(tags.BlackElo, 100, 3500),
    whiteTitle: clean(tags.WhiteTitle, 4),
    blackTitle: clean(tags.BlackTitle, 4),
    whiteFide: int(tags.WhiteFideId, 1, 2_000_000_000),
    blackFide: int(tags.BlackFideId, 1, 2_000_000_000),
    whiteFed: clean(tags.WhiteFed ?? tags.WhiteCountry, 3),
    blackFed: clean(tags.BlackFed ?? tags.BlackCountry, 3),
    whiteTeam: clean(tags.WhiteTeam),
    blackTeam: clean(tags.BlackTeam),
    result,
    date: normDate(tags.Date),
    round: clean(tags.Round, 20),
    eco: /^[A-E]\d\d$/.test(tags.ECO ?? '') ? tags.ECO : null,
    moves: sans.join(' '),
    plies: sans.length,
  };
}

/** Parses a PGN file: the games and the problems (by 1-based game number in the file). */
export function parsePgn(text: string) {
  const games: ParsedGame[] = [];
  const problems: PgnProblem[] = [];
  splitPgn(text).forEach((g, i) => {
    const r = parseGame(g);
    if (typeof r === 'string') problems.push({ game: i + 1, message: r });
    else games.push(r);
  });
  return { games, problems };
}

/** Round number from a Round tag ("5", "5.3", "5.3.2"); null when absent. */
export const roundOf = (round: string | null) => {
  const n = Number.parseInt((round ?? '').split('.')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
