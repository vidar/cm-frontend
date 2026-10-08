// Move classification from a stored engine analysis (src/lib/analysis.ts): the drop in winning
// chances for the side that moved, with Lichess's thresholds. Shared by the game page
// (src/scripts/game-analysis.ts) and the AI annotation prompt (src/lib/annotate.ts).

export type Ev = number | string | null;
export const LABEL = { blunder: '??', mistake: '?', inaccuracy: '?!' } as const;
export type Kind = keyof typeof LABEL;

/** White's winning chances, -1..1, from centipawns (White's view). */
export const winChance = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;

/** End-of-game value from the result, for the final position (which has no eval). */
const endOf = (result: string) => (result === '1-0' ? 1 : result === '0-1' ? -1 : 0);

/** Winning chances per position. */
export function winChances(e: Ev[], result: string) {
  const end = endOf(result);
  return e.map((v, i) => {
    if (v === null || v === undefined) return i === e.length - 1 ? end : 0;
    if (typeof v === 'string') return v.startsWith('#-') ? -1 : 1;
    return winChance(v);
  });
}

/** Centipawns per position, mates and the final position clamped to ±1000. */
export function centipawns(e: Ev[], result: string) {
  const end = endOf(result);
  return e.map((v, i) => {
    if (v === null || v === undefined) return i === e.length - 1 ? end * 1000 : 0;
    if (typeof v === 'string') return v.startsWith('#-') ? -1000 : 1000;
    return Math.max(-1000, Math.min(1000, v));
  });
}

export interface SideStats {
  blunder: number;
  mistake: number;
  inaccuracy: number;
  loss: number;
  n: number;
}

/**
 * kinds[ply] classifies the move that led to position `ply` (kinds[0] is always null).
 * `ucis[ply - 1]` is the move played at that ply, `best[ply - 1]` the engine's choice before it.
 */
export function classify(e: Ev[], best: (string | null)[], ucis: string[], result: string) {
  const wc = winChances(e, result);
  const cp = centipawns(e, result);
  const kinds: (Kind | null)[] = [null];
  const stats: Record<'w' | 'b', SideStats> = {
    w: { blunder: 0, mistake: 0, inaccuracy: 0, loss: 0, n: 0 },
    b: { blunder: 0, mistake: 0, inaccuracy: 0, loss: 0, n: 0 },
  };
  for (let p = 1; p <= ucis.length && p < wc.length; p++) {
    const white = p % 2 === 1;
    const s = white ? stats.w : stats.b;
    const sign = white ? 1 : -1;
    s.loss += Math.max(0, (cp[p - 1] - cp[p]) * sign);
    s.n++;
    const drop = (wc[p - 1] - wc[p]) * sign;
    const b = best[p - 1];
    const kind: Kind | null = b && b === ucis[p - 1] ? null : drop >= 0.3 ? 'blunder' : drop >= 0.2 ? 'mistake' : drop >= 0.1 ? 'inaccuracy' : null;
    kinds.push(kind);
    if (kind) s[kind]++;
  }
  return { kinds, stats, wc };
}

/** "+0.35", "-1.20", "#3", "#-2", or "–". */
export const fmtEval = (v: Ev) => (v === null || v === undefined ? '–' : typeof v === 'string' ? v : `${v > 0 ? '+' : ''}${(v / 100).toFixed(2)}`);
