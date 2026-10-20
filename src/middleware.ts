// Edge cache and crawler pacing for on-demand pages.
//
// Cache: Worker responses aren't cached by Cloudflare's CDN on their own, so GET responses that
// declare `Cache-Control: public` (200s, and the 301/404s the database pages mark cacheable) are
// stored with the Cache API (per data centre, for s-maxage / max-age) and served from there next
// time. Prerendered pages are static assets and never reach this. Database pages get a `Cache-Tag`
// so they can be purged after a data update (Cloudflare API: purge cache by tag "games-db"). The
// key includes the build ID, so a deploy never serves pages rendered by the previous build, except
// for the database pages, which are keyed by DATA_VERSION instead: content deploys (every CMS commit)
// would otherwise throw away millions of cached pages. Bump DATA_VERSION when their templates change.
//
// Crawlers: a cache miss on a database page costs a database query, and the database is billed by
// the hour it is awake, so crawlers are paced on misses (never on hits): each crawler family has a
// budget of misses per minute (src/lib/bots.ts) and gets 429 + Retry-After beyond it. Search engines
// get a high ceiling (Google treats 429 as an overload signal and slows the whole site; it is only
// a backstop), unknown and training bots a low one. Browsers are never paced here.
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { classifyBot, CRAWL_LIMIT, type BotKind } from './lib/bots';

const DB_PAGES = /^\/(games|players|events|sitemaps)\//;
/** Bump when the markup of the games/players/events/sitemaps pages changes (keeps their cache across other deploys). */
const DATA_VERSION = '2026-10-20';
declare const __BUILD_ID__: string;
const HOST = 'chessmoments.com'; // the Cache API is a no-op on workers.dev previews anyway

interface Limiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
// One rate-limit binding per budget (a binding has one fixed limit): see wrangler.jsonc.
const LIMITERS: Record<BotKind, string> = { search: 'CRAWL_SEARCH', assistant: 'CRAWL_ASSISTANT', training: 'CRAWL_BOT', other: 'CRAWL_BOT' };

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { request, url } = ctx;
  if (ctx.isPrerendered || request.method !== 'GET' || url.hostname !== HOST || request.headers.has('Authorization')) return next();
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const keyUrl = new URL(url);
  keyUrl.searchParams.set('__build', DB_PAGES.test(url.pathname) ? DATA_VERSION : __BUILD_ID__);
  const key = new Request(keyUrl.toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('X-Edge-Cache', 'HIT');
    return res;
  }

  if (DB_PAGES.test(url.pathname)) {
    const bot = classifyBot(request.headers.get('User-Agent'));
    const limiter = bot && (env as unknown as Record<string, Limiter | undefined>)[LIMITERS[bot.kind]];
    if (bot && limiter && !(await limiter.limit({ key: bot.family })).success) {
      return new Response(`Too many requests: this crawler is limited to ${CRAWL_LIMIT[bot.kind]} uncached database pages a minute. Please slow down and retry later.\n`, {
        status: 429,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
      });
    }
  }

  const res = await next();
  const cc = res.headers.get('Cache-Control') ?? '';
  const cacheable = (res.status === 200 || res.status === 301 || res.status === 404) && /\bpublic\b/.test(cc) && /max-age=[1-9]/.test(cc) && !res.headers.has('Set-Cookie');
  if (cacheable) {
    if (DB_PAGES.test(url.pathname)) res.headers.set('Cache-Tag', 'games-db');
    const put = cache.put(key, res.clone());
    const cf = (ctx.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
    if (cf) cf.waitUntil(put);
    else await put;
    res.headers.set('X-Edge-Cache', 'MISS');
  }
  return res;
});
