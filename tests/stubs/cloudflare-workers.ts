// Stand-in for the `cloudflare:workers` module in tests: the bindings src/lib reads from `env`.
// The database tests default to a dedicated database, never cm_games (the one `wrangler dev` reads): they write,
// and the upload tests republish every approved upload. Make it with
// `createdb -T cm_games cm_games_test` or from the schema scripts as .github/workflows/test.yml does.
export const env = {
  HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cm_games_test' },
  ENGINE_URL: process.env.TEST_ENGINE_URL,
  STOCKFISH_TOKEN: process.env.TEST_STOCKFISH_TOKEN,
  ANTHROPIC_KEY: process.env.TEST_ANTHROPIC_KEY,
  ADMIN_KEY: process.env.TEST_ADMIN_KEY ?? 'test-admin-key',
  MAINTENANCE: '0',
};
