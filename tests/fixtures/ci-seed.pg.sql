-- A few TWIC-style rows for the database tests in CI (.github/workflows/test.yml), on a database made from the
-- schema scripts alone: one event, four players and five games with legal moves, the minimum analysis-db needs
-- (five games without analyses below UPLOAD_ID_BASE). Not the production snapshot or the 14-issue sample: the
-- tests tied to those (games-db, game-search-db) skip themselves here. Idempotent.
INSERT INTO events (id, name, site, slug, start_date, end_date, games, twic, type, rounds) VALUES
  (1, 'Fixture Open 2024', 'Testville', 'fixture-open-2024', '2024-01-06', '2024-01-07', 5, 1500, 'swiss', 3)
ON CONFLICT DO NOTHING;
INSERT INTO players (id, fide_id, name, slug, search, title, fed, born, max_elo, games, last_date) VALUES
  (1, NULL, 'Fixture, Anna', 'fixture-anna', 'fixture anna', 'IM', 'NOR', 1990, 2400, 3, '2024-01-07'),
  (2, NULL, 'Fixture, Bruno', 'fixture-bruno', 'fixture bruno', NULL, 'GER', NULL, 2200, 3, '2024-01-07'),
  (3, NULL, 'Fixture, Clara', 'fixture-clara', 'fixture clara', NULL, 'FRA', NULL, 2100, 2, '2024-01-07'),
  (4, NULL, 'Fixture, David', 'fixture-david', 'fixture david', NULL, NULL, NULL, NULL, 2, '2024-01-07')
ON CONFLICT DO NOTHING;
INSERT INTO games (id, event_id, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, opening, plies, twic, moves) VALUES
  (1, 1, 1, 2, 2400, 2200, 'IM', NULL, 2300, '1-0', '2024-01-06', '1.1', 'C20', NULL, 7, 1500, 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#'),
  (2, 1, 3, 4, 2100, NULL, NULL, NULL, NULL, '1/2-1/2', '2024-01-06', '1.2', 'C68', NULL, 6, 1500, 'e4 e5 Nf3 Nc6 Bb5 a6'),
  (3, 1, 2, 3, 2200, 2100, NULL, NULL, 2150, '0-1', '2024-01-07', '2.1', 'D31', NULL, 4, 1500, 'd4 d5 c4 e6'),
  (4, 1, 4, 1, NULL, 2400, NULL, 'IM', NULL, '0-1', '2024-01-07', '2.2', 'A30', NULL, 2, 1500, 'c4 c5'),
  (5, 1, 1, 2, 2400, 2200, 'IM', NULL, 2300, '1-0', '2024-01-07', '3.1', 'B90', NULL, 10, 1500, 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6')
ON CONFLICT DO NOTHING;
INSERT INTO meta (key, value) VALUES
  ('games', '5'), ('players', '4'), ('events', '1'), ('first_issue', '1500'), ('last_issue', '1500'), ('built_at', '2024-01-08')
ON CONFLICT DO NOTHING;
