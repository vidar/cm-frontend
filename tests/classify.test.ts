// Tests for src/lib/chess/classify.ts: winning chances from centipawns (winChance, winChances), clamped
// centipawns per position (centipawns), move classification with Lichess's 0.3/0.2/0.1 drop thresholds and
// per-side stats (classify), and eval formatting (fmtEval). Pure functions; the expected numbers are worked
// out from winChance(cp) = 2 / (1 + exp(-0.00368208 * cp)) - 1 (which is tanh(0.00184104 * cp)) and stated
// next to each assertion. The thresholds fall between integer centipawn values:
//   winChance(cp) = 0.3 at cp ≈ 168.12, = 0.2 at cp ≈ 110.12, = 0.1 at cp ≈ 54.50,
// so a drop from 0 to -169 is a blunder (0.30147) and to -168 a mistake (0.29980), and so on.
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { centipawns, classify, fmtEval, LABEL, winChance, winChances, type Ev, type Kind } from '../src/lib/chess/classify';

// Values of the formula used below (6 significant decimals; asserted with toBeCloseTo).
const WC = {
  10: 0.018408,
  20: 0.036804,
  30: -0.055175, // winChance(-30)
  50: 0.091793,
  54: 0.09909,
  55: 0.100913,
  100: 0.182052,
  110: 0.199791,
  111: 0.201557,
  168: 0.299795,
  169: 0.30147,
  200: 0.352423,
  1000: 0.950895,
  2000: 0.998734,
};

/** n placeholder UCI moves (classify only compares them with `best`). */
const moves = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);
/** n "no best move known" entries. */
const noBest = (n: number): (string | null)[] => Array(n).fill(null);

const zero = { blunder: 0, mistake: 0, inaccuracy: 0, loss: 0, n: 0 };

describe('LABEL', () => {
  it('maps kinds to their annotation glyphs', () => {
    expect(LABEL).toEqual({ blunder: '??', mistake: '?', inaccuracy: '?!' });
  });
});

describe('winChance', () => {
  it('is 0 at 0 cp', () => {
    // 2 / (1 + e^0) - 1 = 2 / 2 - 1 = 0, exactly
    expect(winChance(0)).toBe(0);
  });

  it('is an odd function (symmetric for the two sides)', () => {
    for (const cp of [1, 100, 300, 1000, 2500]) expect(winChance(-cp)).toBeCloseTo(-winChance(cp), 12);
  });

  it('matches hand-computed values', () => {
    // winChance(100) = 2 / (1 + e^-0.368208) - 1 = 0.182052
    expect(winChance(100)).toBeCloseTo(WC[100], 6);
    // winChance(200) = 2 / (1 + e^-0.736416) - 1 = 0.352423
    expect(winChance(200)).toBeCloseTo(WC[200], 6);
    // winChance(1000) = 2 / (1 + e^-3.68208) - 1 = 0.950895
    expect(winChance(1000)).toBeCloseTo(WC[1000], 6);
    expect(winChance(-1000)).toBeCloseTo(-WC[1000], 6);
    // winChance(1) = 0.001841
    expect(winChance(1)).toBeCloseTo(0.001841, 6);
  });

  it('approaches ±1 for large cp', () => {
    // winChance(2000) = 0.998734
    expect(winChance(2000)).toBeCloseTo(WC[2000], 6);
    expect(winChance(5000)).toBeGreaterThan(0.9999999);
    expect(winChance(5000)).toBeLessThanOrEqual(1);
    expect(winChance(-5000)).toBeLessThan(-0.9999999);
    expect(winChance(-5000)).toBeGreaterThanOrEqual(-1);
    // e^-36.8 vanishes against 1 in double precision, so the upper limit is reached exactly; on the
    // negative side 2 / (1 + e^36.8) is a representable ~2e-16, so -1 is only reached to 15 decimals.
    expect(winChance(10000)).toBe(1);
    expect(winChance(-10000)).toBeCloseTo(-1, 15);
  });

  it('is strictly increasing', () => {
    const cps = [-1000, -169, -168, -55, -54, 0, 54, 55, 110, 111, 168, 169, 1000];
    for (let i = 1; i < cps.length; i++) expect(winChance(cps[i])).toBeGreaterThan(winChance(cps[i - 1]));
  });
});

