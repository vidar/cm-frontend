// The edge middleware (src/middleware.ts): edge cache of on-demand pages, pacing of cache misses on
// database pages (crawlers by family, visitors by address, searches for everybody), and the 301 to the
// slashed URL. `astro:middleware`, the Cache API and the rate-limit bindings are stubbed; `next()` stands
// for Astro rendering the page and counts how often it ran.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

vi.mock('astro:middleware', () => ({ defineMiddleware: (f: unknown) => f }));
const g = globalThis as Record<string, unknown>;
g.__BUILD_ID__ = 'b1';
g.__DATA_VERSION__ = 'd1';

const store = new Map<string, Response>();
g.caches = {
  default: {
    match: async (r: Request) => store.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => void store.set(r.url, res),
  },
};

// A fixed-window limiter per binding: `limit` successes per key, then refusals.
const counts = new Map<string, number>();
const limiter = (name: string, limit: number) => ({
  limit: async ({ key }: { key: string }) => {
    const k = `${name}|${key}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    return { success: counts.get(k)! <= limit };
  },
});
Object.assign(env, {
  CRAWL_SEARCH: limiter('CRAWL_SEARCH', 600),
  CRAWL_ASSISTANT: limiter('CRAWL_ASSISTANT', 60),
  CRAWL_BOT: limiter('CRAWL_BOT', 20),
  VISITOR_LIMITER: limiter('VISITOR_LIMITER', 120),
  SEARCH_LIMITER: limiter('SEARCH_LIMITER', 20),
});

const { onRequest, slashRedirect } = await import('../src/middleware');

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let rendered = 0;
let page: () => Response = () => new Response('page', { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=604800' } });

interface Opts {
  method?: string;
  ua?: string | null;
  ip?: string;
  asn?: number;
  headers?: Record<string, string>;
  prerendered?: boolean;
  routePattern?: string;
}
async function call(path: string, o: Opts = {}): Promise<Response> {
  const headers = new Headers(o.headers);
  if (o.ua !== null) headers.set('User-Agent', o.ua ?? CHROME);
  headers.set('cf-connecting-ip', o.ip ?? '203.0.113.7');
  const request = new Request(`https://chessmoments.com${path}`, { method: o.method ?? 'GET', headers });
  if (o.asn) Object.defineProperty(request, 'cf', { value: { asn: o.asn } });
  const ctx = { request, url: new URL(request.url), isPrerendered: o.prerendered ?? false, routePattern: o.routePattern ?? '/x', locals: {} };
  return (onRequest as unknown as (c: typeof ctx, n: () => Promise<Response>) => Promise<Response>)(ctx, async () => {
    rendered++;
    return page();
  });
}

beforeEach(() => {
  store.clear();
  counts.clear();
  rendered = 0;
  page = () => new Response('page', { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=604800' } });
});

describe('edge cache', () => {
  it('serves a hit after a miss, ignoring tracking parameters on database pages', async () => {
    const a = await call('/players/carlsen-m/?utm_source=x');
    expect(a.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(a.headers.get('Cache-Tag')).toBe('games-db');
    const b = await call('/players/carlsen-m/?fbclid=1');
    expect(b.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(await b.text()).toBe('page');
    expect(rendered).toBe(1);
  });

  it('tags only database pages', async () => {
    const r = await call('/puzzle/');
    expect(r.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(r.headers.has('Cache-Tag')).toBe(false);
  });

  it('never stores private, uncacheable, failed or cookie-setting responses', async () => {
    const answers: (() => Response)[] = [
      () => new Response('x', { headers: { 'Cache-Control': 'private, max-age=600' } }),
      () => new Response('x', { headers: { 'Cache-Control': 'public, max-age=0' } }),
      () => new Response('x', { status: 500, headers: { 'Cache-Control': 'public, max-age=600' } }),
      () => new Response('x', { status: 429, headers: { 'Cache-Control': 'public, max-age=600' } }),
      () => new Response('x', { headers: { 'Cache-Control': 'public, max-age=600', 'Set-Cookie': 'a=b' } }),
    ];
    for (const [i, answer] of answers.entries()) {
      page = answer;
      await call(`/events/e${i}/`);
      expect((await call(`/events/e${i}/`)).headers.has('X-Edge-Cache'), String(i)).toBe(false);
    }
    expect(store.size).toBe(0);
  });

  it('serves HEAD from the GET entry, without a body', async () => {
    await call('/games/1-a-vs-b/');
    const r = await call('/games/1-a-vs-b/', { method: 'HEAD' });
    expect(r.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(await r.text()).toBe('');
    expect(rendered).toBe(1);
  });

  it('leaves POST and prerendered pages alone, and an Authorization header changes nothing', async () => {
    await call('/games/analysis/1.json', { method: 'POST' });
    await call('/openings/', { prerendered: true });
    expect(store.size).toBe(0);
    await call('/players/x/');
    expect((await call('/players/x/', { headers: { Authorization: 'Bearer x' } })).headers.get('X-Edge-Cache')).toBe('HIT');
  });
});

describe('pacing of database cache misses', () => {
  it('limits a crawler family and never counts hits', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await call(`/games/${i + 1}-x/`, { ua: 'GPTBot/1.1' })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    const r = await call('/games/99-x/', { ua: 'GPTBot/1.1' });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('60');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    // A cached page is still served.
    expect((await call('/games/1-x/', { ua: 'GPTBot/1.1' })).status).toBe(200);
  });

  it('gives browsers a generous per-address budget', async () => {
    for (let i = 0; i < 120; i++) expect((await call(`/players/p${i}/`)).status).toBe(200);
    expect((await call('/players/p999/')).status).toBe(429);
    // Another address is unaffected, and so is a cached page.
    expect((await call('/players/p999/', { ip: '198.51.100.1' })).status).toBe(200);
    expect((await call('/players/p1/')).status).toBe(200);
  });

  it('cannot be skipped with an Authorization header', async () => {
    for (let i = 0; i < 20; i++) await call(`/games/${i + 1}-x/`, { ua: 'GPTBot/1.1' });
    expect((await call('/games/50-x/', { ua: 'GPTBot/1.1', headers: { Authorization: 'Bearer x' } })).status).toBe(429);
  });

  it('limits searches to 20 a minute for everybody', async () => {
    for (let i = 0; i < 20; i++) expect((await call(`/games/search/?white=a${i}`)).status).toBe(200);
    expect((await call('/games/search/?white=zz')).status).toBe(429);
    for (let i = 0; i < 20; i++) await call(`/players/?q=n${i}`, { ip: '198.51.100.2' });
    expect((await call('/players/?q=zz', { ip: '198.51.100.2' })).status).toBe(429);
    // Other player pages are not searches.
    expect((await call('/players/?page=3', { ip: '198.51.100.2' })).status).toBe(200);
  });

  it('keys IPv6 visitors by /64', async () => {
    for (let i = 0; i < 20; i++) await call(`/games/search/?black=b${i}`, { ip: `2001:db8:1:2::${i + 1}` });
    expect((await call('/games/search/?black=zz', { ip: '2001:db8:1:2:ffff::1' })).status).toBe(429);
  });

  it("a fake Googlebot from another network doesn't use up Google's budget", async () => {
    for (let i = 0; i < 600; i++) await call(`/games/${i + 1}-x/`, { ua: GOOGLEBOT, asn: 64500 });
    expect((await call('/games/9999-x/', { ua: GOOGLEBOT, asn: 64500 })).status).toBe(429);
    expect((await call('/games/9999-x/', { ua: GOOGLEBOT, asn: 15169 })).status).toBe(200);
  });

  it('keys unknown bots by address, so one script cannot starve another', async () => {
    for (let i = 0; i < 20; i++) await call(`/events/e${i}/`, { ua: 'curl/8.0' });
    expect((await call('/events/zz/', { ua: 'curl/8.0' })).status).toBe(429);
    expect((await call('/events/zz/', { ua: 'python-requests/2.32', ip: '198.51.100.3' })).status).toBe(200);
  });

  it('does not pace pages outside the database', async () => {
    for (let i = 0; i < 25; i++) expect((await call(`/puzzle/2026-01-${String(i + 1).padStart(2, '0')}/`, { ua: 'curl/8.0' })).status).toBe(200);
  });

  it('answers HEAD 429s without a body', async () => {
    for (let i = 0; i < 20; i++) await call(`/games/${i + 1}-x/`, { ua: 'curl/8.0' });
    const r = await call('/games/77-x/', { ua: 'curl/8.0', method: 'HEAD' });
    expect(r.status).toBe(429);
    expect(await r.text()).toBe('');
  });

  it('sees encoded spellings of database paths', async () => {
    for (let i = 0; i < 20; i++) await call(`/%67ames/${i + 1}-x/`, { ua: 'curl/8.0' });
    expect((await call('/%67ames/88-x/', { ua: 'curl/8.0' })).status).toBe(429);
  });
});

describe('trailing slash', () => {
  it('redirects on-demand pages to the slashed URL, keeping the query', async () => {
    const r = await call('/players/anish-giri?page=2');
    expect(r.status).toBe(301);
    expect(r.headers.get('Location')).toBe('https://chessmoments.com/players/anish-giri/?page=2');
    expect(rendered).toBe(0);
    expect((await call('/events', { method: 'HEAD' })).headers.get('Location')).toBe('https://chessmoments.com/events/');
  });

  it('leaves files, endpoints, the 404 page and slashed paths alone', async () => {
    expect(slashRedirect(new URL('https://chessmoments.com/games/analysis/1.json'))).toBeNull();
    expect(slashRedirect(new URL('https://chessmoments.com/sitemaps/index.xml'))).toBeNull();
    expect(slashRedirect(new URL('https://chessmoments.com/health/db'))).toBeNull();
    expect(slashRedirect(new URL('https://chessmoments.com/%68ealth/db'))).toBeNull();
    expect(slashRedirect(new URL('https://chessmoments.com/games/'))).toBeNull();
    expect((await call('/no-such-page', { routePattern: '/404' })).status).toBe(200);
    expect((await call('/games/search', { method: 'POST' })).status).toBe(200);
  });

  it('stays on this site for a path that looks like another host', () => {
    expect(slashRedirect(new URL('https://chessmoments.com//evil.example/x'))).toBe('https://chessmoments.com//evil.example/x/');
  });
});
