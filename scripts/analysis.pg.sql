-- Stockfish analyses of games (on demand, see src/lib/analysis.ts). Not touched by the TWIC import;
-- game ids are stable across --patch updates (a full --reset reload can renumber games: then
-- TRUNCATE game_analysis).
CREATE TABLE IF NOT EXISTS game_analysis (
  game_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,             -- queued | running | done | failed
  job_id TEXT,                      -- engine service job (POST /jobs)
  depth INTEGER,
  evals TEXT,                       -- JSON {"e": [...], "b": [...]}: eval and best move per position
  error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The site's Hyperdrive role writes analyses (and only needs to write this table).
GRANT SELECT, INSERT, UPDATE ON game_analysis TO readonly;
