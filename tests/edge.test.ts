// Unit tests for the request-edge helpers: the edge-cache key of database pages (src/lib/cache-key.ts),
// the maintenance switch's path check (src/lib/maintenance.ts) and the LIKE escaping of game search.
import { describe, expect, it } from 'vitest';
import { dbCacheKey, KEY_PARAMS } from '../src/lib/cache-key';
import { contains } from '../src/lib/game-search';
import { isDbRoute, maintenance, routedPath } from '../src/lib/maintenance';

const key = (u: string) => dbCacheKey(new URL(u), 'v1');

describe('dbCacheKey', () => {
  it('drops parameters the pages never read (tracking tags, cache busters)', () => {
    const bare = key('https://chessmoments.com/games/1-a-vs-b/');
    expect(bare).toBe('https://chessmoments.com/games/1-a-vs-b/?__build=v1');
    expect(key('https://chessmoments.com/games/1-a-vs-b/?fbclid=IwAR1&utm_source=x&gclid=1&r=123')).toBe(bare);
  });
  it('keeps the parameters the pages read, in a stable order', () => {
    expect(key('https://chessmoments.com/players/x/?color=w&page=2&utm_medium=y')).toBe('https://chessmoments.com/players/x/?color=w&page=2&__build=v1');
    expect(key('https://chessmoments.com/players/x/?page=2&color=w')).toBe(key('https://chessmoments.com/players/x/?color=w&page=2'));
    expect(key('https://chessmoments.com/games/search/?white=Carlsen&sort=oldest&any=1')).toBe('https://chessmoments.com/games/search/?any=1&sort=oldest&white=Carlsen&__build=v1');
  });
  it('keeps poll, so a client polling live state never gets the cached answer', () => {
    expect(key('https://chessmoments.com/games/analysis/1.json?poll=1')).not.toBe(key('https://chessmoments.com/games/analysis/1.json'));
  });
  it('lists every parameter the database pages read', () => {
    expect([...KEY_PARAMS].sort()).toEqual(['all', 'any', 'black', 'color', 'event', 'from', 'maxmoves', 'minmoves', 'opening', 'page', 'poll', 'q', 'rating', 'result', 'sort', 'to', 'white']);
  });
  it("can't be steered by a __build parameter in the request", () => {
    expect(key('https://chessmoments.com/games/1-a/?__build=old')).toBe('https://chessmoments.com/games/1-a/?__build=v1');
  });
});

describe('maintenance path check', () => {
  it('decodes the path the way Astro routes it', () => {
    expect(routedPath('/%67ames/1/')).toBe('/games/1/');
    expect(routedPath('/%2567ames/1/')).toBe('/games/1/');
    expect(routedPath('//games//1/')).toBe('/games/1/');
    expect(routedPath('/%E0%A4%A/')).toBe('/%E0%A4%A/'); // malformed: left as is
  });
  it('sees every spelling of a database route', () => {
    for (const p of ['/games/', '/games', '/%67ames/1-x/', '/%2567ames/1-x/', '//players/x/', '/%70layers/', '/%65vents/x/', '/Sitemaps/index.xml', '/upload/', '/games/analysis/1.json'])
      expect(isDbRoute(`https://chessmoments.com${p}`), p).toBe(true);
    for (const p of ['/', '/puzzle/', '/openings/', '/robots.txt', '/gamesx/', '/analysis/']) expect(isDbRoute(`https://chessmoments.com${p}`), p).toBe(false);
  });
  it('is on only for MAINTENANCE "1"', () => {
    expect(maintenance({ MAINTENANCE: '1' })).toBe(true);
    expect(maintenance({ MAINTENANCE: '0' })).toBe(false);
    expect(maintenance({})).toBe(false);
    expect(maintenance(undefined)).toBe(false);
  });
});

describe('contains (game search LIKE patterns)', () => {
  it('matches %, _ and backslash literally', () => {
    expect(contains('Olympiad')).toBe('%olympiad%');
    expect(contains('50%')).toBe('%50\\%%');
    expect(contains('a_b')).toBe('%a\\_b%');
    expect(contains('a\\b')).toBe('%a\\\\b%');
  });
});
