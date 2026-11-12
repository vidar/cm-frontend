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

**Updating the live database** (a new issue each week, or build changes) without breaking URLs or downtime:
keep the SQLite file that is currently loaded (`twic-live.sqlite`), build into a new file with `--previous`, then
(if `twic-live.sqlite` is lost, recreate it from Postgres first, on the server as root:
`DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' python3 scripts/twic/export_live.py --out /tmp/twic-live.sqlite`;
it holds the same games, players, events and ids, so `--previous` and `remap_events.py` work as with the original)

```sh
python3 scripts/twic/download.py --from <next> --to <latest> --dir /tmp/twic
python3 scripts/twic/build.py --dir /tmp/twic --out /tmp/twic.sqlite --fide /tmp/players_list.zip --previous /tmp/twic-live.sqlite
python3 scripts/twic/remap_events.py --old /tmp/twic-live.sqlite --new /tmp/twic.sqlite
DATABASE_URL=... python3 scripts/twic/import_pg.py --db /tmp/twic.sqlite --patch
mv /tmp/twic.sqlite /tmp/twic-live.sqlite        # the next update's --previous
```

then purge the `games-db` cache tag (event and player pages changed) and rerun `opening_games.py` when the
openings data should follow.

- **`--previous`** keeps the id and slug of every game, player and event of the loaded build: games match by
  TWIC issue and moves, players by the games they played (else by FIDE ID), events by the games they hold. New
  rows get ids above the highest the loaded build ever used (`id_floor`), in the usual order (games by date,
  players by game count, events by start date), so a new issue only appends, and a game dated before older
  games still gets a new id at the end. Players no game names any more are kept as they were. Without
  `--previous` ids are numbered from 1 as before (same input, same ids).
- **`remap_events.py`** refuses the new build when an id names another game or player than in the loaded one,
  when loaded games or players are missing from it, or when a new game got an id below the loaded maximum: then
  build again with the right `--previous`, or do a full `--reset` import. It keeps event ids and slugs where
  the grouping changed (a new game joining two weekends of a league), records redirects for events folded into
  others and lists the games whose row changed (`changed_games`: event, players, ratings, round, opening...).
- **`--patch`** first checks a sample of the games and players Postgres holds against the build, then swaps the
  changed games, the events and the players (updated, new ones added) in with one transaction, appends the new
  games after the highest id and copies `meta` (the totals) last. Analyses and notes stay with their games. If it
  stops, run it again.
- A build change that drops games (a stricter dedup) leaves loaded games missing from the new build:
  `remap_events.py` says how many and refuses; with `--drop-missing` it accepts them and `--patch` deletes them
  (their pages then 404). The first update after the dedup fix of November 2026 needs this: the loaded build
  still holds re-sent copies. `--previous` also works against a build made before it existed.
- A plain `import_pg.py` (no flags) only resumes an interrupted load of the same build: it refuses when Postgres
  holds another one.

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

- **`--reset`** drops `games`, `players`, `events` and `event_redirects` (uploaded tournaments included), so the database pages
  fail until the reload ends. First put the site in maintenance (`MAINTENANCE` "1" in both `vars` blocks of
  `wrangler.jsonc`; only the database routes close). A reset renumbers the games (build without `--previous`), so afterwards
  empty the analyses and notes, which belong to the old ids
  (`sudo -u postgres psql -d cm_games -c 'SET ROLE cm_owner' -c 'TRUNCATE game_analysis, game_annotation'`),
  purge the `games-db` cache tag (pages of the old ids must not come back), set `MAINTENANCE` back to "0" (the
  upload pages are database routes too), then use "Republish all approved" on `/upload/admin/`.
- **Not during the nightly backup** (03:20 to about 03:40 UTC): a `--reset` or `--patch` waits for the dump's
  locks, and the site's reads would queue behind it.
- **`--patch`** swaps in one transaction; while it runs, publishing an uploaded round waits for it and gives
  up after 20 seconds ("busy, try again in a minute").

Local development: run Postgres locally, load it with `import_pg.py` (or `pg_restore` a backup) and point
`localConnectionString` in `wrangler.jsonc` at it. For the analysis, notes and upload features, also run
`scripts/analysis.pg.sql`, `annotation.pg.sql` and `uploads.pg.sql` once.

## Notes

- `schema.sql` is the SQLite build's schema; `schema.pg.sql` + `indexes.pg.sql` the Postgres one
  (keep them in sync; `events.kind`, `id_floor` and `changed_games` are the SQLite file's own). Totals live in
  the `meta` table.
- Tests: `python3 -m unittest discover -s scripts/twic/tests` (needs python-chess; the import test also needs
  `psql` and `TWIC_TEST_DATABASE_URL`, a scratch database it may wipe, and skips itself without them).
- Games are validated with python-chess; invalid games and set-up positions are skipped. Duplicates
  (same players, date and moves; or, from a later issue, same event, round, result and 20+ plies of moves
  with one player's name unchanged, i.e. a corrected spelling) keep the earliest issue for the credit and
  the latest copy's headers (later issues fix Round tags and names).
- Ratings above 3000 (`MAX_ELO`: typos such as 204269, engines) are stored as NULL. Engine events (TCEC,
  CCC, or mostly games between two players rated above 3000) have no `elo_avg`, so rating sorts and the
  homepage's top games skip them. `events.kind` ('engine', 'online' for chess.com/lichess sites) exists in
  the SQLite build only: `opening_games.py` leaves those events out of the opening pages' counts and
  master games.
- Players are merged by FIDE ID and get their official FIDE name, federation, title and birth year.
  A game only counts for a FIDE ID if its name shares a name part with that player (TWIC sometimes
  attaches a wrong ID), or, for names without a part of 3+ letters ('So,W', 'Li,Di'), the same surname
  and first initial; otherwise it's filed under its own name. Players without a FIDE ID use the
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
events and players (one whose slug a new TWIC row takes is renamed `<slug>-u<n>`). `--reset` drops them with everything else: afterwards open `/upload/admin/` and use "Republish all
approved" (the uploads themselves are kept in `uploads`/`upload_rounds`; republished games get new ids, so
their Stockfish analyses and AI notes are lost).
