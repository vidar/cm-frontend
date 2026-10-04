-- TWIC games database (Neon Postgres, read through Hyperdrive). Loaded by scripts/twic/import_neon.py
-- from the SQLite file built by scripts/twic/build.py (see schema.sql for column notes).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  fide_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  search TEXT NOT NULL,
  title TEXT,
  fed TEXT,
  born INTEGER,
  max_elo INTEGER,
  games INTEGER NOT NULL,
  last_date TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site TEXT,
  slug TEXT NOT NULL UNIQUE,
  start_date TEXT,
  end_date TEXT,
  games INTEGER NOT NULL,
  twic INTEGER,
  type TEXT,
  rounds INTEGER
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  white_id INTEGER NOT NULL,
  black_id INTEGER NOT NULL,
  white_elo INTEGER,
  black_elo INTEGER,
  white_title TEXT,
  black_title TEXT,
  elo_avg INTEGER,
  result TEXT NOT NULL,
  date TEXT,
  round TEXT,
  eco TEXT,
  opening TEXT,
  plies INTEGER NOT NULL,
  twic INTEGER NOT NULL,
  moves TEXT NOT NULL,
  white_team TEXT,
  black_team TEXT
);
CREATE TABLE IF NOT EXISTS openings (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  eco TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_redirects (
  slug TEXT PRIMARY KEY,         -- slug of an event that was merged into another
  event_id INTEGER NOT NULL
);
-- Columns added after the first load (no-ops on a fresh database).
ALTER TABLE events ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS rounds INTEGER;
ALTER TABLE games ADD COLUMN IF NOT EXISTS white_team TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS black_team TEXT;
