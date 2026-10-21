#!/usr/bin/env bash
# Health check for the chessmoments.com database (installed as /usr/local/sbin/cm-db-check; timer every
# 15 minutes). Fails (non-zero, logged to the journal) when Postgres is down, the last full backup is
# older than 30 hours (small: 8 hours), the disk is more than 85% full, or the tunnel is not running.
# With HC_URL set in /etc/cm-db/backup.env it also pings a dead-man's switch (healthchecks.io etc.), so
# a silent failure becomes an e-mail: success pings HC_URL, failure HC_URL/fail with the reasons.
set -uo pipefail
DIR=${BACKUP_DIR:-/var/backups/cm-db}
[ -f /etc/cm-db/backup.env ] && . /etc/cm-db/backup.env
HC_URL=${HC_URL:-}
problems=()

pg_isready -q || problems+=("postgres is not accepting connections")
now=$(date -u +%s)
for mode in full:108000 small:28800; do
  m=${mode%%:*} max=${mode##*:}
  last=$(cut -d' ' -f1 "$DIR/last-$m" 2>/dev/null || echo 0)
  [ $((now - last)) -le "$max" ] || problems+=("last $m backup is $(((now - last) / 3600)) h old")
done
used=$(df -P /var/lib/postgresql | awk 'NR == 2 { sub("%", "", $5); print $5 }')
[ "$used" -le 85 ] || problems+=("disk ${used}% full")
if [ -d /run/systemd/system ] && systemctl list-unit-files cloudflared-cm-db.service >/dev/null 2>&1; then
  systemctl is-active -q cloudflared-cm-db.service || problems+=("cloudflared-cm-db is not running")
fi

if [ ${#problems[@]} -eq 0 ]; then
  [ -n "$HC_URL" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$HC_URL"
  echo "ok"
  exit 0
fi
msg=$(printf '%s; ' "${problems[@]}")
[ -n "$HC_URL" ] && curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$msg" "$HC_URL/fail"
echo "PROBLEM: $msg" >&2
exit 1
