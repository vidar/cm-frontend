import { describe, expect, it } from 'vitest';
import { splitPgn } from '../src/lib/pgn';
import { env } from 'cloudflare:workers';

describe('test setup', () => {
  it('imports src/lib modules', () => {
    expect(splitPgn('[White "a"]\n[Black "b"]\n\n1. e4 *')).toHaveLength(1);
  });
  it('stubs cloudflare:workers', () => {
    expect(env.HYPERDRIVE.connectionString).toContain('postgres://');
  });
});
