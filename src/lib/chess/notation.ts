/** Formats SAN moves as "1. e4 c5 2. Nf3". */
export function formatMoves(moves: string[]): string {
  return moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');
}

/** Formats a line that starts at a given ply (0 = White's first move), e.g. "6. Be3 e5 7. Nb3" or "6… e5 7. Nb3". */
export function formatMovesFrom(moves: string[], startPly: number): string {
  return moves
    .map((m, i) => {
      const ply = startPly + i;
      const n = Math.floor(ply / 2) + 1;
      if (ply % 2 === 0) return `${n}. ${m}`;
      return i === 0 ? `${n}… ${m}` : m;
    })
    .join(' ');
}

/** Engine score from White's point of view, e.g. "+0.32", "−1.10", "#3", "#-2". */
export function formatEval(e: { cp: number | null; mate: number | null }): string {
  if (e.mate !== null) return `#${e.mate}`;
  const v = (e.cp ?? 0) / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}
