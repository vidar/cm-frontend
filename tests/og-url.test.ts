import { describe, expect, it } from 'vitest';
import { clipText, ogUrl, parseOgQuery, START_FEN, OG_LIMITS } from '../src/lib/og-url';

const query = (path: string) => new URL(path, 'https://chessmoments.com').searchParams;

describe('og card URLs', () => {
  const card = { fen: START_FEN, lastMove: ['e2', 'e4'], flip: true, kicker: 'Opening · C60', title: 'Ruy Lopez', subtitle: '1. e4 e5 2. Nf3 Nc6 3. Bb5', footer: 'Black to move' };

  it('reads back exactly the URL ogUrl builds', () => {
    const url = ogUrl(card);
    expect(url).toBe('/og.png?fen=rnbqkbnr%2Fpppppppp%2F8%2F8%2F8%2F8%2FPPPPPPPP%2FRNBQKBNR&t=Ruy+Lopez&lm=e2e4&flip=1&k=Opening+%C2%B7+C60&s=1.+e4+e5+2.+Nf3+Nc6+3.+Bb5&f=Black+to+move');
    const parsed = parseOgQuery(query(url))!;
    expect(parsed.canonical).toBe(url);
    expect(parsed.card).toEqual({ ...card, fen: START_FEN.split(' ')[0] });
  });

  it('points other spellings at the canonical URL', () => {
    const url = ogUrl(card);
    expect(parseOgQuery(query(`${url}&utm_source=x`))!.canonical).toBe(url);
    expect(parseOgQuery(query(`/og.png?t=Ruy%20Lopez&fen=${START_FEN.split(' ')[0]}&k=Opening+%C2%B7+C60&lm=e2e4&flip=1&s=1.+e4+e5+2.+Nf3+Nc6+3.+Bb5&f=Black+to+move`))!.canonical).toBe(url);
    const long = parseOgQuery(query(`/og.png?fen=8/8/8/8/8/8/8/8&t=${'x'.repeat(500)}&lm=zz`))!;
    expect(long.canonical).toBe(`/og.png?fen=8%2F8%2F8%2F8%2F8%2F8%2F8%2F8&t=${'x'.repeat(OG_LIMITS.title)}`);
  });

  it('refuses a card without a board or a title', () => {
    expect(parseOgQuery(query('/og.png?t=Hi'))).toBeNull();
    expect(parseOgQuery(query('/og.png?fen=8/8/8/8/8/8/8/8&t=%20'))).toBeNull();
    expect(parseOgQuery(query('/og.png?fen=<svg>&t=Hi'))).toBeNull();
  });

  it('clips texts so that clipping again changes nothing', () => {
    expect(clipText('  a \n b  ', 10)).toBe('a b');
    expect(clipText('abc def', 4)).toBe('abc');
    expect(clipText('😀😀😀', 2)).toBe('😀😀');
    expect(clipText(null, 5)).toBe('');
    const title = `${'Ünïcødé name '.repeat(10)}`;
    const once = parseOgQuery(query(ogUrl({ fen: START_FEN, title })))!;
    expect(parseOgQuery(query(once.canonical))!.canonical).toBe(once.canonical);
  });
});
