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
/** Longest game accepted, in half-moves (the longest real games have about 540; each costs CPU to replay). */
export const MAX_PLIES = 1000;

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

/**
 * Cuts to `max` characters (code points, so an emoji is never cut in half) and drops lone surrogates: Postgres
 * refuses a JSON string holding one ("\ud83d"), which would make a tournament impossible to publish.
 */
export const cut = (s: string, max: number) => Array.from(s.replace(/\p{Cs}/gu, '')).slice(0, max).join('').trim();

const clean = (s: string | undefined, max = 100) => {
  // Angle brackets and control characters never belong in a name; dropping them keeps markup out of every page and prompt.
  // Format characters (bidi overrides, zero-width spaces and joiners) are invisible: they go too, so two names that
  // look the same are the same.
  const v = (s ?? '').replace(/\p{Cf}/gu, '').replace(/[<>\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return v && v !== '?' && v !== '-' ? cut(v, max) || null : null;
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

/**
 * Parses one game; a string is an error message. `cost.plies` counts every move replayed, also those of a game
 * that then fails on an illegal move: replaying is what costs CPU, so the caller caps it per file.
 */
export function parseGame(text: string, cost?: { plies: number }): ParsedGame | string {
  const tags: Record<string, string> = {};
  const body: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(line);
    if (m) tags[m[1]] = m[2].replace(/\\(.)/g, '$1');
    else if (!line.startsWith('%')) body.push(line); // '%' in column 1 is an escape line (PGN standard 6)
  }
  if (tags.FEN || (tags.SetUp && tags.SetUp !== '0')) return 'games from a set-up position are not supported';
  if (tags.Variant && !/^standard$/i.test(tags.Variant)) return `variant "${tags.Variant}" is not supported`;
  const white = clean(tags.White);
  const black = clean(tags.Black);
  if (!white || !black) return 'missing White or Black name';
  const moves = tokens(body.join('\n'));
  if (moves.length > MAX_PLIES) return `longer than ${MAX_PLIES / 2} moves`;
  const chess = new Chess();
  const sans: string[] = [];
  for (const t of moves) {
    if (cost) cost.plies++;
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

// ---- reading files ---------------------------------------------------------------------------

/** Windows-1252 bytes 0x80-0x9F (the rest of the code page is Latin-1); unassigned ones map to themselves (WHATWG). */
const CP1252 = '\u20ac\x81\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\x8d\u017d\x8f\x90\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\x9d\u017e\u0178';

const fromCodes = (codes: Uint16Array) => {
  let s = '';
  for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode(...codes.subarray(i, i + 8192));
  return s;
};

export type PgnEncoding = 'UTF-8' | 'UTF-16' | 'Windows-1252';

/**
 * Text of an uploaded PGN file. ChessBase and Swiss-Manager often save Windows-1252 ("ANSI") or Latin-1, some
 * Windows tools UTF-16: UTF-16 is recognised by its byte order mark (or, without one, by the NUL byte next to the
 * file's first character), UTF-8 is used when the bytes are valid UTF-8, and anything else is read as
 * Windows-1252 (a superset of Latin-1 for every letter). A byte order mark is dropped.
 */
export function decodePgn(bytes: Uint8Array): { text: string; encoding: PgnEncoding } {
  const [a, b] = bytes;
  const le = a === 0xff && b === 0xfe ? 2 : bytes.length >= 2 && a !== 0 && b === 0 ? 0 : -1;
  const be = a === 0xfe && b === 0xff ? 2 : bytes.length >= 2 && a === 0 && b !== 0 ? 0 : -1;
  if (le >= 0 || be >= 0) {
    const start = Math.max(le, be);
    const codes = new Uint16Array((bytes.length - start) >> 1);
    for (let i = 0; i < codes.length; i++) {
      const [x, y] = [bytes[start + 2 * i], bytes[start + 2 * i + 1]];
      codes[i] = le >= 0 ? x | (y << 8) : (x << 8) | y;
    }
    return { text: fromCodes(codes), encoding: 'UTF-16' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    const codes = new Uint16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) codes[i] = bytes[i] >= 0x80 && bytes[i] < 0xa0 ? CP1252.charCodeAt(bytes[i] - 0x80) : bytes[i];
    return { text: fromCodes(codes), encoding: 'Windows-1252' };
  }
}

// ---- names -----------------------------------------------------------------------------------

/** Cyrillic (Russian, Ukrainian, Belarusian, Serbian, Macedonian, Bulgarian) and Greek letters in Latin script. */
const TRANSLIT: Record<string, string> = {};
{
  const pairs = (
    'а a б b в v г g ґ g д d ђ dj е e ё e є ye ж zh з z ѕ dz и i і i ї yi й y ј j к k л l љ lj м m н n њ nj о o п p р r ' +
    'с s т t ћ c ќ kj ѓ gj у u ў u ф f х kh ц ts ч ch џ dz ш sh щ shch ъ - ы y ь - э e ю yu я ya ' +
    'α a β v γ g δ d ε e ζ z η i θ th ι i κ k λ l μ m ν n ξ x ο o π p ρ r σ s ς s τ t υ y φ f χ ch ψ ps ω o'
  ).split(' ');
  for (let i = 0; i < pairs.length; i += 2) TRANSLIT[pairs[i]] = pairs[i + 1] === '-' ? '' : pairs[i + 1]; // ъ, ь: nothing
}

/**
 * A name in lower-case Latin letters for slugs and search ("Чемпионат клуба" -> "chempionat kluba",
 * "Παπαδόπουλος" -> "papadopoulos"); other scripts and Latin letters are kept (slugify then strips accents).
 */
export function translit(s: string) {
  const lower = s.normalize('NFC').toLowerCase().replace(/ο[υύ]/g, 'ou');
  return Array.from(lower, (c) => TRANSLIT[c] ?? TRANSLIT[c.normalize('NFD')[0]] ?? c).join('');
}
