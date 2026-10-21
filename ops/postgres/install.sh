#!/usr/bin/env bash
# Install and configure PostgreSQL for chessmoments.com on hetz-stock (Ubuntu 26.04), as root:
#
#   sudo bash ops/postgres/install.sh            # localhost only (enough: Hyperdrive comes in through the tunnel)
#   sudo TAILSCALE_IP=100.77.91.56 bash ops/postgres/install.sh
#                                                 # also let cm_owner in from the Mac mini over Tailscale
#                                                 # (TAILNET_CLIENTS, default its address 100.120.87.91);
#                                                 # remembered for later runs, TAILSCALE_IP=off removes it
#
# Safe to run again (after editing the files next to it, or to repair a drifted setup): it reloads the
# settings and restarts Postgres only when a changed setting needs it. It never prints a password and
# never changes one that exists. What it does:
#   1. installs Ubuntu's postgresql-18 (one cluster, "main", locale C.UTF-8 from PostgreSQL's builtin
#      provider, like Neon's databases: no glibc collation changes on OS upgrades);
#   2. installs postgresql.conf (conf.d/50-chessmoments.conf), the listen addresses (60-listen.conf),
#      pg_hba.conf and pg_ident.conf (the original Debian files are kept as *.orig);
#   3. adds systemd drop-ins: postgresql@.service (OOM policy, restart) and system-postgresql.slice (CPU
#      priority over the engine and renders, no swap);
#   4. creates the roles cm_owner (owns the database; imports) and cm_web (Hyperdrive), with random
#      passwords kept in /etc/cm-db/<role>.password (root only), and the database cm_games with pg_trgm;
#   5. applies scripts/db/grants.sql once the tables exist (after migrate-from-neon.sh);
#   6. installs the backup, health-check and monthly restore-drill timers (cm-db-backup, cm-db-check,
#      cm-db-restore-test) and the restore command cm-db-restore.
# Postgres listens on localhost (and the Tailscale IP when given): there is no firewall on this box,
# so it must never listen on 0.0.0.0. Hyperdrive reaches it through the Cloudflare Tunnel (tunnel.sh).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/../.." && pwd)            # repo root (or the unpacked kit): needs ops/postgres and scripts/db
DB=cm_games
CLUSTER=${CLUSTER:-main}
PGMAJOR=${PGMAJOR:-18}                               # Ubuntu 26.04's PostgreSQL
ETC=/etc/cm-db
BACKUP_DIR=${BACKUP_DIR:-/var/backups/cm-db}
LIB=/usr/local/lib/cm-db                             # what the timers need from the kit (grants.sql)
# The Tailscale settings of an earlier run, unless given again.
saved_ip='' saved_clients=''
if [ -f "$ETC/install.env" ]; then
  saved_ip=$(sed -n 's/^TAILSCALE_IP=//p' "$ETC/install.env")
  saved_clients=$(sed -n 's/^TAILNET_CLIENTS=//p' "$ETC/install.env")
