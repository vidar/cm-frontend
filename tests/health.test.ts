// /health/db (src/pages/health/db.ts): 200 when a statement gets through to the database, 503 when it fails;
// never cached. The database is replaced by a stub.
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

  it('answers 503 when the query fails', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: false });
  });
});
