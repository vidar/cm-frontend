import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for src/lib (pure modules) and integration tests (tests/*-db.test.ts) against a local Postgres
// database (TEST_DATABASE_URL, default postgres://postgres:postgres@localhost:5432/cm_games_test; see tests/db.ts:
// they skip themselves when the default isn't reachable, and fail when an explicit TEST_DATABASE_URL isn't).
// `cloudflare:workers` is stubbed. The database files run one at a time: they share one database, and the
// upload tests republish site-wide (republishAll) while the analysis tests count every row of the day.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/**/*-db.test.ts'] } },
      { extends: true, test: { name: 'db', include: ['tests/**/*-db.test.ts'], fileParallelism: false } },
    ],
  },
});
