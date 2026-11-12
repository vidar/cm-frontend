import { describe, expect, it } from 'vitest';
import { getPuzzle, listPuzzles, publishedDates, firstDate } from '../src/lib/puzzles';

describe('puzzle archive', () => {
  it('lists the same entries getPuzzle gives, newest first, without replaying moves', () => {
    const now = new Date(Date.parse(`${firstDate}T00:00:00Z`) + 40 * 86_400_000 + 3_600_000);
    const list = listPuzzles(now);
    expect(list.map((p) => p.date)).toEqual(publishedDates(now));
    expect(list).toHaveLength(41);
    for (const entry of list) {
      const p = getPuzzle(entry.date, now)!;
      expect(entry).toEqual({ number: p.number, date: p.date, rating: p.rating, themes: p.themes });
    }
    expect(list[0].number).toBe(41);
    expect(list[40]).toMatchObject({ number: 1, date: firstDate });
  });

  it('is empty before the first puzzle', () => {
    expect(listPuzzles(new Date(Date.parse(`${firstDate}T00:00:00Z`) - 1000))).toEqual([]);
  });
});
