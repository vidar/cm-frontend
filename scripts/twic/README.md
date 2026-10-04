# TWIC games database

Over-the-board games from [The Week in Chess](https://theweekinchess.com/) by Mark Crowther,
used with permission for non-commercial use (credit + link to the issue on every game, no bulk
export). PGN downloads exist from issue 920 (2012) onwards.

## Full (re)build

```sh
pip install zstandard chess            # python-chess may need: pip install --use-pep517 chess
python3 scripts/twic/download.py --from 920 --to <latest> --dir /tmp/twic   # polite, resumable
curl -o /tmp/players_list.zip https://ratings.fide.com/download/players_list.zip   # FIDE names/feds/titles
python3 scripts/twic/build.py --dir /tmp/twic --out /tmp/twic.sqlite --fide /tmp/players_list.zip   # ~40 min, ~8 GB RAM
python3 scripts/twic/export_sql.py --db /tmp/twic.sqlite --out /tmp/twic.sql
python3 scripts/twic/opening_games.py --db /tmp/twic.sqlite                 # -> src/data/opening-master-games.json
```

Then import `/tmp/twic.sql` into D1 `cm-games` with D1's import API (init → upload the file to the
returned URL → ingest → poll). The SQL drops and recreates all tables, and the import blocks the
database while it runs (minutes).

Local development: `npx wrangler d1 execute cm-games --local --file /tmp/twic.sql` (use a small
`--limit` build for speed).

## Notes

- `schema.sql` is shared by the SQLite build and D1. Totals live in the `meta` table.
- Games are validated with python-chess; invalid games and set-up positions are skipped; duplicates
  (same players, date and moves) keep the earliest issue.
- Players are merged by FIDE ID and get their official FIDE name, federation, title and birth year.
  A game only counts for a FIDE ID if its name shares a name part with that player (TWIC sometimes
  attaches a wrong ID); otherwise it's filed under its own name. Players without a FIDE ID use the
  fullest TWIC spelling.
- `games.opening` is the slug of the longest matching named line (`/openings/<slug>/`).
