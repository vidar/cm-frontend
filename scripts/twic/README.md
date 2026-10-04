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
python3 scripts/twic/opening_games.py --db /tmp/twic.sqlite                 # -> src/data/opening-master-games.json
NEON_DATABASE_URL=... python3 scripts/twic/import_neon.py --db /tmp/twic.sqlite --reset
```

The site reads the database from Neon Postgres through Hyperdrive (binding `HYPERDRIVE`, config
`cm-games`, connecting as the read-only role `readonly`). `import_neon.py` loads the SQLite build
over Neon's HTTPS SQL endpoint (standard library only, resumable: rerun without `--reset` to
continue), then creates the indexes (`indexes.pg.sql`), grants SELECT to `readonly` and ANALYZEs.
`NEON_DATABASE_URL` must be the owner role's connection string. `--reset` drops the tables, so
the site shows errors until the reload finishes; for zero downtime load into a Neon branch and
switch Hyperdrive's origin to it.

Local development: run Postgres locally, load it with `import_neon.py` (or `pg_restore` a dump
from Neon) and point `localConnectionString` in `wrangler.jsonc` at it.

## Notes

- `schema.sql` is the SQLite build's schema; `schema.pg.sql` + `indexes.pg.sql` the Postgres one
  (keep them in sync). Totals live in the `meta` table.
- Games are validated with python-chess; invalid games and set-up positions are skipped; duplicates
  (same players, date and moves) keep the earliest issue.
- Players are merged by FIDE ID and get their official FIDE name, federation, title and birth year.
  A game only counts for a FIDE ID if its name shares a name part with that player (TWIC sometimes
  attaches a wrong ID); otherwise it's filed under its own name. Players without a FIDE ID use the
  fullest TWIC spelling.
- `games.opening` is the slug of the longest matching named line (`/openings/<slug>/`).
