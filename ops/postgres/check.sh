#!/usr/bin/env bash
# Health check for the chessmoments.com database (installed as /usr/local/sbin/cm-db-check; timer every
# 15 minutes). Fails (non-zero, logged to the journal) when Postgres is down or cm_web can't log in the way
# Hyperdrive does; the last full backup is older than 30 hours or the last small one older than 3 (the same for
# the off-site copy when RCLONE_REMOTE is set); the disk is more than 85% full or has less than 5 GB free; the
# tunnel has no connection to Cloudflare; SITE_CHECK_URL (the site's own way to the database) fails; the
# monthly restore drill failed; the kernel killed a process for memory since the last check; or memory
# pressure stays high. With HC_URL set in /etc/cm-db/backup.env it also pings a dead-man's switch
# (healthchecks.io etc.), so a silent failure becomes an e-mail: success pings HC_URL, failure HC_URL/fail
# with the reasons.
set -uo pipefail
DIR=${BACKUP_DIR:-/var/backups/cm-db}
[ -f /etc/cm-db/backup.env ] && . /etc/cm-db/backup.env
HC_URL=${HC_URL:-}
problems=()

# (As cm_owner, which root may be over the socket: another user would leave a FATAL line in the log every time.)
if ! pg_isready -q -U cm_owner -d cm_games; then problems+=("postgres is not accepting connections")
# Log in the way Hyperdrive does: cm_web, over TCP to 127.0.0.1, with TLS (the password from the file, via the
# environment, never on a command line).
elif [ -s /etc/cm-db/cm_web.password ] \
  && ! PGPASSWORD=$(cat /etc/cm-db/cm_web.password) psql -X -q -At -c 'SELECT 1' \
       "host=127.0.0.1 dbname=cm_games user=cm_web sslmode=require connect_timeout=10" >/dev/null 2>&1; then
  problems+=("cm_web cannot log in over TLS on 127.0.0.1 (as Hyperdrive does)")
fi
now=$(date -u +%s)
RCLONE_REMOTE=${RCLONE_REMOTE:-}
for mode in full:108000 small:10800; do
  m=${mode%%:*} max=${mode##*:}
  last=$(cut -d' ' -f1 "$DIR/last-$m" 2>/dev/null || echo 0)
  [ $((now - last)) -le "$max" ] || problems+=("last $m backup is $(((now - last) / 3600)) h old")
  if [ -n "$RCLONE_REMOTE" ]; then
    unit=cm-db-backup; [ "$m" = full ] || unit=cm-db-backup-small
    if [ ! -s "$DIR/last-offsite-$m" ]; then problems+=("no off-site copy of a $m backup yet: journalctl -u $unit")
    else
      last=$(cut -d' ' -f1 "$DIR/last-offsite-$m")
      [ $((now - last)) -le "$max" ] || problems+=("last off-site copy of a $m backup is $(((now - last) / 3600)) h old: journalctl -u $unit")
    fi
  fi
done
read -r used avail_kb < <(df -P -k /var/lib/postgresql | awk 'NR == 2 { sub("%", "", $5); print $5, $4 }')
[ "$used" -le 85 ] || problems+=("disk ${used}% full")
[ "$avail_kb" -ge 5242880 ] || problems+=("only $((avail_kb / 1048576)) GB free on disk")
if [ -d /run/systemd/system ]; then
  if systemctl list-unit-files cloudflared-cm-db.service >/dev/null 2>&1; then
    if ! systemctl is-active -q cloudflared-cm-db.service; then problems+=("cloudflared-cm-db is not running")
    # /ready answers 200 only while at least one connection to Cloudflare is up.
    elif ! curl -fsS -m 5 -o /dev/null http://127.0.0.1:20299/ready; then problems+=("the tunnel has no connection to Cloudflare")
    fi
  fi
  ! systemctl is-failed -q cm-db-restore-test.service \
    || problems+=("the restore drill failed: journalctl -u cm-db-restore-test; once fixed, sudo systemctl start cm-db-restore-test")
fi
# OOM kills since the last check (the counter starts at 0 on boot, like /run).
oom=$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)
if [ -n "$oom" ]; then
  last_oom=$(cat /run/cm-db-check.oom 2>/dev/null || echo "$oom")
  echo "$oom" > /run/cm-db-check.oom
  [ "$oom" -le "$last_oom" ] || problems+=("the kernel killed $((oom - last_oom)) process(es) for memory: journalctl -k | grep -i oom")
fi
# The whole way the site goes (Worker, Hyperdrive, tunnel, Postgres), once the site reads this database.
# While the site is in maintenance on purpose (MAINTENANCE "1"), /health/db says so: not an alarm.
SITE_CHECK_URL=${SITE_CHECK_URL:-}
if [ -n "$SITE_CHECK_URL" ]; then
  case $(curl -sS -m 30 "$SITE_CHECK_URL" 2>/dev/null || true) in
    *'"ok":true'*) ;;
    *'"maintenance":true'*) echo "note: the site's database routes are closed for maintenance" ;;
    *) problems+=("the site can't reach the database ($SITE_CHECK_URL)") ;;
  esac
fi
# Time stalled on memory over 5 minutes (all tasks at once): above 10 % the box is short of RAM.
psi=$(awk '$1 == "full" { sub("avg300=", "", $4); print int($4) }' /proc/pressure/memory 2>/dev/null || echo 0)
[ "${psi:-0}" -lt 10 ] || problems+=("memory pressure ${psi}% (5 min)")

# The ping URL is a secret of sorts: to curl through its config on stdin, not on the command line.
ping() {
  local url=${1//\\/\\\\}   # backslashes and quotes escaped for curl's config syntax
  url=${url//\"/\\\"}
  printf 'url = "%s"\n' "$url" | curl -fsS -m 10 --retry 3 -o /dev/null -K - "${@:2}"
}
if [ ${#problems[@]} -eq 0 ]; then
  [ -z "$HC_URL" ] || ping "$HC_URL"
  echo "ok"
  exit 0
fi
msg=$(printf '%s; ' "${problems[@]}")
[ -z "$HC_URL" ] || ping "$HC_URL/fail" --data-raw "$msg"
echo "PROBLEM: $msg" >&2
exit 1
