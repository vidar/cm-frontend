import { describe, expect, it } from 'vitest';
import { getOpenings, lineLabel } from '../src/lib/openings';
import { pvToSan } from '../src/lib/opening-stats';

const bySlug = (slug: string) => getOpenings().find((o) => o.slug === slug)!;

describe('opening slugs and titles', () => {
  it('keeps the slugs of shared names (they are URLs, and scripts/twic/build.py tags games with them)', () => {
    const najdorf = (n: string) => bySlug(`sicilian-defense-najdorf-variation${n}`).moves.slice(8).join(' ');
    expect(najdorf('')).toBe('Nc3 a6');
    expect(najdorf('-2')).toBe('Nc3 a6 Bg5');
    expect(najdorf('-3')).toBe('Nc3 a6 Bg5 e6');
    expect(najdorf('-4')).toBe('Nc3 a6 Bg5 e6 f4');
    expect(najdorf('-5')).toBe('Nc3 a6 Bg5 e6 f4 Be7');
    expect(bySlug('italian-game-classical-variation-giuoco-pianissimo-17').moves.join(' ')).toBe('e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 O-O c3 d5');
  });

  it('gives every page a unique slug and a unique title', () => {
    const all = getOpenings();
    expect(new Set(all.map((o) => o.slug)).size).toBe(all.length);
    expect(new Set(all.map((o) => o.title)).size).toBe(all.length);
  });

  it('adds the distinguishing moves to shared names only', () => {
    expect(bySlug('sicilian-defense-najdorf-variation').title).toBe('Sicilian Defense: Najdorf Variation (5. Nc3 a6)');
    expect(bySlug('sicilian-defense-najdorf-variation-2').title).toBe('Sicilian Defense: Najdorf Variation (5… a6 6. Bg5)');
    expect(bySlug('sicilian-defense-najdorf-variation-3').title).toBe('Sicilian Defense: Najdorf Variation (6. Bg5 e6)');
    const ruy = bySlug('ruy-lopez');
    expect(ruy.tail).toBeUndefined();
    expect(ruy.title).toBe(ruy.name);
    expect(lineLabel(bySlug('sicilian-defense-najdorf-variation-3'))).toBe('Najdorf Variation (6. Bg5 e6)');
    expect(lineLabel(ruy)).toBe(ruy.name);
  });
});

describe('pvToSan', () => {
  it('reads castling written as king takes rook (Lichess evaluations)', () => {
    // /openings/ruy-lopez/: the line used to stop at 4. O-O.
    expect(pvToSan(bySlug('ruy-lopez'), ['g8f6', 'e1h1', 'f6e4', 'f1e1', 'e4d6', 'f3e5', 'c6e5', 'e1e5'])).toEqual(['Nf6', 'O-O', 'Nxe4', 'Re1', 'Nd6', 'Nxe5']);
    // Black castles first, and queenside castling.
    expect(pvToSan({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1' }, ['e8h8', 'e1a1', 'a8c8'])).toEqual(['O-O', 'O-O-O', 'Rac8+']);
    // The king's own square is still read as before.
    expect(pvToSan({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' }, ['e1g1', 'e8c8'])).toEqual(['O-O', 'O-O-O']);
  });

  it('stops at the first move it cannot play', () => {
    expect(pvToSan({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' }, ['a1a8', 'e8h8'])).toEqual(['Rxa8+']);
  });
});
