// Edge cache for on-demand pages. Worker responses aren't cached by Cloudflare's CDN on their own,
// so successful GET responses that declare `Cache-Control: public` are stored with the Cache API
// (per data centre, for s-maxage / max-age) and served from there on the next request.
// Prerendered pages are static assets and never reach this. Database pages get a `Cache-Tag` so
// they can be purged after a data update (Cloudflare API: purge cache by tag "games-db").
// The key includes the build ID, so a deploy never serves pages rendered by the previous build.
import { defineMiddleware } from 'astro:middleware';

const DB_PAGES = /^\/(games|players|events|sitemaps)\//;
declare const __BUILD_ID__: string;
const HOST = 'chessmoments.com'; // the Cache API is a no-op on workers.dev previews anyway

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { request, url } = ctx;
  if (ctx.isPrerendered || request.method !== 'GET' || url.hostname !== HOST || request.headers.has('Authorization')) return next();
  const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
  const keyUrl = new URL(url);
  keyUrl.searchParams.set('__build', __BUILD_ID__);
  const key = new Request(keyUrl.toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('X-Edge-Cache', 'HIT');
    return res;
  }

  const res = await next();
  const cc = res.headers.get('Cache-Control') ?? '';
  if (res.status === 200 && /\bpublic\b/.test(cc) && /max-age=[1-9]/.test(cc) && !res.headers.has('Set-Cookie')) {
    if (DB_PAGES.test(url.pathname)) res.headers.set('Cache-Tag', 'games-db');
    const put = cache.put(key, res.clone());
    const cf = (ctx.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
    if (cf) cf.waitUntil(put);
    else await put;
    res.headers.set('X-Edge-Cache', 'MISS');
  }
  return res;
});
