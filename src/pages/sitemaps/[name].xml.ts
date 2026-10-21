import type { APIRoute } from 'astro';
import { gamePath, query, twicIssueDate, type GameRow } from '../../lib/games';
import { UPLOAD_ID_BASE } from '../../lib/uploads';

// Sitemaps for the database pages (on-demand routes aren't covered by @astrojs/sitemap):
//   /sitemaps/index.xml       sitemap index
//   /sitemaps/events-N.xml    events and their round pages, by id, 2,500 events per file
//   /sitemaps/players-N.xml   players, by id, 50,000 per file
//   /sitemaps/games-N.xml     games, by id, 50,000 per file
// TWIC ids start at 1 and are dense; uploaded ids (from UPLOAD_ID_BASE) come from one counter shared by
// events, players and games, so each table's are sparse and the index lists only the files that hold some.
export const prerender = false;

const CHUNK = 50_000;
const EVENT_CHUNK = 2_500;
const SITE = 'https://chessmoments.com';
// A week at the edge: the database changes once a week (TWIC) and the cache is purged by tag after imports.
const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' },
  });
// <lastmod> tells crawlers that old pages haven't changed, so they spend their visits on new ones.
const urlset = (urls: { loc: string; lastmod?: string | null }[]) =>
  xml(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${SITE}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
      .join('')}</urlset>`,
  );

/** W3C dates (YYYY, YYYY-MM or YYYY-MM-DD) are valid in <lastmod>; anything else is left out. */
const w3cDate = (d: string | null) => (d && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) ? d : null);
// Empty or unknown files are cached too (crawlers retry them, and each costs a query).
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600, s-maxage=86400' } });

/** The files covering ids 1..max in chunks of `size`. */
const chunks = (kind: string, size: number, max: number | null) => {
  const out: string[] = [];
  if (max) for (let i = 1; i <= Math.ceil(max / size); i++) out.push(`${kind}-${i}.xml`);
  return out;
};

export const GET: APIRoute = async ({ params }) => {
  const name = params.name ?? '';

  if (name === 'index') {
    // Per table, in one statement: the highest TWIC id (a backward scan of the primary key) and the files that
    // hold uploaded rows (few: a range scan above UPLOAD_ID_BASE).
    const SIZES = { events: EVENT_CHUNK, players: CHUNK, games: CHUNK } as const;
    const kinds = Object.keys(SIZES) as (keyof typeof SIZES)[];
    const cols = (t: keyof typeof SIZES) =>
      `(SELECT max(id) FROM ${t} WHERE id < $1) AS ${t}, ` +
      `(SELECT string_agg(n::text, ',' ORDER BY n) FROM (SELECT DISTINCT (id - 1) / ${SIZES[t]} + 1 AS n FROM ${t} WHERE id >= $1) f) AS ${t}_up`;
    const [r] = await query<Record<string, number | string | null>>(`SELECT ${kinds.map(cols).join(', ')}`, [UPLOAD_ID_BASE]);
    const files = kinds.flatMap((t) => [
      ...chunks(t, SIZES[t], r[t] as number | null),
      ...String(r[`${t}_up`] ?? '').split(',').filter(Boolean).map((n) => `${t}-${n}.xml`),
    ]);
    return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((f) => `<sitemap><loc>${SITE}/sitemaps/${f}</loc></sitemap>`).join('')}</sitemapindex>`);
  }
  const m = /^(players|games|events)-(\d{1,6})$/.exec(name);
  if (!m) return notFound();
  const n = Number(m[2]);
  if (m[1] === 'events') {
    const results = await query<{ slug: string; rounds: number | null; end_date: string | null; start_date: string | null; twic: number | null }>(
      'SELECT slug, rounds, end_date, start_date, twic FROM events WHERE id BETWEEN $1 AND $2 ORDER BY id',
      [(n - 1) * EVENT_CHUNK + 1, n * EVENT_CHUNK],
    );
    const urls = results.flatMap((e) => {
      const lastmod = w3cDate(e.end_date) ?? w3cDate(e.start_date) ?? (e.twic ? twicIssueDate(e.twic) : null);
      return [{ loc: `/events/${e.slug}/`, lastmod }, ...Array.from({ length: e.rounds && e.rounds > 1 ? e.rounds : 0 }, (_, i) => ({ loc: `/events/${e.slug}/round-${i + 1}/`, lastmod }))];
    });
    return urls.length ? urlset(urls) : notFound();
  }
  const [lo, hi] = [(n - 1) * CHUNK + 1, n * CHUNK];
  if (m[1] === 'players') {
    const results = await query<{ slug: string; last_date: string | null }>('SELECT slug, last_date FROM players WHERE id BETWEEN $1 AND $2 ORDER BY id', [lo, hi]);
    return results.length ? urlset(results.map((p) => ({ loc: `/players/${p.slug}/`, lastmod: w3cDate(p.last_date) }))) : notFound();
  }
  const results = await query<Pick<GameRow, 'id' | 'white_name' | 'black_name' | 'event_name' | 'date' | 'twic'>>(
    `SELECT g.id, w.name AS white_name, b.name AS black_name, e.name AS event_name, g.date, g.twic
     FROM games g JOIN players w ON w.id = g.white_id JOIN players b ON b.id = g.black_id JOIN events e ON e.id = g.event_id
     WHERE g.id BETWEEN $1 AND $2 ORDER BY g.id`,
    [lo, hi],
  );
  // A game page dates from the TWIC issue that brought the game (uploaded games have no issue).
  return results.length ? urlset(results.map((g) => ({ loc: gamePath(g), lastmod: g.twic ? twicIssueDate(g.twic) : w3cDate(g.date) }))) : notFound();
};
