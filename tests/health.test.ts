// /health/db (src/pages/health/db.ts): 200 when a statement gets through to the database, 503 when it fails,
// 503 saying "maintenance" while the database routes are closed on purpose; never cached. The database is
// replaced by a stub.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../src/lib/games', () => ({ query }));
const { GET } = await import('../src/pages/health/db');
const call = () => (GET as unknown as () => Promise<Response>)();

describe('/health/db', () => {
  it('answers 200 when the database answers', async () => {
    query.mockResolvedValueOnce([{ now: '2026-10-21' }]);
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true });
    expect(query.mock.calls.at(-1)?.[0]).toMatch(/now\(\)/); // keeps Hyperdrive's cache out of it
  });

  it('says maintenance, without asking the database, while MAINTENANCE is "1"', async () => {
    const e = env as { MAINTENANCE?: string };
    e.MAINTENANCE = '1';
    try {
      query.mockClear();
      const r = await call();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, maintenance: true });
      expect(query).not.toHaveBeenCalled();
    } finally {
      e.MAINTENANCE = '0';
    }
  });

  it('answers 503 when the query fails', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: false });
  });
});
