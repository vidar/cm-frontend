// The Worker entry (src/worker.ts): the maintenance switch closes only the database routes, and a 500 from a
// database route (the database failing) becomes a 503 with Retry-After; other responses pass through.
// Astro's handler is replaced by a stub that answers with the status the test asks for.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let next = { status: 200, body: 'page' };
vi.mock('@astrojs/cloudflare/handler', () => ({
  handle: vi.fn(async () => new Response(next.body, { status: next.status })),
}));
const { default: worker } = await import('../src/worker');

const call = (path: string, env: Record<string, string> = {}, method = 'GET') =>
  worker.fetch!(new Request(`https://chessmoments.com${path}`, { method }) as never, env as never, {} as never);

beforeEach(() => {
  next = { status: 200, body: 'page' };
});

describe('worker', () => {
  it('passes responses through', async () => {
    const r = await call('/games/carlsen-vs-caruana-2024/');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('page');
  });

  it('turns a 500 from a database route into a 503 with Retry-After', async () => {
    next = { status: 500, body: '' };
    const r = await call('/players/magnus-carlsen/');
    expect(r.status).toBe(503);
    expect(r.headers.get('Retry-After')).toBe('120');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.text()).toContain('not answering');
  });

  it('answers HEAD without a body', async () => {
    next = { status: 500, body: '' };
    const r = await call('/events/tata-steel-2024/', {}, 'HEAD');
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('');
  });

  it('leaves a 500 elsewhere and other statuses alone', async () => {
    next = { status: 500, body: 'oops' };
    expect((await call('/openings/')).status).toBe(500);
    next = { status: 404, body: 'nope' };
    expect((await call('/games/no-such-game/')).status).toBe(404);
    next = { status: 503, body: '{"error":"busy"}' };
    const r = await call('/games/analysis/12.json', {}, 'POST');
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('{"error":"busy"}');
  });

  it('closes only the database routes in maintenance', async () => {
    const env = { MAINTENANCE: '1' };
    const db = await call('/games/', env);
    expect(db.status).toBe(503);
    expect(db.headers.get('Retry-After')).toBe('3600');
    expect(await db.text()).toContain('offline for maintenance');
    expect((await call('/puzzle/', env)).status).toBe(200);
  });
});
