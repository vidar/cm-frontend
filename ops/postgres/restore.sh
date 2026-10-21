#!/usr/bin/env bash
# Restore a backup of the chessmoments.com database into a SEPARATE database, cm_games_restore, as root
# (installed as /usr/local/sbin/cm-db-restore by install.sh):
#
#   sudo cm-db-restore                     # the newest full backup
#   sudo cm-db-restore <file.dump>         # a given one (full backup or Neon dump)
#   sudo cm-db-restore --test [file.dump]  # the drill (monthly timer cm-db-restore-test): restore the newest
#                                          # (or the given one) into cm_games_drill, count, drop it again
#   sudo cm-db-restore --table game_annotation [file.dump]
#                                          # put back rows of one of the site's own tables (game_analysis,
#                                          # game_annotation, uploads, upload_rounds) from the newest hourly
#                                          # backup (or the given one) into the LIVE database
#   sudo cm-db-restore --site-tables <file.dump> [--force]
#                                          # REPLACE all four with an hourly backup's rows (after a full
#                                          # restore, from an hourly backup made after that full one: it
#                                          # refuses an older one unless --force)
#
# A full restore never touches the live database: the script prints row counts next to the live ones and
# the commands that would swap the two (a deliberate, manual step). --table only adds the rows the live
# table lacks (a row that exists, perhaps newer, stays as it is) and deletes nothing; --site-tables empties
# the four tables and loads the backup's rows. Both run in one transaction: on any error nothing changes.
# Everything that comes out of a dump runs as cm_owner (root's peer map), never as a superuser: a dump can't
# carry anything that takes over the server.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The site's schema scripts and the site role's rights, applied to a restored database (an older backup may
# predate some of the schema): from the kit, or as install.sh installed them.
SQL=$(cd "$HERE/../.." && pwd)/scripts
if [ -f "$SQL/db/grants.sql" ]; then GRANTS=$SQL/db/grants.sql; else SQL=/usr/local/lib/cm-db GRANTS=/usr/local/lib/cm-db/grants.sql; fi
SCHEMA=("$SQL/analysis.pg.sql" "$SQL/annotation.pg.sql" "$SQL/uploads.pg.sql")
DIR=${BACKUP_DIR:-/var/backups/cm-db}
DB=cm_games
TARGET=cm_games_restore
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
for f in "$GRANTS" "${SCHEMA[@]}"; do [ -f "$f" ] || die "$f not found (run install.sh, or this script from the kit)"; done

TEST=0
TABLE=
SITE=0
FORCE=0
dump=
case ${1:-} in
  --test) TEST=1; TARGET=cm_games_drill; dump=${2:-} ;;   # never in the way of a real restore
  --table) TABLE=${2:?--table needs a table name}; dump=${3:-} ;;
  --site-tables) SITE=1; dump=${2:-}; [ "${3:-}" != --force ] || FORCE=1 ;;
  '') ;;
  *) dump=$1 ;;
