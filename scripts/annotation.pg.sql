-- AI annotations of analysed games (on demand, see src/lib/annotate.ts): a summary and notes on key
-- moves, written by Claude from the stored Stockfish analysis (game_analysis). Same id caveat as
-- scripts/analysis.pg.sql: after a full --reset reload of the games, TRUNCATE this table too.
CREATE TABLE IF NOT EXISTS game_annotation (
  game_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,             -- running | done | failed
  model TEXT,                       -- Claude model that wrote it
  summary TEXT,
  notes TEXT,                       -- JSON [{"ply": n, "text": "..."}]
  error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_annotation_requested ON game_annotation (requested_at);
-- The site's Hyperdrive role writes annotations.
GRANT SELECT, INSERT, UPDATE ON game_annotation TO readonly;
