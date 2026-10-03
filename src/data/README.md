# Data sources

- `openings/*.tsv` — [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings),
  CC0 public domain. Columns: `eco`, `name`, `pgn`.
- `puzzles.json` — 730 daily puzzles (one per day from `start`) curated from the
  [Lichess puzzle database](https://database.lichess.org/#puzzles), CC0 public domain.
  Selection: popularity ≥ 92, ≥ 3000 plays, 1–3 player moves; rating band by weekday
  (Mon 1000–1300 … Sun 1800–2200). `moves[0]` is the opponent's move that sets up the puzzle;
  the solver plays `moves[1]`, `moves[3]`, … Regenerate before the set runs out (2028-10-01).
- `opening-stats.json` — per-line statistics computed by `scripts/opening-stats.py` from a sample of
  the [Lichess standard games database](https://database.lichess.org/#standard_games) (CC0): games
  reaching each named line by its exact move order, results by average-rating band, the 8 most
  played next moves and the 3 highest-rated games. Blitz and slower only; BOT accounts excluded.
  Regenerate: `python3 scripts/opening-stats.py --month YYYY-MM --games 20000000` (~15 min).
- `opening-evals.json` — Stockfish evaluations of each line's final position from the
  [Lichess evaluations database](https://database.lichess.org/#evals) (CC0), deepest available.
  Regenerate: `node scripts/opening-fens.mjs > /tmp/fens.json && python3 scripts/opening-evals.py --fens /tmp/fens.json`
  (streams ~22 GB, ~15 min).
