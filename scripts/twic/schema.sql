-- TWIC games database (D1). Built by scripts/twic/build.py.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  fide_id INTEGER,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  search TEXT NOT NULL,          -- lowercase ASCII name for searching
  title TEXT,                    -- FIDE title (or most recent title seen in TWIC)
  fed TEXT,                      -- FIDE federation code
  born INTEGER,                  -- birth year (FIDE)
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
  twic INTEGER,                  -- first TWIC issue with games from this event
  type TEXT,                     -- most common EventType tag ('swiss', 'tourn', 'team', 'k.o.', ...), often missing
  rounds INTEGER                 -- highest round number seen
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
  result TEXT NOT NULL,          -- '1-0', '0-1', '1/2-1/2'
  date TEXT,                     -- 'YYYY-MM-DD' (or 'YYYY-MM' / 'YYYY' when partial)
  round TEXT,
  eco TEXT,
  opening TEXT,                  -- slug of the longest matching named line (/openings/<slug>/)
  plies INTEGER NOT NULL,
  twic INTEGER NOT NULL,         -- TWIC issue number (source credit)
  moves TEXT NOT NULL,           -- SAN moves separated by spaces
  white_team TEXT,               -- team events: WhiteTeam / BlackTeam tags
  black_team TEXT
);
CREATE TABLE IF NOT EXISTS openings (
  slug TEXT PRIMARY KEY,         -- /openings/<slug>/
  name TEXT NOT NULL,
  eco TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,          -- 'games', 'players', 'events', 'first_issue', 'last_issue', 'built_at'
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_white ON games (white_id, date DESC);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, date DESC);
CREATE INDEX IF NOT EXISTS games_event ON games (event_id);
CREATE INDEX IF NOT EXISTS games_opening ON games (opening, elo_avg DESC);
CREATE INDEX IF NOT EXISTS games_date ON games (date DESC);
CREATE INDEX IF NOT EXISTS players_games ON players (games DESC);
CREATE INDEX IF NOT EXISTS events_start ON events (start_date DESC);
