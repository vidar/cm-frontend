// Integration tests for the game and player search (src/lib/game-search.ts, searchPlayers and getGamesIndex in
// src/lib/games.ts) against the local sample database (TEST_DATABASE_URL, see tests/db.ts); they skip
// themselves without one. Fixtures are rows of the 14-issue sample (TWIC names, "Giri, A."), and every expected
// value was worked out with SQL against it first.
import { describe, expect, it } from 'vitest';
import { parseSearch, searchGames, TOO_BROAD } from '../src/lib/game-search';
import { getGamesIndex, getMeta, getPlayerPage, recentEvents, recentTopGames, searchPlayers, topPlayers } from '../src/lib/games';
import { dbAvailable } from './db';

const describeDb = describe.skipIf(!(await dbAvailable()));
const search = (q: string, timeout?: string) => searchGames(parseSearch(new URLSearchParams(q)), timeout);

describeDb('searchGames: names in any order', () => {
  it('finds "Giri, A." whichever way the name is typed', async () => {
    // SELECT id FROM games WHERE white_id = 346 ORDER BY date DESC NULLS LAST, id DESC LIMIT 3 -> 118838, 114211, 113393
    for (const name of ['Giri, A', 'A Giri', 'giri a', 'GIRI A.']) {
      const r = await search(`white=${encodeURIComponent(name)}`);
      expect(r.white.map((p) => p.slug), name).toEqual(['giri-a']);
      expect(r.games.slice(0, 3).map((g) => g.id), name).toEqual([118838, 114211, 113393]);
    }
  });

  it('says so when no player has all the words', async () => {
    const r = await search('white=Giri+Zzyzx');
    expect(r.games).toEqual([]);
    expect(r.empty).toBe('No player matches “Giri Zzyzx”.');
  });
});

describeDb('searchGames: namesakes', () => {
  it('mixes namesakes without a pin and offers each one', async () => {
    // players 1393 (CM, 34 games, 16 as White) and 10787 (4 games, 2 as White) are both "kaan akbas".
    const r = await search('white=Kaan+Akbas');
    expect(r.white.map((p) => p.slug)).toEqual(['kaan-akbas', 'kaan-akbas-2']);
    expect(r.games).toHaveLength(18);
  });

  it('a pin narrows to that one player', async () => {
    const r = await search('white=Kaan+Akbas&wp=kaan-akbas-2');
    expect(r.white.map((p) => p.id)).toEqual([10787]);
    expect(r.games).toHaveLength(2);
    expect(r.games.every((g) => g.white_id === 10787)).toBe(true);
    const any = await search('white=Kaan+Akbas&wp=kaan-akbas-2&any=1');
    expect(any.games).toHaveLength(4);
  });

  it('ignores a pin once the typed name no longer is that player', async () => {
    const r = await search('white=Akbas&wp=kaan-akbas-2');
    expect(r.white.map((p) => p.slug).sort()).toEqual(['kaan-akbas', 'kaan-akbas-2', 'umut-ata-akbas'].sort());
  });
});

describeDb('searchGames: events, openings and ECO', () => {
  it('matches every event whose name contains the term (no cap), here the oldest game of 130 "open" events', async () => {
    // SELECT id FROM games WHERE event_id IN (SELECT id FROM events WHERE lower(name) LIKE '%open%')
    //   ORDER BY date ASC NULLS FIRST, id ASC LIMIT 2 -> 292, 293
    const r = await search('event=open&sort=oldest');
    expect(r.games.slice(0, 2).map((g) => g.id)).toEqual([292, 293]);
  });

  it('says so when no event or opening has that name', async () => {
    expect((await search('event=zzqqzz')).empty).toBe('No event matches “zzqqzz”.');
    expect((await search('opening=zzqqzz')).empty).toMatch(/^No opening matches “zzqqzz”/);
  });

  it('reads a reversed ECO range low end first', async () => {
    // SELECT id FROM games WHERE eco BETWEEN 'D98' AND 'D99' ORDER BY date DESC -> 65487 (D99), 15555 (D98)
    expect((await search('opening=D99-D98')).games.map((g) => g.id)).toEqual([65487, 15555]);
    expect((await search('opening=d98-d99')).games.map((g) => g.id)).toEqual([65487, 15555]);
  });
});

describeDb('searchGames: statement timeout', () => {
  it('ends a search the indexes cannot serve as "too broad" instead of running on', async () => {
    // No game has 400+ moves: the planner walks games_date to the end, far longer than 1 ms.
    const r = await search('minmoves=400', '1ms');
    expect(r).toMatchObject({ games: [], tooBroad: true, empty: TOO_BROAD });
    // The same search with the real limit finishes (and finds nothing).
    expect(await search('minmoves=400')).toMatchObject({ games: [], hasMore: false });
  });
});

describeDb('searchPlayers: words in any order, then typos', () => {
  it('finds a player whatever the order of the words', async () => {
    expect((await searchPlayers('a giri')).map((p) => p.slug)).toEqual(['giri-a']);
    expect((await searchPlayers('Giri, A.')).map((p) => p.slug)).toEqual(['giri-a']);
    expect((await searchPlayers('akbas kaan')).map((p) => p.slug)).toEqual(['kaan-akbas', 'kaan-akbas-2']);
    expect((await searchPlayers('akbas kaan')).every((p) => !p.fuzzy)).toBe(true);
  });

  it('offers the closest names, marked fuzzy, when nothing contains every word', async () => {
    // word_similarity('carlssen', search): carlsen m 0.7, carlsson i 0.67 (threshold 0.6).
    const r = await searchPlayers('carlssen');
    expect(r.map((p) => [p.slug, p.fuzzy])).toEqual([
      ['carlsen-m', true],
      ['carlsson-i', true],
    ]);
    expect(await searchPlayers('qqxxzzvv')).toEqual([]);
  });
});

describeDb('getGamesIndex', () => {
  it('returns in one statement what the four separate queries return', async () => {
    const [games, events, players, totals] = await Promise.all([recentTopGames(20), recentEvents(12), topPlayers(24), getMeta()]);
    const page = await getGamesIndex(20, 12, 24);
    expect(page.games.map((g) => g.id)).toEqual(games.map((g) => g.id));
    expect(page.games[0]).toEqual(games[0]);
    expect(page.events).toEqual(events);
    expect(page.players.map((p) => p.id)).toEqual(players.map((p) => p.id));
    expect(page.totals).toEqual(totals);
  });
});

describeDb('getPlayerPage sources', () => {
  it('counts where the games come from (all TWIC in the sample)', async () => {
    const data = await getPlayerPage('giri-a', 1);
    // SELECT count(*) FROM games WHERE 346 IN (white_id, black_id) -> 109; no uploaded games (twic = 0) in the sample.
    expect(data?.sources).toEqual({ twic: 109, uploaded: 0 });
    expect(Object.keys(data?.score ?? {}).sort()).toEqual(['d', 'l', 'w']);
  });
});
