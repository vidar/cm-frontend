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
-- Ids of published events, players and games come from this counter, which never goes down: an id once given
-- out never names another game (src/lib/uploads.ts nextId). The hourly backup carries it.
CREATE SEQUENCE IF NOT EXISTS upload_ids_seq START 100000000 MINVALUE 100000000;
-- What is on the site, round by round: the upload time of the file each published round came from. Written
-- by every publish; only the full backup holds it (not the hourly one), so after a restore "Republish all
-- approved" finds the rounds that changed since.
CREATE TABLE IF NOT EXISTS upload_published (
  upload_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (upload_id, round)
);
-- (Once, where tournaments were published before the table existed: they are on the site as uploaded.)
INSERT INTO upload_published (upload_id, round, uploaded_at)
SELECT r.upload_id, r.round, r.uploaded_at FROM upload_rounds r JOIN uploads u ON u.id = r.upload_id
WHERE u.status = 'approved' AND u.event_id IS NOT NULL
  AND NOT EXISTS (SELECT FROM upload_published p WHERE p.upload_id = u.id)
ON CONFLICT DO NOTHING;
-- The site's role (cm_web) manages uploads and publishes them into games/events/players: its rights are
-- in scripts/db/grants.sql.