describe('winChances', () => {
  it('maps numbers through winChance', () => {
    const r = winChances([0, 100, -100, 1000], '*');
    expect(r).toHaveLength(4);
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(WC[100], 6);
    expect(r[2]).toBeCloseTo(-WC[100], 6);
    expect(r[3]).toBeCloseTo(WC[1000], 6);
  });

  it('maps mate strings to ±1 whatever the distance', () => {
    expect(winChances(['#3', '#-2', '#1', '#-15', '#0'], '*')).toEqual([1, -1, 1, -1, 1]);
  });

  it('maps a null in the middle to 0', () => {
    const r = winChances([50, null, 50], '*');
    expect(r[1]).toBe(0);
    expect(r[0]).toBeCloseTo(WC[50], 6);
    expect(r[2]).toBeCloseTo(WC[50], 6);
  });

  it('maps a null at the end from the result', () => {
    expect(winChances([0, null], '1-0')).toEqual([0, 1]);
    expect(winChances([0, null], '0-1')).toEqual([0, -1]);
    expect(winChances([0, null], '1/2-1/2')).toEqual([0, 0]);
    expect(winChances([0, null], '*')).toEqual([0, 0]);
  });

  it('applies the result only to the last position', () => {
    expect(winChances([null, null], '1-0')).toEqual([0, 1]);
    expect(winChances([null, 0], '0-1')).toEqual([0, 0]);
  });

  it('handles a single position and no positions', () => {
    expect(winChances([null], '0-1')).toEqual([-1]);
    expect(winChances([], '1-0')).toEqual([]);
  });

  it('treats undefined like null', () => {
    const e = [undefined, 0, undefined] as unknown as Ev[];
    expect(winChances(e, '1-0')).toEqual([0, 0, 1]);
  });
});

describe('centipawns', () => {
  it('passes small values through and clamps at ±1000', () => {
    expect(centipawns([0, 35, -120, 999, -999, 1000, -1000, 1001, -1001, 5000, -5000], '*')).toEqual([
      0, 35, -120, 999, -999, 1000, -1000, 1000, -1000, 1000, -1000,
    ]);
  });

  it('maps mates to ±1000', () => {
    expect(centipawns(['#3', '#-2', '#1', '#-20'], '*')).toEqual([1000, -1000, 1000, -1000]);
  });

  it('maps a null in the middle to 0 and the final null from the result', () => {
    expect(centipawns([10, null, 10, null], '1-0')).toEqual([10, 0, 10, 1000]);
    expect(centipawns([10, null], '0-1')).toEqual([10, -1000]);
    expect(centipawns([10, null], '1/2-1/2')).toEqual([10, 0]);
    expect(centipawns([10, null], '*')).toEqual([10, 0]);
  });

  it('handles a single position and no positions', () => {
    expect(centipawns([null], '1-0')).toEqual([1000]);
    expect(centipawns([], '1-0')).toEqual([]);
  });
});

