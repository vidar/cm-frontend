// Edge cache and crawler pacing for on-demand pages.
//
// Cache: Worker responses aren't cached by Cloudflare's CDN on their own, so GET/HEAD responses that
// declare `Cache-Control: public` (200s, and the 301/404s the database pages mark cacheable) are
// stored with the Cache API (per data centre, for s-maxage / max-age) and served from there next
// time. Prerendered pages are static assets and never reach this. Database pages get a `Cache-Tag`
// so they can be purged after a data update (Cloudflare API: purge cache by tag "games-db"). The
// key includes the build ID, so a deploy never serves pages rendered by the previous build, except
// for the database pages, which are keyed by __DATA_VERSION__, a hash of the source (astro.config.mjs):
// content deploys (every CMS commit) would otherwise throw away millions of cached pages, while a
// code or style change rolls them so no cached page links to /_astro assets that are gone. Their key
// also keeps only the query parameters they read (src/lib/cache-key.ts), so tracking tags and cache
// busters don't turn every visit into a query.
//
// Pacing: a cache miss on a database page costs a database query, and the database shares a 4-vCPU box
// with the engine, so misses (never hits) are paced. Crawlers by family (src/lib/bots.ts): each has a
// budget of misses per minute and gets 429 + Retry-After beyond it. Search engines get a high ceiling
// (Google treats 429 as an overload signal and slows the whole site; it is only a backstop), unknown and
// training bots a low one. Everyone else (browsers) has a generous per-visitor budget, keyed by address
// (IPv6 by /64), and the expensive searches (/games/search/, /players/?q=) a tighter one for everybody.
//
// Pages: on-demand pages answer only at their slashed path; the slash-less one redirects there (301),
// so a page has one URL, one canonical and one cache entry. Security headers are added in src/worker.ts.
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { classifyBot, CRAWL_LIMIT, crawlerKey, type BotKind } from './lib/bots';
import { dbCacheKey } from './lib/cache-key';
import { limiterKey } from './lib/client';
import { routedPath } from './lib/maintenance';

const DB_PAGES = /^\/(games|players|events|sitemaps)(\/|$)/i;
declare const __BUILD_ID__: string;
declare const __DATA_VERSION__: string;
const HOST = 'chessmoments.com'; // the Cache API is a no-op on workers.dev previews anyway

interface Limiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
// One rate-limit binding per budget (a binding has one fixed limit): see wrangler.jsonc. Previews share
// the visitors' 120 a minute under their own keys.
const LIMITERS: Record<BotKind, string> = { search: 'CRAWL_SEARCH', assistant: 'CRAWL_ASSISTANT', preview: 'VISITOR_LIMITER', training: 'CRAWL_BOT', other: 'CRAWL_BOT' };
/** Uncached database pages a visitor may load per minute, and searches (the VISITOR_LIMITER and SEARCH_LIMITER bindings). */
export const VISITOR_LIMIT = 120;
export const SEARCH_LIMIT = 20;

/** Searches cost the most and have unlimited distinct URLs; counted for everyone, crawlers too (robots.txt keeps them off). */
const isSearch = (path: string, url: URL) => path === '/games/search/' || (path === '/players/' && url.searchParams.has('q'));

const tooMany = (head: boolean, text: string) =>
  new Response(head ? null : text, {
    status: 429,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });

/** A GET/HEAD for an on-demand page without its trailing slash: the slashed URL to send it to, or null. */
export function slashRedirect(url: URL): string | null {
  const path = url.pathname;
  if (path.endsWith('/') || /\.[^/]*$/.test(path) || /^\/health(\/|$)/i.test(routedPath(path))) return null;
  const to = new URL(url);
  to.pathname = `${path}/`;
  return to.href;
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { request, url } = ctx;
  // HEAD is served like GET (from the GET entry, and paced): Astro renders the full page for it.
  const head = request.method === 'HEAD';
  if (ctx.isPrerendered || (request.method !== 'GET' && !head)) return next();
  // Not for the 404 page (an unknown path has no slashed page either).
  const to = ctx.routePattern === '/404' || ctx.routePattern === '/500' ? null : slashRedirect(url);
  if (to) return new Response(null, { status: 301, headers: { Location: to, 'Cache-Control': 'public, max-age=86400' } });
  if (url.hostname !== HOST) return next();
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const path = routedPath(url.pathname);
  const db = DB_PAGES.test(path);
  let keyUrl: string;
  if (db) keyUrl = dbCacheKey(url, __DATA_VERSION__);
  else {
    const k = new URL(url);
    k.searchParams.set('__build', __BUILD_ID__);
    keyUrl = k.toString();
  }
  const key = new Request(keyUrl, { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(head ? null : hit.body, hit);
    res.headers.set('X-Edge-Cache', 'HIT');
    return res;
  }

  if (db) {
    const limiters = env as unknown as Record<string, Limiter | undefined>;
    const ip = limiterKey(request.headers.get('cf-connecting-ip'));
    const bot = classifyBot(request.headers.get('User-Agent'));
    const search = limiters.SEARCH_LIMITER;
    if (isSearch(path, url) && search && !(await search.limit({ key: `search:${ip}` })).success)
      return tooMany(head, `Too many requests: searches are limited to ${SEARCH_LIMIT} a minute. Please wait a minute and try again.\n`);
    if (bot) {
      const limiter = limiters[LIMITERS[bot.kind]];
      const asn = (request as { cf?: { asn?: number } }).cf?.asn;
      if (limiter && !(await limiter.limit({ key: `${bot.kind}:${crawlerKey(bot, ip, asn)}` })).success)
        return tooMany(head, `Too many requests: this crawler is limited to ${CRAWL_LIMIT[bot.kind]} uncached database pages a minute. Please slow down and retry later.\n`);
    } else {
      const visitor = limiters.VISITOR_LIMITER;
      if (visitor && !(await visitor.limit({ key: `visitor:${ip}` })).success)
        return tooMany(head, `Too many requests: more than ${VISITOR_LIMIT} database pages a minute from your address. Please wait a minute and try again.\n`);
    }
  }

  const res = await next();
  const cc = res.headers.get('Cache-Control') ?? '';
  const cacheable = (res.status === 200 || res.status === 301 || res.status === 404) && /\bpublic\b/.test(cc) && /max-age=[1-9]/.test(cc) && !res.headers.has('Set-Cookie');
  if (cacheable) {
    if (db) res.headers.set('Cache-Tag', 'games-db');
    const put = cache.put(key, res.clone());
    const cf = (ctx.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
    if (cf) cf.waitUntil(put);
    else await put;
    res.headers.set('X-Edge-Cache', 'MISS');
  }
  return head ? new Response(null, res) : res;
});
