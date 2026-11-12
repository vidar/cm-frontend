import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { limiterKey } from '../lib/client';
import { parseOgQuery } from '../lib/og-url';

// Social preview card: /og.png?fen=<placement>&t=<title>[&lm=e2e4&flip=1&k=<kicker>&s=<subtitle>&f=<footer>]
// Pages link to it from og:image (src/lib/og-url.ts). Texts are length-limited; responses are
// immutable for a URL, so the edge cache (src/middleware.ts) keeps them. Only the exact URL ogUrl()
// builds is rendered: any other spelling (extra or reordered parameters, overlong texts) is sent there
// with a cached 301, and renders (cache misses) are limited per address.
export const prerender = false;

/** Renders a visitor may cause per minute (the VISITOR_LIMITER binding, under its own keys). */
const RENDER_LIMIT = 120;

export const GET: APIRoute = async ({ url, request }) => {
  const parsed = parseOgQuery(url.searchParams);
  if (!parsed) return new Response('Bad request', { status: 400 });
  const { card, canonical } = parsed;
  if (`${url.pathname}?${new URLSearchParams(url.search)}` !== canonical)
    return new Response(null, { status: 301, headers: { Location: canonical, 'Cache-Control': 'public, max-age=86400' } });

  const limiter = (env as { VISITOR_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).VISITOR_LIMITER;
  if (limiter && !(await limiter.limit({ key: `og:${limiterKey(request.headers.get('cf-connecting-ip'))}` })).success)
    return new Response(`Too many requests: more than ${RENDER_LIMIT} new preview images a minute from your address.\n`, {
      status: 429,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });

  const { renderCard } = await import('../lib/og');
  const assets = (env as { ASSETS?: { fetch(r: Request | string): Promise<Response> } }).ASSETS;
  const load = async (path: string) => {
    const res = assets ? await assets.fetch(new URL(path, url)) : await fetch(new URL(path, url));
    if (!res.ok) throw new Error(`font ${path}: ${res.status}`);
    return res.arrayBuffer();
  };
  const png = await renderCard({ ...card, fen: `${card.fen} w - - 0 1` }, load);
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800, s-maxage=31536000, immutable' },
  });
};
