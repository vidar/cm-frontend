-- Tournaments uploaded by organisers as PGN, round by round (src/lib/uploads.ts, /upload/). These two
-- tables are the source of truth. Once the site owner approves a tournament, it is published into
-- events/players/games with ids from 100000000 up (UPLOAD_ID_BASE), which the TWIC importer leaves
-- alone. After a TWIC --reset reload, republish uploads from /upload/admin/ (game ids then change).
CREATE TABLE IF NOT EXISTS uploads (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the organiser's secret link token
  name TEXT NOT NULL,
  site TEXT,
  format TEXT NOT NULL,                 -- swiss | round-robin | knockout | team
  contact TEXT,                         -- optional, shown to the site owner only
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  event_id INTEGER,                     -- events.id once published
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS upload_rounds (
  upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  pgn TEXT NOT NULL,                    -- as uploaded
  games TEXT NOT NULL,                  -- JSON: parsed games (src/lib/pgn.ts ParsedGame[])
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, round)
);
CREATE INDEX IF NOT EXISTS uploads_status ON uploads (status, created_at);
-- The site's Hyperdrive role manages uploads. Publishing also writes games/events/players and deletes
-- analyses of replaced games: that role can already do so (Neon console roles are in neon_superuser).
GRANT SELECT, INSERT, UPDATE, DELETE ON uploads, upload_rounds TO readonly;
GRANT USAGE ON SEQUENCE uploads_id_seq TO readonly;
