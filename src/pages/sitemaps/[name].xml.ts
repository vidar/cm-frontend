import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { gamePath, type GameRow } from '../../lib/games';

// Sitemaps for the database pages (on-demand routes aren't covered by @astrojs/sitemap):
//   /sitemaps/index.xml       sitemap index
//   /sitemaps/events.xml      all events
//   /sitemaps/players-N.xml   players, by id, 50,000 per file
//   /sitemaps/games-N.xml     games, by id, 50,000 per file
export const prerender = false;

const CHUNK = 50_000;
const SITE = 'https://chessmoments.com';
const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
const urlset = (urls: string[]) =>
  xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${SITE}${u}</loc></url>`).join('')}</urlset>`);

export const GET: APIRoute = async ({ params }) => {
  const db = (env as { DB: D1Database }).DB;
  const name = params.name ?? '';
  const meta = Object.fromEntries((await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>()).results.map((r) => [r.key, Number(r.value)]));

  if (name === 'index') {
    const files = ['events.xml'];
    for (let i = 1; i <= Math.ceil((meta.players ?? 0) / CHUNK); i++) files.push(`players-${i}.xml`);
    for (let i = 1; i <= Math.ceil((meta.games ?? 0) / CHUNK); i++) files.push(`games-${i}.xml`);
    return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((f) => `<sitemap><loc>${SITE}/sitemaps/${f}</loc></sitemap>`).join('')}</sitemapindex>`);
  }
  if (name === 'events') {
    const { results } = await db.prepare('SELECT slug FROM events ORDER BY id').all<{ slug: string }>();
    return urlset(results.map((e) => `/events/${e.slug}/`));
  }
  const m = /^(players|games)-(\d+)$/.exec(name);
  if (!m) return new Response('Not found', { status: 404 });
  const n = Number(m[2]);
  const [lo, hi] = [(n - 1) * CHUNK + 1, n * CHUNK];
  if (m[1] === 'players') {
    const { results } = await db.prepare('SELECT slug FROM players WHERE id BETWEEN ? AND ? ORDER BY id').bind(lo, hi).all<{ slug: string }>();
    return results.length ? urlset(results.map((p) => `/players/${p.slug}/`)) : new Response('Not found', { status: 404 });
  }
  const { results } = await db
    .prepare(
      `SELECT g.id, w.name AS white_name, b.name AS black_name, e.name AS event_name, g.date
       FROM games g JOIN players w ON w.id = g.white_id JOIN players b ON b.id = g.black_id JOIN events e ON e.id = g.event_id
       WHERE g.id BETWEEN ? AND ? ORDER BY g.id`,
    )
    .bind(lo, hi)
    .all<Pick<GameRow, 'id' | 'white_name' | 'black_name' | 'event_name' | 'date'>>();
  return results.length ? urlset(results.map(gamePath)) : new Response('Not found', { status: 404 });
};
