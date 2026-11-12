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

/** Edge cache lifetime for a TWIC event page: a month once the event is three weeks past, a day while it may still get games. */
export function eventCacheControl(event: { end_date: string | null; start_date: string | null }, now = new Date()) {
  const end = event.end_date ?? event.start_date;
  const finished = !!end && Date.parse(end) < now.getTime() - 21 * 86_400_000;
  return finished ? 'public, max-age=86400, s-maxage=2592000' : 'public, max-age=3600, s-maxage=86400';
}

// ---- URL parameters --------------------------------------------------------------------------
// Database pages are edge-cached by path and the query parameters in KEY_PARAMS (src/lib/cache-key.ts),
// so every spelling of a parameter costs a database query of its own. The event routes accept one
// spelling of each parameter they read and redirect (or 404) the rest before querying.

/** A round page's number: digits only, no leading zero, 1..60 (as parseRound). Null: no such page. */
export function roundParam(s: string | undefined): number | null {
  return s && /^[1-9]\d?$/.test(s) && Number(s) <= 60 ? Number(s) : null;
}

/** A page number: a plain positive integer up to `max`; anything else is page 1. */
export function pageParam(s: string | null, max: number): number {
  return s && /^[1-9]\d{0,5}$/.test(s) && Number(s) <= max ? Number(s) : 1;
}

/**
 * The search a URL should redirect to so that its cache-keyed parameters are exactly `keep` (in that
 * order; '' as a value is a bare flag such as `?all`), or null when they already are. Parameters the
 * cache ignores (utm_*, fbclid) don't count.
 */
export function canonicalSearch(sp: URLSearchParams, keep: [string, string][], keyParams: Set<string>): string | null {
  const now = [...sp].filter(([k]) => keyParams.has(k));
  const same = now.length === keep.length && now.every(([k, v], i) => k === keep[i][0] && v === keep[i][1]);
  if (same) return null;
  return keep.length ? `?${keep.map(([k, v]) => (v === '' ? k : `${k}=${encodeURIComponent(v)}`)).join('&')}` : '';
}

/** Event page: `page` (2 and up, game lists only; checked again once the format is known) and a bare `all`. */
export function eventPageParams(sp: URLSearchParams) {
  const page = pageParam(sp.get('page'), 1000);
  const all = sp.has('all');
  const keep: [string, string][] = [];
  if (page > 1) keep.push(['page', String(page)]);
  if (all) keep.push(['all', '']);
  return { page, all, keep };
}

/** Events per page on /events/ (and the most pages it offers). */
export const EVENTS_PAGE_SIZE = 200;
export const EVENTS_MAX_PAGES = 100;

/**
 * /events/ parameters: `q` (a name search, at least two letters, spaces tidied), `year` (events that
 * started that year) and `page`. `keep` is their one cache-keyed spelling.
 */
export function eventsListParams(sp: URLSearchParams) {
  const raw = (sp.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  const q = raw.length >= 2 ? raw : null;
  const y = sp.get('year') ?? '';
  const year = /^\d{4}$/.test(y) && Number(y) >= 1800 && Number(y) <= 2100 ? Number(y) : null;
  const page = pageParam(sp.get('page'), EVENTS_MAX_PAGES);
  const keep: [string, string][] = [];
  if (q) keep.push(['q', q]);
  if (year) keep.push(['year', String(year)]);
  if (page > 1) keep.push(['page', String(page)]);
  return { q, year, page, keep };
}

/** The /events/ URL for a listing (default: the recent events). */
export function eventsListUrl(p: { q?: string | null; year?: number | null; page?: number }) {
  const sp = new URLSearchParams();
  if (p.q) sp.set('q', p.q);
  if (p.year) sp.set('year', String(p.year));
  if (p.page && p.page > 1) sp.set('page', String(p.page));
  const s = sp.toString();
  return `/events/${s ? `?${s}` : ''}`;
}
