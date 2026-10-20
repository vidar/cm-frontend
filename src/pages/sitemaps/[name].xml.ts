import type { APIRoute } from 'astro';
import { gamePath, getMeta, query, twicIssueDate, type GameRow } from '../../lib/games';

// Sitemaps for the database pages (on-demand routes aren't covered by @astrojs/sitemap):
//   /sitemaps/index.xml       sitemap index
//   /sitemaps/events-N.xml    events and their round pages, by id, 2,500 events per file
//   /sitemaps/players-N.xml   players, by id, 50,000 per file
//   /sitemaps/games-N.xml     games, by id, 50,000 per file
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

/** Only complete YYYY-MM-DD dates are valid in <lastmod>. */
const fullDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

export const GET: APIRoute = async ({ params }) => {
  const name = params.name ?? '';

  if (name === 'index') {
    const [meta, [{ max }]] = await Promise.all([getMeta(), query<{ max: number }>('SELECT MAX(id) AS max FROM events')]);
    const files: string[] = [];
    for (let i = 1; i <= Math.ceil((max ?? 0) / EVENT_CHUNK); i++) files.push(`events-${i}.xml`);
    for (let i = 1; i <= Math.ceil((meta.players ?? 0) / CHUNK); i++) files.push(`players-${i}.xml`);
    for (let i = 1; i <= Math.ceil((meta.games ?? 0) / CHUNK); i++) files.push(`games-${i}.xml`);
    return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((f) => `<sitemap><loc>${SITE}/sitemaps/${f}</loc></sitemap>`).join('')}</sitemapindex>`);
  }
  const m = /^(players|games|events)-(\d+)$/.exec(name);
  if (!m) return new Response('Not found', { status: 404 });
  const n = Number(m[2]);
  if (m[1] === 'events') {
    const results = await query<{ slug: string; rounds: number | null; end_date: string | null; start_date: string | null }>(
      'SELECT slug, rounds, end_date, start_date FROM events WHERE id BETWEEN $1 AND $2 ORDER BY id',
      [(n - 1) * EVENT_CHUNK + 1, n * EVENT_CHUNK],
    );
    const urls = results.flatMap((e) => {
      const lastmod = fullDate(e.end_date ?? e.start_date);
      return [{ loc: `/events/${e.slug}/`, lastmod }, ...Array.from({ length: e.rounds && e.rounds > 1 ? e.rounds : 0 }, (_, i) => ({ loc: `/events/${e.slug}/round-${i + 1}/`, lastmod }))];
    });
    return urls.length ? urlset(urls) : new Response('Not found', { status: 404 });
  }
  const [lo, hi] = [(n - 1) * CHUNK + 1, n * CHUNK];
  if (m[1] === 'players') {
    const results = await query<{ slug: string; last_date: string | null }>('SELECT slug, last_date FROM players WHERE id BETWEEN $1 AND $2 ORDER BY id', [lo, hi]);
    return results.length ? urlset(results.map((p) => ({ loc: `/players/${p.slug}/`, lastmod: fullDate(p.last_date) }))) : new Response('Not found', { status: 404 });
  }
  const results = await query<Pick<GameRow, 'id' | 'white_name' | 'black_name' | 'event_name' | 'date' | 'twic'>>(
    `SELECT g.id, w.name AS white_name, b.name AS black_name, e.name AS event_name, g.date, g.twic
     FROM games g JOIN players w ON w.id = g.white_id JOIN players b ON b.id = g.black_id JOIN events e ON e.id = g.event_id
     WHERE g.id BETWEEN $1 AND $2 ORDER BY g.id`,
    [lo, hi],
  );
  // A game page dates from the TWIC issue that brought the game (uploaded games have no issue).
  return results.length ? urlset(results.map((g) => ({ loc: gamePath(g), lastmod: g.twic ? twicIssueDate(g.twic) : fullDate(g.date) }))) : new Response('Not found', { status: 404 });
};
