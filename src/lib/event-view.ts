// Small display helpers shared by the event components.
import { pts } from './event';

/** Result chip for a score from the row player's point of view. */
export function chip(score: number) {
  return score === 1 ? { cls: 'win', text: '1' } : score === 0 ? { cls: 'loss', text: '0' } : { cls: 'draw', text: '½' };
}

/** "2½–1½" */
export const matchScore = (a: number, b: number) => `${pts(a)}–${pts(b)}`;

/** "Thu 13 Jun 2024" (UTC dates from the database). */
export function longDate(d: string | null) {
  if (!d || d.length !== 10) return d ?? '';
  return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function dateRange(a: string | null, b: string | null) {
  if (!a) return '';
  return !b || a === b ? longDate(a) : `${longDate(a)} – ${longDate(b)}`;
}

export const resultText = (r: string) => (r === '1/2-1/2' ? '½–½' : r.replace('-', '–'));
