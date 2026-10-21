import type { APIRoute } from 'astro';
import { query } from '../../lib/games';

// The site's own way to the games database (Worker -> Hyperdrive -> Workers VPC -> tunnel -> Postgres), for
// the server's health check (ops/postgres/check.sh, SITE_CHECK_URL): 200 when a statement gets through, else
// 503. One trivial statement; now() keeps Hyperdrive from answering it from its cache. Never cached, and not
// for crawlers (robots.txt).
export const prerender = false;

const json = (ok: boolean) =>
  new Response(JSON.stringify({ ok }), { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async () => {
  try {
    await query('SELECT now()');
    return json(true);
  } catch {
    return json(false);
  }
};
