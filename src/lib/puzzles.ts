import { Chess } from 'chess.js';
import data from '../data/puzzles.json';

// Curated from the Lichess puzzle database (CC0), see src/data/README.md.
export interface RawPuzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  gameUrl: string;
  opening: string | null;
}

export interface DailyPuzzle extends RawPuzzle {
  /** 1-based puzzle number. */
  number: number;
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** Position the solver faces (after the opponent's setup move). */
  startFen: string;
  /** "w" or "b": the side the solver plays. */
  solverColor: 'w' | 'b';
  /** The opponent's setup move, for highlighting. */
  setupMove: [string, string];
  /** Solution in SAN, alternating solver/opponent, starting with the solver. */
  solutionSan: string[];
}

const DAY = 86_400_000;
const START = Date.parse(`${data.start}T00:00:00Z`);
const PUZZLES = data.puzzles as RawPuzzle[];

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const firstDate = data.start;

/** Index (0-based) of the puzzle for a date, or -1 if outside the set. */
function indexFor(date: string) {
  const i = Math.round((Date.parse(`${date}T00:00:00Z`) - START) / DAY);
  return i >= 0 && i < PUZZLES.length ? i : -1;
}

/** Returns the puzzle for a date, or undefined if before launch, in the future, or out of range. */
export function getPuzzle(date: string, now = new Date()): DailyPuzzle | undefined {
  if (!isDate(date) || date > todayUtc(now)) return undefined;
  const i = indexFor(date);
  if (i < 0) return undefined;
  const raw = PUZZLES[i];
  const chess = new Chess(raw.fen);
  const [setup, ...solution] = raw.moves;
  chess.move({ from: setup.slice(0, 2), to: setup.slice(2, 4), promotion: setup[4] });
  const startFen = chess.fen();
  const solverColor = chess.turn();
  const solutionSan = solution.map((uci) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
  return {
    ...raw,
    number: i + 1,
    date,
    startFen,
    solverColor,
    setupMove: [setup.slice(0, 2), setup.slice(2, 4)],
    solutionSan,
  };
}

/** All published dates up to today, newest first. */
export function publishedDates(now = new Date()): string[] {
  const today = todayUtc(now);
  const dates: string[] = [];
  for (let i = 0; i < PUZZLES.length; i++) {
    const d = new Date(START + i * DAY).toISOString().slice(0, 10);
    if (d > today) break;
    dates.push(d);
  }
  return dates.reverse();
}

/** Seconds until the next UTC midnight (when the daily puzzle changes). */
export const secondsUntilNextPuzzle = (now = new Date()) =>
  Math.max(60, Math.floor((Math.floor(now.getTime() / DAY + 1) * DAY - now.getTime()) / 1000));

/** Human-readable theme names for Lichess theme keys. */
export function themeLabel(t: string) {
  return t.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
