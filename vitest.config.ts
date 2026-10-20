import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for src/lib (pure modules) and integration tests against a local Postgres copy of the
// games database (TEST_DATABASE_URL, default postgres://postgres:postgres@localhost:5432/cm_games;
// those tests skip themselves when it isn't reachable). `cloudflare:workers` is stubbed.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000 },
});
