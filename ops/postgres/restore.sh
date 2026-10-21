#!/usr/bin/env bash
# Restore a backup of the chessmoments.com database into a SEPARATE database, cm_games_restore, as root
# (installed as /usr/local/sbin/cm-db-restore by install.sh):
#
#   sudo cm-db-restore                     # the newest full backup
#   sudo cm-db-restore <file.dump>         # a given one (full backup or Neon dump)
#   sudo cm-db-restore --test              # the drill (monthly timer cm-db-restore-test): restore the newest
#                                          # into cm_games_drill, count, drop it again
#   sudo cm-db-restore --table game_annotation [file.dump]
#                                          # put back rows of one of the site's own tables (game_analysis,
#                                          # game_annotation, uploads, upload_rounds) from the newest hourly
#                                          # backup (or the given one) into the LIVE database
#
# A full restore never touches the live database: the script prints row counts next to the live ones and
# the commands that would swap the two (a deliberate, manual step). --table only adds the rows the live
# table lacks (a row that exists, perhaps newer, stays as it is) and deletes nothing, in one transaction.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GRANTS=$(cd "$HERE/../.." && pwd)/scripts/db/grants.sql        # in the kit
[ -f "$GRANTS" ] || GRANTS=/usr/local/lib/cm-db/grants.sql       # installed (install.sh)
DIR=${BACKUP_DIR:-/var/backups/cm-db}
DB=cm_games
TARGET=cm_games_restore
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$GRANTS" ] || die "grants.sql not found (run install.sh, or this script from the kit)"

TEST=0
TABLE=
dump=
case ${1:-} in
  --test) TEST=1; TARGET=cm_games_drill ;;   # never in the way of a real restore
  --table) TABLE=${2:?--table needs a table name}; dump=${3:-} ;;
  '') ;;
  *) dump=$1 ;;
esac

if [ -n "$TABLE" ]; then
  case $TABLE in game_analysis|game_annotation|uploads|upload_rounds) ;; *) die "--table: one of game_analysis, game_annotation, uploads, upload_rounds" ;; esac
  [ -n "$dump" ] || dump=$(ls -1t "$DIR"/small/*.dump 2>/dev/null | head -1 || true)
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
    echo "SET ROLE cm_owner;"
    echo "CREATE TEMP TABLE restore_rows (LIKE public.$TABLE);"
    pg_restore --data-only -t "$TABLE" -f - "$dump" \
      | awk -v t="COPY public.$TABLE " '!done && index($0, t) == 1 { $0 = "COPY pg_temp.restore_rows " substr($0, length(t) + 1); done = 1 } { print }'
    echo "WITH added AS (INSERT INTO public.$TABLE SELECT r.* FROM pg_temp.restore_rows r $where ON CONFLICT DO NOTHING RETURNING 1)"
    echo "SELECT (SELECT count(*) FROM added) || ' rows added, ' || (SELECT count(*) FROM pg_temp.restore_rows) || ' in the backup';"
    [ "$TABLE" != uploads ] || echo "SELECT setval('public.uploads_id_seq', greatest((SELECT max(id) FROM public.uploads), (SELECT last_value FROM public.uploads_id_seq)));"
  } | runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 --single-transaction -d "$DB") \
    || die "nothing was changed (the transaction rolled back)"
  grep -v '^[0-9]*$' <<< "$out" || true
  exit 0
fi
[ -n "$dump" ] || dump=$(ls -1t "$DIR"/daily/*.dump 2>/dev/null | head -1 || true)
[ -s "$dump" ] || die "no backup found (looked in $DIR/daily)"
pg_restore --list "$dump" > /dev/null || die "$dump is not a readable pg_dump archive"
echo "restoring $dump into $TARGET"

psql_su() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
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
  if [ "$TEST" = 1 ] && [ "$created" = 1 ]; then psql_su -d postgres -c "DROP DATABASE IF EXISTS $TARGET" || true; fi
}
trap cleanup EXIT
provider=$(psql_su -d postgres -Atc "SELECT CASE WHEN current_setting('server_version_num')::int >= 170000 THEN 'LOCALE_PROVIDER builtin BUILTIN_LOCALE ''C.UTF-8''' END")
psql_su -d postgres -c "CREATE DATABASE $TARGET OWNER cm_owner TEMPLATE template0 ENCODING 'UTF8' $provider LOCALE 'C.UTF-8'"
created=1
psql_su -d "$TARGET" -c "REVOKE ALL ON DATABASE $TARGET FROM PUBLIC" -c "ALTER SCHEMA public OWNER TO cm_owner" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" -c "SET ROLE cm_owner" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

# Everything except the public schema itself (a Neon dump made with -n public creates it; it exists).
pg_restore --list "$dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$list"
chmod 644 "$list"
# pg_restore runs as postgres; root opens the private dump and hands it over on stdin (no -j with stdin).
runuser -u postgres -- pg_restore -d "$TARGET" --role=cm_owner --no-owner --no-privileges --exit-on-error -L "$list" < "$dump"
psql_su -d "$TARGET" -c "SET ROLE cm_owner" -f - < "$GRANTS"   # on stdin: postgres may not read the kit
runuser -u postgres -- vacuumdb -q --analyze -d "$TARGET"

count() { # exact row counts per table
  psql_su -d "$1" -At -c "SELECT format('SELECT %L || '' '' || count(*) FROM public.%I;', tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" | psql_su -d "$1" -At
}
echo
echo "rows (restored | live):"
join -a1 -a2 -e '-' -o 0,1.2,2.2 <(count "$TARGET" | sort) <(count "$DB" 2>/dev/null | sort) | awk '{ printf "  %-18s %10s | %s\n", $1, $2, $3 }'

if [ "$TEST" = 1 ]; then
  echo "restore test OK ($dump); $TARGET is dropped again."
  exit 0
fi
cat <<EOF

$TARGET is ready. To make it the live database: first put the site in maintenance (MAINTENANCE "1" in both
vars blocks of wrangler.jsonc, deployed), so visitors see a notice instead of errors. Then, as root (it stops
new connections to the live database, ends the open ones and swaps the names; any error stops it):
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE $DB WITH ALLOW_CONNECTIONS false" \\
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB', '$TARGET') AND pid <> pg_backend_pid()" \\
    -c "ALTER DATABASE $DB RENAME TO ${DB}_old" -c "ALTER DATABASE $TARGET RENAME TO $DB" -c "GRANT CONNECT ON DATABASE $DB TO cm_web, cm_owner"
If it stops with an error, undo what it did (skip the first command when there is no ${DB}_old yet):
  sudo -u postgres psql -c "ALTER DATABASE ${DB}_old RENAME TO $DB"
  sudo -u postgres psql -c "ALTER DATABASE $DB WITH ALLOW_CONNECTIONS true"
Then MAINTENANCE "0" again. Keep ${DB}_old until the site is checked, then:
  sudo -u postgres dropdb ${DB}_old
To throw the restore away instead: sudo -u postgres dropdb $TARGET
EOF
