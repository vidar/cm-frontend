# Data sources

- `openings/*.tsv` — [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings),
  CC0 public domain. Columns: `eco`, `name`, `pgn`.
- `puzzles.json` — 730 daily puzzles (one per day from `start`) curated from the
  [Lichess puzzle database](https://database.lichess.org/#puzzles), CC0 public domain.
  Selection: popularity ≥ 92, ≥ 3000 plays, 1–3 player moves; rating band by weekday
  (Mon 1000–1300 … Sun 1800–2200). `moves[0]` is the opponent's move that sets up the puzzle;
  the solver plays `moves[1]`, `moves[3]`, … Regenerate before the set runs out (2028-10-01).