fi
TAILSCALE_IP=${TAILSCALE_IP-$saved_ip}
[ "$TAILSCALE_IP" = off ] && TAILSCALE_IP=
TAILNET_CLIENTS=${TAILNET_CLIENTS:-${saved_clients:-100.120.87.91}}   # tailnet addresses allowed in as cm_owner

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$KIT/scripts/db/grants.sql" ] || die "scripts/db/grants.sql not found next to the kit ($KIT)"
if [ -n "$TAILSCALE_IP" ]; then
  [[ $TAILSCALE_IP =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "TAILSCALE_IP must be a 100.64.0.0/10 address"
  for c in $TAILNET_CLIENTS; do
    [[ $c =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "TAILNET_CLIENTS: $c is not a Tailscale IPv4 address"
  done
fi
systemd() { [ -d /run/systemd/system ]; }   # false in containers without systemd (tests)
install -d -m 700 "$ETC"
printf 'TAILSCALE_IP=%s\nTAILNET_CLIENTS=%s\n' "$TAILSCALE_IP" "$TAILNET_CLIENTS" > "$ETC/install.env"

say "1. packages"
# The cluster the package creates gets this locale (else the shell's, which may be anything).
install -d -m 755 /etc/postgresql-common/createcluster.d
initdb="--locale=C.UTF-8 --encoding=UTF8"
[ "$PGMAJOR" -ge 17 ] && initdb="--locale-provider=builtin --builtin-locale=C.UTF-8 $initdb"
printf "# written by ops/postgres/install.sh\ninitdb_options = '%s'\n" "$initdb" > /etc/postgresql-common/createcluster.d/50-chessmoments.conf
if ! ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
  apt-get update -q
  LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive apt-get install -y -q "postgresql-$PGMAJOR"
fi
PGVER=${PGVER:-$(ls /usr/lib/postgresql | sort -V | tail -1)}
CONF=/etc/postgresql/$PGVER/$CLUSTER
if ! pg_lsclusters -h "$PGVER" "$CLUSTER" >/dev/null 2>&1; then
  LC_ALL=C.UTF-8 pg_createcluster "$PGVER" "$CLUSTER" ${PGPORT:+--port "$PGPORT"}
fi
PORT=$(pg_conftool -s "$PGVER" "$CLUSTER" show port)
echo "PostgreSQL $PGVER, cluster $CLUSTER, port $PORT"
psql_su() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PORT" "$@"; }
wait_ready() {
  for _ in $(seq 1 30); do pg_isready -q -p "$PORT" && return 0; sleep 1; done
  die "PostgreSQL did not come up: journalctl -u postgresql@$PGVER-$CLUSTER"
}

say "2. configuration"
install -d -m 755 -o postgres -g postgres "$CONF/conf.d"
install -m 644 -o postgres -g postgres "$HERE/postgresql.conf" "$CONF/conf.d/50-chessmoments.conf"
listen=localhost
[ -n "$TAILSCALE_IP" ] && listen="localhost,$TAILSCALE_IP"
printf "# written by ops/postgres/install.sh\nlisten_addresses = '%s'\n" "$listen" > "$CONF/conf.d/60-listen.conf"
# The conf.d files are the only configuration: no ALTER SYSTEM overrides (PostgreSQL 17+).
if [ "${PGVER%%.*}" -ge 17 ]; then printf "# written by ops/postgres/install.sh\nallow_alter_system = off\n" > "$CONF/conf.d/55-no-alter-system.conf"; fi
chown postgres:postgres "$CONF"/conf.d/*.conf
for f in pg_hba.conf pg_ident.conf; do
  [ -f "$CONF/$f.orig" ] || cp -p "$CONF/$f" "$CONF/$f.orig"
done
tailnet='# (no Tailscale access: run install.sh with TAILSCALE_IP=... to allow cm_owner from the Mac mini)'
if [ -n "$TAILSCALE_IP" ]; then
  tailnet='# The owner role from named tailnet machines (imports and psql from the Mac mini), TLS + password.'
  for c in $TAILNET_CLIENTS; do
    tailnet+=$(printf '\nhostssl cm_games        cm_owner        %-23s scram-sha-256' "$c/32")
  done
fi
awk -v t="$tailnet" '{ if ($0 == "@TAILNET@") print t; else print }' "$HERE/pg_hba.conf" > "$CONF/pg_hba.conf.new"
install -m 640 -o postgres -g postgres "$CONF/pg_hba.conf.new" "$CONF/pg_hba.conf"
rm -f "$CONF/pg_hba.conf.new"
# root runs imports and maintenance as cm_owner over the local socket (peer authentication, map "cm").
printf '# written by ops/postgres/install.sh\n# MAPNAME  SYSTEM-USERNAME  PG-USERNAME\ncm         root             cm_owner\n' > "$CONF/pg_ident.conf"
chown postgres:postgres "$CONF/pg_ident.conf"; chmod 640 "$CONF/pg_ident.conf"
if [ -n "$TAILSCALE_IP" ]; then
  # Postgres may start before tailscaled brings 100.x up; allow binding to it anyway.
  # (Ordering Postgres after tailscale-online.target instead could keep the database down for good when
  # Tailscale can't connect.)
  printf '# written by ops/postgres/install.sh: Postgres listens on the Tailscale IP\nnet.ipv4.ip_nonlocal_bind = 1\n' > /etc/sysctl.d/60-cm-db.conf
  sysctl -q -p /etc/sysctl.d/60-cm-db.conf
fi

say "3. systemd drop-in, (re)start"
# A reload applies most settings without dropping connections; a restart (a few seconds of errors for the
# site) happens only when the drop-in changed or a setting needs it (listen_addresses, shared_buffers, ...).
unit=postgresql@$PGVER-$CLUSTER
restart() {
  echo "restarting PostgreSQL ($1): connections drop for a few seconds"
  if systemd; then systemctl restart "$unit"; else pg_ctlcluster "$PGVER" "$CLUSTER" restart; fi
  wait_ready
}
if systemd; then
  dropin=/etc/systemd/system/postgresql@.service.d/50-chessmoments.conf
  changed=0; cmp -s "$HERE/postgresql.service.d.conf" "$dropin" || changed=1
  install -d -m 755 "$(dirname "$dropin")" /etc/systemd/system/system-postgresql.slice.d
  install -m 644 "$HERE/postgresql.service.d.conf" "$dropin"
  install -m 644 "$HERE/postgresql-slice.conf" /etc/systemd/system/system-postgresql.slice.d/50-chessmoments.conf
  systemctl daemon-reload
  systemctl enable -q "$unit"
  if ! systemctl is-active -q "$unit"; then systemctl start "$unit"; wait_ready
  elif [ "$changed" = 1 ]; then restart "the systemd drop-in changed"
  else systemctl reload "$unit"; wait_ready
  fi
else
  echo "(no systemd: pg_ctlcluster)"
  pg_ctlcluster "$PGVER" "$CLUSTER" reload 2>/dev/null || pg_ctlcluster "$PGVER" "$CLUSTER" start
  wait_ready
fi
sleep 2   # the reload is asynchronous
pending=$(psql_su -d postgres -Atc "SELECT string_agg(name, ', ' ORDER BY name) FROM pg_settings WHERE pending_restart")
[ -z "$pending" ] || restart "needed for $pending"
if systemd; then
  slice=$(systemctl show -p Slice --value "$unit")
  [ "$slice" = system-postgresql.slice ] || echo "warning: $unit runs in $slice, not system-postgresql.slice: its CPU weight doesn't apply"
fi
# Nothing may listen beyond localhost and the Tailscale IP.
if command -v ss >/dev/null; then
  bad=$(ss -Hltn "sport = :$PORT" | awk '{print $4}' | grep -vE "^(127\.0\.0\.1|\[::1\]|${TAILSCALE_IP:-none}):$PORT$" || true)
  [ -z "$bad" ] || die "PostgreSQL listens on $bad: fix listen_addresses before going on"
fi

say "4. roles and database"
for role in cm_owner cm_web; do
  if [ ! -s "$ETC/$role.password" ]; then
    # With a newline, so `sudo cat` doesn't run the prompt into it (reading it back with $(cat) drops it).
    (umask 077; printf '%s\n' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)" > "$ETC/$role.password")
  fi
  chmod 600 "$ETC/$role.password"
done
# Passwords go in through stdin (never on a command line); they are alphanumeric, so quoting is safe.
{
  # Nothing of this session reaches the log, not even a failing statement (it holds passwords).
  echo "SET log_statement = 'none'; SET log_min_duration_statement = -1; SET log_min_error_statement = panic;"
  for role in cm_owner cm_web; do
    pw=$(cat "$ETC/$role.password")
    echo "SELECT format('CREATE ROLE %I LOGIN', '$role') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$role') \\gexec"
    echo "ALTER ROLE $role WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$pw';"
  done
  # The site's role: bounded connections (Hyperdrive's origin limit of 20 is a soft cap) and runaway protection.
  echo "ALTER ROLE cm_web CONNECTION LIMIT 40;"
  echo "ALTER ROLE cm_web SET statement_timeout = '30s';"
  echo "ALTER ROLE cm_web SET lock_timeout = '20s';"
  echo "ALTER ROLE cm_web SET idle_in_transaction_session_timeout = '60s';"
  # Imports send megabytes of game data per statement: keep them out of the slow-query and error log
  # (adm-readable; TWIC data must not end up in bulk anywhere but the database and the private backups).
  echo "ALTER ROLE cm_owner SET log_min_duration_statement = -1;"
  echo "ALTER ROLE cm_owner SET log_min_error_statement = panic;"
  # Explicit encoding and locale (C.UTF-8 from the builtin provider, as on Neon), whatever the cluster default is.
  provider=; [ "${PGVER%%.*}" -ge 17 ] && provider="LOCALE_PROVIDER builtin BUILTIN_LOCALE ''C.UTF-8'' "
  echo "SELECT 'CREATE DATABASE $DB OWNER cm_owner TEMPLATE template0 ENCODING ''UTF8'' ${provider}LOCALE ''C.UTF-8''' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB') \\gexec"
  echo "REVOKE ALL ON DATABASE $DB FROM PUBLIC;"
  echo "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO cm_owner;"
  echo "GRANT CONNECT ON DATABASE $DB TO cm_web;"
} | psql_su -d postgres
psql_su -d "$DB" <<'SQL'
ALTER SCHEMA public OWNER TO cm_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- pg_trgm is a trusted extension: created as cm_owner, it belongs to cm_owner like everything restored later.
SET ROLE cm_owner;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

say "5. grants"
if [ "$(psql_su -d "$DB" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('games', 'uploads', 'game_analysis')")" = 3 ]; then
  # On stdin: the postgres user can't read the kit in a home directory (0750).
  psql_su -d "$DB" -c "SET ROLE cm_owner" -f - < "$KIT/scripts/db/grants.sql"
  echo "applied scripts/db/grants.sql"
else
  echo "no tables yet: migrate-from-neon.sh applies the grants after the restore"
fi

say "6. backups, health checks, restore drill"
install -d -m 700 "$BACKUP_DIR"
install -m 755 "$HERE/backup.sh" /usr/local/sbin/cm-db-backup
install -m 755 "$HERE/check.sh" /usr/local/sbin/cm-db-check
install -m 755 "$HERE/restore.sh" /usr/local/sbin/cm-db-restore
install -D -m 644 "$KIT/scripts/db/grants.sql" "$LIB/grants.sql"
[ -f "$ETC/backup.env" ] || install -m 600 "$HERE/backup.env.example" "$ETC/backup.env"
if systemd; then
  for u in cm-db-backup.service cm-db-backup.timer cm-db-backup-small.service cm-db-backup-small.timer \
           cm-db-check.service cm-db-check.timer cm-db-restore-test.service cm-db-restore-test.timer; do
    install -m 644 "$HERE/systemd/$u" "/etc/systemd/system/$u"
  done
  systemctl daemon-reload
  systemctl enable -q --now cm-db-backup.timer cm-db-backup-small.timer cm-db-check.timer cm-db-restore-test.timer
fi

say "done"
cat <<EOF
PostgreSQL $PGVER listens on: $listen (port $PORT).
Passwords (root only): $ETC/cm_owner.password, $ETC/cm_web.password. Show one with: sudo cat $ETC/cm_web.password
Next (README.md step 2): put the Neon connection string in $ETC/neon.env, then run
  sudo bash $HERE/migrate-from-neon.sh
EOF