describe('classify', () => {
  describe("thresholds on White's move (ply 1, eval from White's view)", () => {
    // From 0 (winChance 0) to the given cp; the drop is -winChance(cp).
    it.each<[number, number, Kind | null]>([
      [-169, 0.30147, 'blunder'], // just above 0.3
      [-168, 0.299795, 'mistake'], // just below 0.3
      [-111, 0.201557, 'mistake'], // just above 0.2
      [-110, 0.199791, 'inaccuracy'], // just below 0.2
      [-55, 0.100913, 'inaccuracy'], // just above 0.1
      [-54, 0.09909, null], // just below 0.1
      [0, 0, null], // no change
      [169, -0.30147, null], // White improved: a negative drop is never flagged
    ])('0 -> %i cp (drop %f) is %s', (cp, drop, kind) => {
      const r = classify([0, cp], noBest(1), moves(1), '*');
      expect(r.wc[0] - r.wc[1]).toBeCloseTo(drop, 6);
      expect(r.kinds).toEqual([null, kind]);
      expect(r.stats.w).toEqual({ ...zero, [kind ?? 'n']: 1, n: 1, loss: Math.max(0, -cp) });
      expect(r.stats.b).toEqual(zero);
    });
  });

  describe("thresholds on Black's move (ply 2, sign flipped)", () => {
    // White plays a neutral move (0 -> 0), then Black's move takes the eval from 0 to the given cp;
    // Black's drop is +winChance(cp).
    it.each<[number, number, Kind | null]>([
      [169, 0.30147, 'blunder'],
      [168, 0.299795, 'mistake'],
      [111, 0.201557, 'mistake'],
      [110, 0.199791, 'inaccuracy'],
      [55, 0.100913, 'inaccuracy'],
      [54, 0.09909, null],
      [0, 0, null],
      [-169, -0.30147, null], // Black improved
    ])('0 -> %i cp (drop %f for Black) is %s', (cp, drop, kind) => {
      const r = classify([0, 0, cp], noBest(2), moves(2), '*');
      expect((r.wc[1] - r.wc[2]) * -1).toBeCloseTo(drop, 6);
      expect(r.kinds).toEqual([null, null, kind]);
      expect(r.stats.w).toEqual({ ...zero, n: 1 });
      expect(r.stats.b).toEqual({ ...zero, [kind ?? 'n']: 1, n: 1, loss: Math.max(0, cp) });
    });

    it('does not flag Black for a White-sized drop in the wrong direction', () => {
      // Eval falls to -169 after Black's move: that is good for Black, so nothing is flagged even though
      // the same numbers on White's move would be a blunder.
      const r = classify([0, 0, -169], noBest(2), moves(2), '*');
      expect(r.kinds).toEqual([null, null, null]);
      expect(r.stats.b).toEqual({ ...zero, n: 1 });
    });
  });

  describe('best-move exemption', () => {
    it('does not flag a move that equals the engine best move, but still counts it', () => {
      const r = classify([0, -500], ['e2e4'], ['e2e4'], '*');
      expect(r.kinds).toEqual([null, null]);
      expect(r.stats.w).toEqual({ ...zero, n: 1, loss: 500 });
    });

    it('flags the same drop when the best move differs or is unknown', () => {
      expect(classify([0, -500], ['d2d4'], ['e2e4'], '*').kinds).toEqual([null, 'blunder']);
      expect(classify([0, -500], [null], ['e2e4'], '*').kinds).toEqual([null, 'blunder']);
      expect(classify([0, -500], [''], ['e2e4'], '*').kinds).toEqual([null, 'blunder']);
      expect(classify([0, -500], [], ['e2e4'], '*').kinds).toEqual([null, 'blunder']);
    });

    it('matches best against the move at the same ply only', () => {
      // Best for ply 1 is e2e4 but it was played at ply 2: ply 1 is flagged, ply 2 isn't exempt either.
      const r = classify([0, -169, -338], ['e2e4', 'e7e5'], ['d2d4', 'e2e4'], '*');
      expect(r.kinds[1]).toBe('blunder');
      // Black's move: eval went from -169 to -338, good for Black -> null on merit, not by exemption.
      expect(r.kinds[2]).toBeNull();
    });
  });

  describe('shape of the result', () => {
    it('has kinds[0] null and one entry per move', () => {
      const r = classify([0, 0, 0, 0, 0], noBest(4), moves(4), '*');
      expect(r.kinds[0]).toBeNull();
      expect(r.kinds).toHaveLength(5);
      expect(r.kinds).toEqual([null, null, null, null, null]);
    });

    it('returns the winning chances it used', () => {
      const e: Ev[] = [10, '#-2', null, 20, null];
      expect(classify(e, noBest(4), moves(4), '1-0').wc).toEqual(winChances(e, '1-0'));
    });

    it('handles no moves', () => {
      const r = classify([], [], [], '*');
      expect(r.kinds).toEqual([null]);
      expect(r.stats).toEqual({ w: zero, b: zero });
      expect(r.wc).toEqual([]);
      expect(classify([0], [], [], '*').kinds).toEqual([null]);
    });

    it('stops at the last eval when evals are shorter than the move list', () => {
      // 2 positions evaluated, 3 moves played: only the first move can be classified.
      const r = classify([0, -169], noBest(3), moves(3), '*');
      expect(r.kinds).toEqual([null, 'blunder']);
      expect(r.kinds).toHaveLength(2);
      expect(r.stats.w).toEqual({ ...zero, blunder: 1, loss: 169, n: 1 });
      expect(r.stats.b).toEqual(zero);
    });

    it('stops at the last move when evals are longer than the move list', () => {
      const r = classify([0, -169, -338, -500], noBest(1), moves(1), '*');
      expect(r.kinds).toEqual([null, 'blunder']);
      expect(r.stats.w).toEqual({ ...zero, blunder: 1, loss: 169, n: 1 });
      expect(r.stats.b).toEqual(zero);
    });
  });

  describe('stats', () => {
    it('counts moves per side and accumulates cp losses from the mover’s view', () => {
      // ply 1 (W): 20 -> -30, White loses 50; drop 0.036804 + 0.055175 = 0.091979 -> not flagged
      // ply 2 (B): -30 -> 50, Black loses 80; drop (−0.055175 − 0.091793) * −1 = 0.146968 -> inaccuracy
      // ply 3 (W): 50 -> 10, White loses 40; drop 0.091793 − 0.018408 = 0.073385 -> not flagged
      const r = classify([20, -30, 50, 10], noBest(3), moves(3), '*');
      expect(r.kinds).toEqual([null, null, 'inaccuracy', null]);
      expect(r.stats.w).toEqual({ ...zero, loss: 90, n: 2 });
      expect(r.stats.b).toEqual({ ...zero, inaccuracy: 1, loss: 80, n: 1 });
      expect(r.wc[0]).toBeCloseTo(WC[20], 6);
      expect(r.wc[1]).toBeCloseTo(WC[30], 6);
      expect(r.wc[2]).toBeCloseTo(WC[50], 6);
      expect(r.wc[3]).toBeCloseTo(WC[10], 6);
    });

    it('ignores gains (negative losses) but still counts the move', () => {
      // ply 1 (W): 0 -> 100, gain; ply 2 (B): 100 -> 100, nothing; ply 3 (W): 100 -> 50, loses 50;
      // ply 4 (B): 50 -> -300, Black gains 350.
      const r = classify([0, 100, 100, 50, -300], noBest(4), moves(4), '*');
      expect(r.stats.w).toEqual({ ...zero, loss: 50, n: 2 });
      expect(r.stats.b).toEqual({ ...zero, loss: 0, n: 2 });
      expect(r.kinds).toEqual([null, null, null, null, null]);
    });

    it('counts each kind for each side', () => {
      // W: 0 -> -169 (blunder); B: -169 -> 0 (blunder); W: 0 -> -111 (mistake); B: -111 -> 0 (mistake);
      // W: 0 -> -55 (inaccuracy); B: -55 -> 0 (inaccuracy). Each side loses 169 + 111 + 55 = 335 cp.
      const r = classify([0, -169, 0, -111, 0, -55, 0], noBest(6), moves(6), '*');
      expect(r.kinds).toEqual([null, 'blunder', 'blunder', 'mistake', 'mistake', 'inaccuracy', 'inaccuracy']);
      expect(r.stats.w).toEqual({ blunder: 1, mistake: 1, inaccuracy: 1, loss: 335, n: 3 });
      expect(r.stats.b).toEqual({ blunder: 1, mistake: 1, inaccuracy: 1, loss: 335, n: 3 });
    });

    it('uses clamped centipawns for the loss', () => {
      expect(classify([1500, 0], noBest(1), moves(1), '*').stats.w.loss).toBe(1000);
      expect(classify([0, -2500], noBest(1), moves(1), '*').stats.w.loss).toBe(1000);
      expect(classify(['#3', '#-2'], noBest(1), moves(1), '*').stats.w.loss).toBe(2000);
      expect(classify(['#3', '#-2'], noBest(1), moves(1), '*').kinds).toEqual([null, 'blunder']);
    });

    it('takes the final position from the result when it has no eval', () => {
      // White's last move leads to a position with no eval in a game Black won: cp 0 -> -1000,
      // winChance 0 -> -1, drop 1 -> blunder, loss 1000.
      const lost = classify([0, null], noBest(1), moves(1), '0-1');
      expect(lost.kinds).toEqual([null, 'blunder']);
      expect(lost.stats.w).toEqual({ ...zero, blunder: 1, loss: 1000, n: 1 });
      // The same move in a game White won: 0 -> 1, a gain.
      const won = classify([0, null], noBest(1), moves(1), '1-0');
      expect(won.kinds).toEqual([null, null]);
      expect(won.stats.w).toEqual({ ...zero, n: 1 });
      // Drawn: 0 -> 0.
      expect(classify([0, null], noBest(1), moves(1), '1/2-1/2').kinds).toEqual([null, null]);
    });
  });

  it('classifies a real game (Scholar’s mate) from its UCI moves', () => {
    const c = new Chess();
    for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) c.move(m);
    expect(c.isCheckmate()).toBe(true);
    const ucis = c.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
    expect(ucis).toEqual(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7']);
    // Engine agrees with every move except 6...Nf6?? (best was g7g6, say). Evals per position:
    const e: Ev[] = [30, 30, 30, 60, 60, 100, '#1', null];
    const best = ucis.map((u, i) => (i === 5 ? 'g7g6' : u));
    const r = classify(e, best, ucis, '1-0');
    // ply 6 (B): winChance(100) = 0.182052 -> 1, drop 0.817948 -> blunder; cp 100 -> 1000, loss 900.
    expect(r.kinds).toEqual([null, null, null, null, null, null, 'blunder', null]);
    expect((r.wc[5] - r.wc[6]) * -1).toBeCloseTo(1 - WC[100], 6);
    expect(r.stats.b).toEqual({ ...zero, blunder: 1, loss: 900, n: 3 });
    // White: 30 -> 30 (0), 30 -> 60 (gain), 60 -> 100 (gain), #1 (1000) -> final 1-0 (1000): no loss.
    expect(r.stats.w).toEqual({ ...zero, n: 4 });
    expect(r.wc[7]).toBe(1);
  });
});

describe('fmtEval', () => {
  it.each<[Ev | undefined, string]>([
    [35, '+0.35'],
    [-120, '-1.20'],
    [0, '0.00'],
    [1, '+0.01'],
    [-1, '-0.01'],
    [1234, '+12.34'],
    [-1000, '-10.00'],
    ['#3', '#3'],
    ['#-2', '#-2'],
    [null, '–'],
    [undefined, '–'],
  ])('%s -> %s', (v, s) => {
    expect(fmtEval(v as Ev)).toBe(s);
  });
});