esac
newest_small() { ls -1t "$DIR"/small/*.dump 2>/dev/null | head -1 || true; }
# When a dump was made (pg_dump writes it into the archive), in seconds since 1970; empty if unknown.
made_at() { local t; t=$(pg_restore --list "$1" 2>/dev/null | sed -n 's/^; Archive created at //p' | head -1); [ -z "$t" ] || date -d "$t" +%s 2>/dev/null || true; }
utc() { date -u -d "@$1" '+%Y-%m-%d %H:%M UTC'; }
# A full restore notes on its database when its backup was made (the note stays through the swap).
NOTE='cm-db-restore: full backup made at '
# psql as cm_owner: root over the socket, peer map "cm" (pg_hba.conf: cm_games, cm_games_restore, cm_games_drill).
as_owner() { local db=$1; shift; psql -X -q -v ON_ERROR_STOP=1 -d "dbname=$db user=cm_owner" "$@"; }

if [ -n "$TABLE" ]; then
  case $TABLE in game_analysis|game_annotation|uploads|upload_rounds) ;; *) die "--table: one of game_analysis, game_annotation, uploads, upload_rounds" ;; esac
  [ -n "$dump" ] || dump=$(newest_small)
  [ -s "$dump" ] || die "no backup found (looked in $DIR/small)"
  pg_restore -f /dev/null "$dump" || die "$dump is not a readable pg_dump archive"
  echo "adding the rows of $TABLE that the live database lacks, from $dump"
  case $TABLE in
    game_analysis|game_annotation)
      echo "(game ids are stable across --patch imports; a dump from before a TWIC --reset belongs to other games)"
      where="WHERE EXISTS (SELECT FROM public.games g WHERE g.id = r.game_id)" ;;
    upload_rounds) where="WHERE EXISTS (SELECT FROM public.uploads u WHERE u.id = r.upload_id)" ;;
    *) where= ;;
  esac
  # Root reads the dump; its rows go into a temporary copy of the table, then only the missing ones in.
  out=$({
    echo "CREATE TEMP TABLE restore_rows (LIKE public.$TABLE);"
    pg_restore --data-only -t "$TABLE" -f - "$dump" \
      | awk -v t="COPY public.$TABLE " '!done && index($0, t) == 1 { $0 = "COPY pg_temp.restore_rows " substr($0, length(t) + 1); done = 1 } { print }'
    echo "WITH added AS (INSERT INTO public.$TABLE SELECT r.* FROM pg_temp.restore_rows r $where ON CONFLICT DO NOTHING RETURNING 1)"
    echo "SELECT (SELECT count(*) FROM added) || ' rows added, ' || (SELECT count(*) FROM pg_temp.restore_rows) || ' in the backup';"
    [ "$TABLE" != uploads ] || echo "SELECT setval('public.uploads_id_seq', greatest((SELECT max(id) FROM public.uploads), (SELECT last_value FROM public.uploads_id_seq)));"
  } | as_owner "$DB" -At --single-transaction) || die "nothing was changed (the transaction rolled back)"
  grep -v '^[0-9]*$' <<< "$out" || true
  exit 0
fi

if [ "$SITE" = 1 ]; then
  # No default: after a restore the newest hourly backup may already be one of the restored (older) data.
  [ -n "$dump" ] || die "name the hourly backup (the newest one from before the restore), e.g.:
$(ls -1t "$DIR"/small/*.dump 2>/dev/null | head -5 | sed 's/^/  /')"
  [ -s "$dump" ] || die "no backup at $dump"
  pg_restore -f /dev/null "$dump" || die "$dump is not a readable pg_dump archive"
  toc=$(pg_restore --list "$dump")
  ! grep -qE ' TABLE DATA public games ' <<< "$toc" || die "$dump is a full backup: --site-tables takes an hourly one ($DIR/small)"
  for t in game_analysis game_annotation uploads upload_rounds; do
    grep -qE " TABLE DATA public $t " <<< "$toc" || die "$dump has no $t"
  done
  # An hourly backup older than the full backup this database came from would take back what the full one
  # has (analyses, notes, rounds and approvals of the time between); the full backup's own tables are newer.
  full=$(runuser -u postgres -- psql -X -At -d postgres -c "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '$DB'" | sed -n "s/^$NOTE\([0-9]*\).*/\1/p")
  hourly=$(made_at "$dump")
  if [ "$FORCE" = 0 ] && [ -n "$full" ] && [ -n "$hourly" ] && [ "$hourly" -lt "$full" ]; then
    die "$dump was made $(utc "$hourly"), before the full backup this database was restored from ($(utc "$full")).
Its rows are older than the ones the database has: skip this step (the full backup's own tables fit its games),
or add --force to load it anyway."
  fi
  echo "replacing game_analysis, game_annotation, uploads and upload_rounds with the rows in $dump"
  # The data and the sequence value, uploads first (upload_rounds refers to it): -L restores in the list's order.
  order=$(mktemp)
  trap 'rm -f "$order"' EXIT
  { grep -E ' TABLE DATA public uploads ' <<< "$toc"
    grep -E ' (TABLE DATA|SEQUENCE SET) public ' <<< "$toc" | grep -vE ' TABLE DATA public uploads ' || true; } > "$order"
  out=$({
    echo "TRUNCATE game_analysis, game_annotation, upload_rounds, uploads;"
    # The counter of uploaded ids never goes down (src/lib/uploads.ts nextId): the higher of the database's and
    # the backup's. (Read after the TRUNCATE, whose locks keep a publish from moving it in between.)
    echo "SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END AS keep_next FROM public.upload_ids_seq \\gset"
    pg_restore --data-only -L "$order" -f - "$dump"
    echo "SELECT setval('public.upload_ids_seq', greatest(:keep_next, (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM public.upload_ids_seq)), false);"
    # (pg_restore's output empties search_path: qualified names from here on.) Analyses and notes of uploaded
    # games this database doesn't have (published after the full backup) go. Those of TWIC games stay: a TWIC
    # import after the full backup comes back under the same ids when it is run again.
    echo "DELETE FROM public.game_analysis a WHERE game_id >= 100000000 AND NOT EXISTS (SELECT FROM public.games g WHERE g.id = a.game_id);"
    echo "DELETE FROM public.game_annotation a WHERE game_id >= 100000000 AND NOT EXISTS (SELECT FROM public.games g WHERE g.id = a.game_id);"
    echo "SELECT (SELECT count(*) FROM public.game_analysis) || ' analyses, ' || (SELECT count(*) FROM public.game_annotation) || ' notes, '"
    echo "  || (SELECT count(*) FROM public.uploads) || ' uploads, ' || (SELECT count(*) FROM public.upload_rounds) || ' upload rounds now';"
  } | as_owner "$DB" -At --single-transaction) || die "nothing was changed (the transaction rolled back)"
  grep -v '^[0-9]*$' <<< "$out" || true
  echo "Next, with the database routes open (MAINTENANCE \"0\"): \"Republish all approved\" on /upload/admin/. It publishes"
  echo "again the rounds of uploaded tournaments that changed since the full backup and takes down tournaments rejected since."
  exit 0
fi
[ -n "$dump" ] || dump=$(ls -1t "$DIR"/daily/*.dump 2>/dev/null | head -1 || true)
[ -s "$dump" ] || die "no backup found (looked in $DIR/daily)"
pg_restore --list "$dump" > /dev/null || die "$dump is not a readable pg_dump archive"
echo "restoring $dump into $TARGET"

psql_su() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
if [ "$TEST" = 1 ]; then
  # One drill at a time (the timer and a hand-started one would drop each other's copy).
  exec 9> /run/cm-db-restore-test.lock
  flock -n 9 || die "a restore drill is running already"
  # The drill runs gently (no parallel index builds or scans next to the site's queries), and a copy an
  # interrupted drill left behind goes first.
  export PGOPTIONS='-c max_parallel_maintenance_workers=0 -c max_parallel_workers_per_gather=0'
  psql_su -d postgres -c "DROP DATABASE IF EXISTS $TARGET WITH (FORCE)" 2>&1 | grep -v 'does not exist, skipping' || true
fi
[ "$(psql_su -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'")" = 0 ] \
  || die "$TARGET exists already: look at it, then drop it with: sudo -u postgres dropdb $TARGET"
# Room for a second copy: the live database's size (or five times the dump), plus 20 %.
live=$(psql_su -d postgres -Atc "SELECT coalesce(sum(pg_database_size(datname)), 0) FROM pg_database WHERE datname = '$DB'")
need_kb=$(( (live > $(stat -c %s "$dump") * 5 ? live : $(stat -c %s "$dump") * 5) * 12 / 10 / 1024 ))
avail_kb=$(df -P -k /var/lib/postgresql | awk 'NR == 2 { print $4 }')
[ "$avail_kb" -gt "$need_kb" ] || die "not enough disk: $((avail_kb / 1048576)) GB free, a restore needs about $((need_kb / 1048576 + 1)) GB"

list=$(mktemp)
created=0
cleanup() {
  rm -f "$list"
  # The drill never leaves its copy behind, even when it fails (else every later drill would refuse to run).
  # FORCE: a stopped drill's backend may still be busy in it.
  if [ "$TEST" = 1 ] && [ "$created" = 1 ]; then psql_su -d postgres -c "DROP DATABASE IF EXISTS $TARGET WITH (FORCE)" || true; fi
}
trap cleanup EXIT
provider=$(psql_su -d postgres -Atc "SELECT CASE WHEN current_setting('server_version_num')::int >= 170000 THEN 'LOCALE_PROVIDER builtin BUILTIN_LOCALE ''C.UTF-8''' END")
psql_su -d postgres -c "CREATE DATABASE $TARGET OWNER cm_owner TEMPLATE template0 ENCODING 'UTF8' $provider LOCALE 'C.UTF-8'"
created=1
psql_su -d "$TARGET" -c "REVOKE ALL ON DATABASE $TARGET FROM PUBLIC" -c "ALTER SCHEMA public OWNER TO cm_owner" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" -c "SET ROLE cm_owner" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

# Everything except the public schema itself (a Neon dump made with -n public creates it; it exists).
pg_restore --list "$dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$list"
# As cm_owner (root reads the dump); two jobs for a real restore, one for the drill.
jobs=(-j 2); [ "$TEST" = 0 ] || jobs=()
pg_restore -d "dbname=$TARGET user=cm_owner" --no-owner --no-privileges --exit-on-error "${jobs[@]}" -L "$list" "$dump"
for f in "${SCHEMA[@]}" "$GRANTS"; do as_owner "$TARGET" -f "$f"; done
runuser -u postgres -- vacuumdb -q --analyze -d "$TARGET"
made=$(made_at "$dump")
[ "$TEST" = 1 ] || [ -z "$made" ] || psql_su -d postgres -c "COMMENT ON DATABASE $TARGET IS '$NOTE$made ($(utc "$made"))'"

count() { # exact row counts per table, as cm_owner
  as_owner "$1" -At -c "SELECT format('SELECT %L || '' '' || count(*) FROM public.%I;', tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" | as_owner "$1" -At
}
estimate() { # the planner's row estimates (no scan of the live tables; -1 = never analysed)
  psql_su -d "$1" -At -F ' ' -c "SELECT relname, reltuples::bigint FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'"
}
echo
if [ "$TEST" = 1 ]; then
  echo "rows (restored | live, estimated):"
  rows=$(join -a1 -a2 -e '-' -o 0,1.2,2.2 <(count "$TARGET" | sort) <(estimate "$DB" 2>/dev/null | sort))
  awk '{ printf "  %-18s %10s | %s\n", $1, $2, $3 }' <<< "$rows"
  # A restore that is much smaller than the live database means a bad or half-written dump.
  short=$(awk '$3 ~ /^[0-9]+$/ && $3 >= 1000 && ($2 !~ /^[0-9]+$/ || $2 < 0.9 * $3) { printf "%s ", $1 }' <<< "$rows")
  [ -z "$short" ] || die "the restored copy has far fewer rows than the live database in: $short"
  echo "restore test OK ($dump); $TARGET is dropped again."
  exit 0
fi
echo "rows (restored | live):"
join -a1 -a2 -e '-' -o 0,1.2,2.2 <(count "$TARGET" | sort) <(count "$DB" 2>/dev/null | sort) | awk '{ printf "  %-18s %10s | %s\n", $1, $2, $3 }'
# Step 3 without a fresh hourly backup: the newest one, if it was made after this full backup.
small=$(newest_small)
if [ -n "$small" ] && [ -n "$made" ]; then
  s_made=$(made_at "$small")
  [ -n "$s_made" ] && [ "$s_made" -gt "$made" ] || small=
fi
cat <<EOF

$TARGET is ready. To make it the live database, in this order:
1. Put the site in maintenance (MAINTENANCE "1" in both vars blocks of wrangler.jsonc, deployed), so nothing
   writes any more and visitors see a notice instead of errors. If the live database still answers and its own
   tables (analyses, notes, uploads) are not what went wrong, save them as they are now (it prints the file):
     sudo cm-db-backup small
   Then pause the backups, so none of them saves the restored (older) data as the newest:
     sudo systemctl stop cm-db-backup.timer cm-db-backup-small.timer
2. Swap the databases (it stops new connections to the live one, ends the open ones and swaps the names; any
   error stops it):
     sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE $DB WITH ALLOW_CONNECTIONS false" \\
       -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB', '$TARGET') AND pid <> pg_backend_pid()" \\
       -c "ALTER DATABASE $DB RENAME TO ${DB}_old" -c "ALTER DATABASE $TARGET RENAME TO $DB" -c "GRANT CONNECT ON DATABASE $DB TO cm_web, cm_owner"
   If it stops with an error, undo what it did (skip the first command when there is no ${DB}_old yet):
     sudo -u postgres psql -c "ALTER DATABASE ${DB}_old RENAME TO $DB"
     sudo -u postgres psql -c "ALTER DATABASE $DB WITH ALLOW_CONNECTIONS true"
3. The site's own tables, from the file step 1 printed (without one: the newest good hourly backup made after
   this full one, now ${small:-none in $DIR/small/: then skip this step, as the full backup holds the newest rows}):
     sudo cm-db-restore --site-tables <file>
4. If TWIC issues were imported after this full backup, import them again now (scripts/twic/README.md): the
   importer goes on where the restored database ends, with the same game ids, analyses and notes.
5. Backups on again: sudo systemctl start cm-db-backup.timer cm-db-backup-small.timer
6. MAINTENANCE "0", then "Republish all approved" on /upload/admin/, then purge the games-db cache tag.
Keep ${DB}_old until the site is checked, then: sudo -u postgres dropdb ${DB}_old
To throw the restore away instead: sudo -u postgres dropdb $TARGET
EOF
