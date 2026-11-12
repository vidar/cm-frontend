// Pure parts of the game and player search (src/lib/game-search.ts, nameWords/nameMatch in src/lib/games.ts):
// parsing and building search URLs (player pins), ECO ranges, which players a typed name stands for,
// and the SQL each typed name turns into. Expected values are worked out by hand.
import { describe, expect, it } from 'vitest';
import { ecoRange, parseSearch, pickPlayers, searchUrl } from '../src/lib/game-search';
import { KEY_PARAMS } from '../src/lib/cache-key';
import { nameMatch, nameWords } from '../src/lib/games';

const sp = (s: string) => new URLSearchParams(s);

describe('nameWords', () => {
  it('slugifies a typed name into words, in the order typed, without repeats', () => {
    expect(nameWords('Giri, Anish')).toEqual(['giri', 'anish']);
    expect(nameWords('  Ánish   GIRI ')).toEqual(['anish', 'giri']);
    expect(nameWords("O'Brien")).toEqual(['obrien']);
    expect(nameWords('Kaan Kaan')).toEqual(['kaan']);
    expect(nameWords('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(nameWords(' - , ')).toEqual([]);
  });
});

describe('nameMatch', () => {
  it('needs every word somewhere in the name (one LIKE each); exact means the same words and length, with its parameters added only when used', () => {
    const params: (string | number)[] = [];
    const arg = (v: string | number) => {
      params.push(v);
      return `$${params.length}`;
    };
    const m = nameMatch(['giri', 'anish'], arg);
    expect(m.where).toBe('search LIKE $1 AND search LIKE $2');
    expect(params).toEqual(['%giri%', '%anish%']);
    expect(m.exact()).toBe(`(length(search) = $3 AND (' ' || search || ' ') LIKE $4 AND (' ' || search || ' ') LIKE $5)`);
    expect(params).toEqual(['%giri%', '%anish%', 10, '% giri %', '% anish %']);
  });
});

describe('ecoRange', () => {
  it('reads a code or a range, upper-cased, low end first', () => {
    expect(ecoRange('B90')).toEqual(['B90', 'B90']);
    expect(ecoRange('b90-b99')).toEqual(['B90', 'B99']);
    expect(ecoRange('B90 - B99')).toEqual(['B90', 'B99']);
    expect(ecoRange('E99-A00')).toEqual(['A00', 'E99']);
    expect(ecoRange('D99-D98')).toEqual(['D98', 'D99']);
  });

  it('is null for opening names and anything else', () => {
    expect(ecoRange('Najdorf')).toBeNull();
    expect(ecoRange('F00')).toBeNull();
    expect(ecoRange('B9')).toBeNull();
    expect(ecoRange('')).toBeNull();
  });
});

describe('parseSearch / searchUrl with player pins', () => {
  it('keeps a pin only with its name, and only when it looks like a slug', () => {
    expect(parseSearch(sp('white=Kaan+Akbas&wp=kaan-akbas-2'))).toMatchObject({ white: 'Kaan Akbas', whitePin: 'kaan-akbas-2', blackPin: '' });
    expect(parseSearch(sp('wp=kaan-akbas-2')).whitePin).toBe('');
    expect(parseSearch(sp('white=x&wp=Kaan%20Akbas')).whitePin).toBe('');
    expect(parseSearch(sp('white=x&wp=a--b')).whitePin).toBe('');
    expect(parseSearch(sp('black=Jiri+Maly&bp=jiri-maly-2'))).toMatchObject({ black: 'Jiri Maly', blackPin: 'jiri-maly-2' });
  });

  it('writes the pin next to its name and drops it without one', () => {
    const p = parseSearch(sp('white=Kaan+Akbas&any=1'));
    expect(searchUrl(p, { whitePin: 'kaan-akbas-2', page: 1 })).toBe('/games/search/?white=Kaan+Akbas&wp=kaan-akbas-2&any=1');
    expect(searchUrl(p, { white: '', whitePin: 'kaan-akbas-2' })).toBe('/games/search/?any=1');
    expect(searchUrl(parseSearch(sp('black=Jiri+Maly&bp=jiri-maly-2&page=3')))).toBe('/games/search/?black=Jiri+Maly&bp=jiri-maly-2&page=3');
    // Round trip.
    const url = new URL(searchUrl(parseSearch(sp('white=Kaan+Akbas&wp=kaan-akbas-2&black=Giri&bp=giri-a&sort=oldest'))), 'https://x');
    expect(parseSearch(url.searchParams)).toMatchObject({ whitePin: 'kaan-akbas-2', blackPin: 'giri-a', sort: 'oldest' });
  });

  it('pins are part of the edge-cache key (each namesake is its own page)', () => {
    expect(KEY_PARAMS.has('wp')).toBe(true);
    expect(KEY_PARAMS.has('bp')).toBe(true);
  });
});

describe('pickPlayers', () => {
  const row = (id: number, exact: boolean, pinned = false) => ({ id, name: `P${id}`, slug: `p${id}`, games: 100 - id, title: null, fed: null, exact, pinned });

  it('takes the pinned player when its name is exactly the typed one', () => {
    expect(pickPlayers([row(1, true), row(2, true, true), row(3, false)]).map((r) => r.id)).toEqual([2]);
  });

  it('ignores a pin whose name is not the typed one (the name was edited)', () => {
    expect(pickPlayers([row(1, false, true), row(2, false)]).map((r) => r.id)).toEqual([1, 2]);
    expect(pickPlayers([row(1, true), row(2, false, true)]).map((r) => r.id)).toEqual([1]);
  });

  it('otherwise every exact match (namesakes), else every partial match', () => {
    expect(pickPlayers([row(1, true), row(2, true), row(3, false)]).map((r) => r.id)).toEqual([1, 2]);
    expect(pickPlayers([row(1, false), row(2, false)]).map((r) => r.id)).toEqual([1, 2]);
    expect(pickPlayers([])).toEqual([]);
  });
});
