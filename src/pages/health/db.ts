import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { query } from '../../lib/games';
import { maintenance } from '../../lib/maintenance';

// The site's own way to the games database (Worker -> Hyperdrive -> Workers VPC -> tunnel -> Postgres), for
// the server's health check (ops/postgres/check.sh, SITE_CHECK_URL): 200 when a statement gets through, else
// 503 (with "maintenance": true while the database routes are closed on purpose, so the check doesn't alarm
// then). One trivial statement; now() keeps Hyperdrive from answering it from its cache. Never cached, and not
// for crawlers (robots.txt).
export const prerender = false;

const json = (ok: boolean, extra: object = {}) =>
  new Response(JSON.stringify({ ok, ...extra }), { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async () => {
  if (maintenance(env)) return json(false, { maintenance: true });
  try {
    await query('SELECT now()');
    return json(true);
  } catch {
    return json(false);
  }
};
