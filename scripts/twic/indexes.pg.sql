-- Secondary indexes, created after the bulk load (much faster than maintaining them during it).
CREATE INDEX IF NOT EXISTS games_white ON games (white_id, date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_event ON games (event_id, date);
CREATE INDEX IF NOT EXISTS games_opening ON games (opening, elo_avg DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_date ON games (date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS players_games ON players (games DESC);
CREATE INDEX IF NOT EXISTS players_search ON players USING gin (search gin_trgm_ops);
CREATE INDEX IF NOT EXISTS events_start ON events (start_date DESC NULLS LAST);
-- Game search (/games/search/): sort by rating or length without scanning the table.
CREATE INDEX IF NOT EXISTS games_elo ON games (elo_avg DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_plies ON games (plies);
-- ECO codes and ranges (opening=B90, B90-B99), newest first, instead of filtering a walk of games_date.
CREATE INDEX IF NOT EXISTS games_eco ON games (eco, date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS events_name ON events USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS openings_name ON openings USING gin (lower(name) gin_trgm_ops);
