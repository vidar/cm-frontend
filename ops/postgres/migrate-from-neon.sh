#!/usr/bin/env bash
# Copy the chessmoments.com database from Neon into the local PostgreSQL (after install.sh), as root:
#
#   sudo bash ops/postgres/migrate-from-neon.sh            # dump, restore, grants, vacuum, verify
#   sudo bash ops/postgres/migrate-from-neon.sh --verify   # only compare Neon with the local copy again
#   sudo bash ops/postgres/migrate-from-neon.sh --reuse /var/lib/postgresql/migration/neon-....dump
#                                                          # restore an earlier dump (after a failed restore)
#   sudo NEON_SSLMODE=require bash ops/postgres/migrate-from-neon.sh
#                                                          # if checking Neon's certificate fails (see README)
#
# It reads the Neon owner connection string from /etc/cm-db/neon.env (root only; see README.md), turns
# it into a libpq service file so the password never appears on a command line, dumps the public
# schema with pg_dump (custom format, no owners or grants), restores it as cm_owner, applies
# scripts/db/grants.sql, VACUUM ANALYZEs, and compares every table with Neon (compare.sh). Neon is only
# read. The dump is kept in /var/lib/postgresql/migration/ as the final copy of the Neon database.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/../.." && pwd)
ETC=/etc/cm-db
DB=cm_games
WORK=/var/lib/postgresql/migration
VERIFY_ONLY=0
REUSE=
case ${1:-} in
  --verify) VERIFY_ONLY=1 ;;
  --reuse) REUSE=${2:?--reuse needs the dump file} ;;
  '') ;;
  *) echo "usage: $0 [--verify | --reuse <dump>]" >&2; exit 2 ;;
esac

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -s "$ETC/neon.env" ] || die "put the Neon connection string in $ETC/neon.env first (README.md, step 2)"
pg_isready -q || die "the local PostgreSQL is not running (install.sh first)"

say "Neon connection"
# A libpq service file (root only) from the URL; pg_dump needs the direct endpoint, not the -pooler one.
# neon.env holds NEON_DATABASE_URL=<url> (quotes optional) or just the URL; it is read, never sourced.
python3 -I - "$ETC/neon.env" "$ETC/pg_service.conf" "${NEON_SSLMODE:-verify-full}" <<'PY'
import os, sys, urllib.parse
url = ''
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith('NEON_DATABASE_URL='):
        line = line.split('=', 1)[1]
    if line.startswith(('postgres://', 'postgresql://', '"postgres', "'postgres")):
        url = line.strip('"\'')
u = urllib.parse.urlparse(url)
if u.scheme not in ('postgres', 'postgresql') or not u.hostname or not u.password:
    sys.exit('neon.env: NEON_DATABASE_URL must look like postgresql://user:password@ep-...neon.tech/dbname?sslmode=require')
q = dict(urllib.parse.parse_qsl(u.query))
# Whatever the pasted URL says: Neon's certificate is checked against the system CAs (verify-full), and
# channel binding ties the password exchange to that TLS session, so nothing in between can pose as Neon.
# (NEON_SSLMODE=require, if the certificate check ever fails: still encrypted, still channel binding.)
sslmode = sys.argv[3]
lines = ['[neon]', f'host={u.hostname.replace("-pooler.", ".")}', f'port={u.port or 5432}',
         f'dbname={u.path.lstrip("/") or "neondb"}', f'user={urllib.parse.unquote(u.username)}',
         f'password={urllib.parse.unquote(u.password)}', f'sslmode={sslmode}', 'channel_binding=require']
if sslmode == 'verify-full':
    lines.append('sslrootcert=system')
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ('\n'.join(lines) + '\n').encode())
os.close(fd)
PY
export PGSERVICEFILE=$ETC/pg_service.conf
NEON="service=neon"
LOCAL="dbname=$DB user=cm_owner"   # root -> cm_owner over the socket (peer map "cm", install.sh)
neon_ver=$(psql -X -At -d "$NEON" -c 'SHOW server_version_num') \
  || die "could not connect to Neon (the error above). Check the connection string in $ETC/neon.env; a suspended project (quota used up) cannot be dumped until its compute runs again"
neon_major=$((neon_ver / 10000))
dump_major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
echo "Neon runs PostgreSQL $neon_major; local pg_dump is $dump_major"
[ "$dump_major" -ge "$neon_major" ] || die "pg_dump $dump_major is older than the Neon server ($neon_major)"
# Only the public schema is copied: stop if anything lives elsewhere, or pg_trgm (the search indexes) isn't there.
outside=$(psql -X -At -d "$NEON" -c "SELECT string_agg(n.nspname || '.' || c.relname, ' ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'")
[ -z "$outside" ] || die "Neon has tables outside the public schema, which this copy would leave behind: $outside"
trgm=$(psql -X -At -d "$NEON" -c "SELECT extnamespace::regnamespace FROM pg_extension WHERE extname = 'pg_trgm'")
[ "$trgm" = public ] || die "pg_trgm is not in Neon's public schema (${trgm:-not installed}): the restore expects it there"

if [ "$VERIFY_ONLY" = 0 ]; then
  say "target database"
  tables=$(psql -X -At -d "$LOCAL" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
  [ "$tables" = 0 ] || die "$DB already has $tables tables. To start over: sudo -u postgres dropdb $DB && sudo bash $HERE/install.sh, then run this again (--reuse <dump> skips the dump). To only compare again: --verify"

  install -d -m 700 -o postgres -g postgres "$WORK"
  if [ -n "$REUSE" ]; then
    dump=$REUSE
    [ -s "$dump" ] || die "no dump at $dump"
  else
    say "dump from Neon"
    dump=$WORK/neon-$(date -u +%Y-%m-%dT%H%MZ).dump
    time pg_dump -Fc -Z zstd:3 -n public --no-owner --no-privileges --no-publications --no-subscriptions --no-security-labels \
      -d "$NEON" -f "$dump.part"
    pg_restore -f /dev/null "$dump.part"   # read every byte back (--list alone passes a truncated dump)
    mv "$dump.part" "$dump"
    chown postgres:postgres "$dump"; chmod 600 "$dump"
  fi
  ls -lh "$dump"

  say "restore as cm_owner"
  # Everything in the dump except the public schema itself (and its comment), which the database has already.
  list=$dump.list
  pg_restore --list "$dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$list"
  chown postgres:postgres "$list"
  # More memory for the index builds while nothing else uses the database; two jobs keep the box responsive.
  time runuser -u postgres -- env PGOPTIONS='-c maintenance_work_mem=512MB' \
    pg_restore -d "$DB" --role=cm_owner --no-owner --no-privileges --exit-on-error -j 2 -L "$list" "$dump"

  say "grants, VACUUM ANALYZE"
  # On stdin: the postgres user can't read the kit in a home directory (0750).
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "SET ROLE cm_owner" -f - < "$KIT/scripts/db/grants.sql"
  time runuser -u postgres -- vacuumdb -q -j 2 --analyze -d "$DB"
fi

say "compare Neon with the local copy"
bash "$HERE/compare.sh" "$NEON" "$LOCAL"

say "next"
cat <<EOF
The local database matches Neon. Next (README.md step 4): the TLS certificate,
  sudo bash $HERE/tls.sh
then the tunnel, the VPC service and the new Hyperdrive config. Neon is untouched; the dump in $WORK is the
final copy of it.
EOF
