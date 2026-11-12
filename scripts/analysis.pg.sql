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
-- Added later: who asked (a hash, src/lib/analysis.ts requesterId(); no addresses), for the per-client
-- daily limit, and the index the daily counts use.
ALTER TABLE game_analysis ADD COLUMN IF NOT EXISTS requester TEXT;
CREATE INDEX IF NOT EXISTS game_analysis_requested ON game_analysis (requested_at);
-- The site's role (cm_web) writes analyses: its rights are in scripts/db/grants.sql.
