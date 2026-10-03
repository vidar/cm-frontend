// Per-opening statistics and engine evaluations, generated offline by scripts/opening-stats.py
// and scripts/opening-evals.mjs (Lichess data, CC0). Only imported by prerendered pages, so the
// data never ships in the Worker bundle.
import statsData from '../data/opening-stats.json';
import evalsData from '../data/opening-evals.json';
import { Chess } from 'chess.js';
import type { Opening } from './openings';

export type Wdb = [number, number, number]; // white wins, draws, black wins

export interface LineStats {
  n: number;
  /** Results per rating band (see `bands`). */
  r: Wdb[];
  /** Most played next moves: [san, games, white, draw, black]. */
  next: [string, number, number, number, number][];
  top: {
    url: string;
    white: string;
    whiteElo: number;
    whiteTitle: string | null;
    black: string;
    blackElo: number;
    blackTitle: string | null;
    result: string;
    date: string;
    tc: string;
  }[];
}

export interface EngineEval {
  cp: number | null;
  mate: number | null;
  depth: number;
  /** Principal variation in UCI. */
  pv: string[];
}

const lines = (statsData as { lines: Record<string, LineStats> }).lines;
const evals = (evalsData as { evals: Record<string, EngineEval | null> }).evals;

export const statsSource = statsData.source as string;
export const sample = statsData.sample as { gamesRead: number; gamesCounted: number };
export const bands = statsData.bands as string[];

export const getStats = (o: Opening): LineStats | undefined => lines[o.moves.join(' ')];
export const getEval = (o: Opening): EngineEval | undefined => evals[o.moves.join(' ')] ?? undefined;

/** Converts the first `max` moves of a UCI line to SAN from the opening's position. */
export function pvToSan(o: Opening, pv: string[], max = 6): string[] {
  const chess = new Chess(o.fen);
  const san: string[] = [];
  for (const uci of pv.slice(0, max)) {
    try {
      san.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return san;
}

export const sumWdb = (rows: Wdb[]): Wdb =>
  rows.reduce<Wdb>((acc, r) => [acc[0] + r[0], acc[1] + r[1], acc[2] + r[2]], [0, 0, 0]);

/** Percentages that add up to 100. */
export function percents([w, d, b]: Wdb): Wdb {
  const n = w + d + b;
  if (!n) return [0, 0, 0];
  const pw = Math.round((w / n) * 100);
  const pb = Math.round((b / n) * 100);
  return [pw, 100 - pw - pb, pb];
}
