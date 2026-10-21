#!/usr/bin/env bash
# Restore a backup of the chessmoments.com database into a SEPARATE database, cm_games_restore, as root:
#
#   sudo bash ops/postgres/restore.sh                     # the newest full backup
#   sudo bash ops/postgres/restore.sh <file.dump>         # a given one (full backup or Neon dump)
#   sudo bash ops/postgres/restore.sh --test              # monthly drill: restore the newest, count, drop it
#
# The live database is never touched: the script prints row counts next to the live ones and the
# commands that would swap the two (a deliberate, manual step). To restore single tables from a "small"
# backup instead, see README.md ("Restore").
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/../.." && pwd)
DIR=${BACKUP_DIR:-/var/backups/cm-db}
DB=cm_games
TARGET=cm_games_restore
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

TEST=0
dump=
case ${1:-} in
  --test) TEST=1 ;;
  '') ;;
  *) dump=$1 ;;
esac
[ -n "$dump" ] || dump=$(ls -1t "$DIR"/daily/*.dump 2>/dev/null | head -1)
[ -s "$dump" ] || die "no backup found (looked in $DIR/daily)"
pg_restore --list "$dump" > /dev/null || die "$dump is not a readable pg_dump archive"
echo "restoring $dump into $TARGET"

psql_su() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
[ "$(psql_su -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'")" = 0 ] \
  || die "$TARGET exists already: look at it, then drop it with: sudo -u postgres dropdb $TARGET"
psql_su -d postgres -c "CREATE DATABASE $TARGET OWNER cm_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'"
psql_su -d "$TARGET" -c "REVOKE ALL ON DATABASE $TARGET FROM PUBLIC" -c "ALTER SCHEMA public OWNER TO cm_owner" \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" -c "SET ROLE cm_owner" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

# Everything except the public schema itself (a Neon dump made with -n public creates it; it exists).
list=$(mktemp)
trap 'rm -f "$list"' EXIT
pg_restore --list "$dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$list"
chmod 644 "$list"
# pg_restore runs as postgres; root opens the private dump and hands it over on stdin (no -j with stdin).
runuser -u postgres -- pg_restore -d "$TARGET" --role=cm_owner --no-owner --no-privileges --exit-on-error -L "$list" < "$dump"
psql_su -d "$TARGET" -c "SET ROLE cm_owner" -f "$KIT/scripts/db/grants.sql"
runuser -u postgres -- vacuumdb -q --analyze -d "$TARGET"

count() { # exact row counts per table
  psql_su -d "$1" -At -c "SELECT format('SELECT %L || '' '' || count(*) FROM public.%I;', tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" | psql_su -d "$1" -At
}
echo
echo "rows (restored | live):"
join -a1 -a2 -e '-' -o 0,1.2,2.2 <(count "$TARGET" | sort) <(count "$DB" 2>/dev/null | sort) | awk '{ printf "  %-18s %10s | %s\n", $1, $2, $3 }'

if [ "$TEST" = 1 ]; then
  psql_su -d postgres -c "DROP DATABASE $TARGET"
  echo "restore test OK ($dump); $TARGET dropped again."
  exit 0
fi
cat <<EOF

$TARGET is ready. To make it the live database (the site gets errors for a few seconds), as root:
  sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB', '$TARGET') AND pid <> pg_backend_pid()" \\
    -c "ALTER DATABASE $DB RENAME TO ${DB}_old" -c "ALTER DATABASE $TARGET RENAME TO $DB" -c "GRANT CONNECT ON DATABASE $DB TO cm_web, cm_owner"
Keep ${DB}_old until the site is checked, then: sudo -u postgres dropdb ${DB}_old
To throw the restore away instead: sudo -u postgres dropdb $TARGET
EOF
