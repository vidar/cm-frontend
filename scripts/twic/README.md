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
DATABASE_URL=... python3 scripts/twic/import_pg.py --db /tmp/twic.sqlite --reset
```

**Updating the live database** (new issues, or build changes) without breaking URLs or downtime:
keep the SQLite file that is currently loaded (`twic-live.sqlite`), rebuild into a new file, then

```sh
python3 scripts/twic/remap_events.py --old /tmp/twic-live.sqlite --new /tmp/twic.sqlite
DATABASE_URL=... python3 scripts/twic/import_pg.py --db /tmp/twic.sqlite --patch
```

`remap_events.py` checks that game and player ids are unchanged (they are deterministic for the
same input; new issues only append games with later dates, but a new game dated earlier than
existing ones shifts ids, and then a full `--reset` import is needed), keeps event ids and slugs,
records redirects for events merged into others and lists the changed games. `--patch` swaps
the new events and changed games in with one transaction. New games (later issues) still need
loading: run `import_pg.py` without flags afterwards; it continues after the highest id.

The site reads the database from PostgreSQL on hetz-stock through Hyperdrive (`ops/postgres/README.md`).
`import_pg.py` loads the SQLite build through the `psql` client (standard library only, resumable: rerun
without `--reset` to continue), then creates the indexes (`indexes.pg.sql`), ANALYZEs and applies the grants.
`DATABASE_URL` connects as the owner role `cm_owner`; on the server itself, as root:
`DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql'` (no password: root maps to
`cm_owner` over the local socket). From elsewhere, keep the password in `~/.pgpass`, not in the URL. Grants:
where the role `cm_web` exists (the server) `scripts/db/grants.sql`, and the import stops at once if the
site's own tables (analyses, notes, uploads) are missing, since then it is the wrong or a new database; with
`NEON_DATABASE_URL` (Neon's HTTPS SQL endpoint, until the project is gone) the read grant to `readonly`; on a
local database none.

- **`--reset`** drops `games`, `players` and `events` (uploaded tournaments included), so the database pages
  fail until the reload ends. First put the site in maintenance (`MAINTENANCE` "1" in both `vars` blocks of
  `wrangler.jsonc`; only the database routes close). A reset is only needed when game ids shift, so afterwards
  empty the analyses and notes, which belong to the old ids
  (`sudo -u postgres psql -d cm_games -c 'SET ROLE cm_owner' -c 'TRUNCATE game_analysis, game_annotation'`),
  set `MAINTENANCE` back to "0" (the upload pages are database routes too), then use "Republish all approved"
  on `/upload/admin/` and purge the `games-db` tag.
- **Not during the nightly backup** (03:20 to about 03:40 UTC): a `--reset` or `--patch` waits for the dump's
  locks, and the site's reads would queue behind it.
- **`--patch`** swaps in one transaction; while it runs, publishing an uploaded round waits for it and gives
  up after 20 seconds ("busy, try again in a minute").

Local development: run Postgres locally, load it with `import_pg.py` (or `pg_restore` a backup) and point
`localConnectionString` in `wrangler.jsonc` at it. For the analysis, notes and upload features, also run
`scripts/analysis.pg.sql`, `annotation.pg.sql` and `uploads.pg.sql` once.

## Notes

- `schema.sql` is the SQLite build's schema; `schema.pg.sql` + `indexes.pg.sql` the Postgres one
  (keep them in sync). Totals live in the `meta` table.
- Games are validated with python-chess; invalid games and set-up positions are skipped; duplicates
  (same players, date and moves) keep the earliest issue.
- Players are merged by FIDE ID and get their official FIDE name, federation, title and birth year.
  A game only counts for a FIDE ID if its name shares a name part with that player (TWIC sometimes
  attaches a wrong ID); otherwise it's filed under its own name. Players without a FIDE ID use the
  fullest TWIC spelling.
- Events are grouped by name, split where no games were played for 120 days (`EVENT_GAP`):
  leagues move venue every weekend, so site and EventDate can't be part of the key.
- Team events: `games.white_team` / `black_team` (TWIC's WhiteTeam/BlackTeam). Round tags are
  `round.board` in individual events, `round.match` in team events (boards in id order) and
  `round.match.game` in knockouts; the event pages work out the format (src/lib/event.ts).
- `games.opening` is the slug of the longest matching named line (`/openings/<slug>/`).

## Uploaded tournaments

Organisers' uploads (`/upload/`, `src/lib/uploads.ts`) are published into the same `events`, `players` and
`games` tables with ids from 100000000. `import_pg.py` resumes below that range and `--patch` keeps those
events. `--reset` drops them with everything else: afterwards open `/upload/admin/` and use "Republish all
approved" (the uploads themselves are kept in `uploads`/`upload_rounds`; republished games get new ids, so
their Stockfish analyses and AI notes are lost).
