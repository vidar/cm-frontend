-- Secondary indexes, created after the bulk load (much faster than maintaining them during it).
CREATE INDEX IF NOT EXISTS games_white ON games (white_id, date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_event ON games (event_id, date);
CREATE INDEX IF NOT EXISTS games_opening ON games (opening, elo_avg DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS games_date ON games (date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS players_games ON players (games DESC);
CREATE INDEX IF NOT EXISTS players_search ON players USING gin (search gin_trgm_ops);
CREATE INDEX IF NOT EXISTS events_start ON events (start_date DESC NULLS LAST);
