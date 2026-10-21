#!/usr/bin/env bash
# Health check for the chessmoments.com database (installed as /usr/local/sbin/cm-db-check; timer every
# 15 minutes). Fails (non-zero, logged to the journal) when Postgres is down, the last full backup is
# older than 30 hours (small: 3 hours), the disk is more than 85% full or has less than 5 GB free, the
# tunnel has no connection to Cloudflare, the monthly restore drill failed, the kernel killed a process
# for memory since the last check, or memory pressure stays high.
# With HC_URL set in /etc/cm-db/backup.env it also pings a dead-man's switch (healthchecks.io etc.), so
# a silent failure becomes an e-mail: success pings HC_URL, failure HC_URL/fail with the reasons.
set -uo pipefail
DIR=${BACKUP_DIR:-/var/backups/cm-db}
[ -f /etc/cm-db/backup.env ] && . /etc/cm-db/backup.env
HC_URL=${HC_URL:-}
problems=()

pg_isready -q || problems+=("postgres is not accepting connections")
now=$(date -u +%s)
for mode in full:108000 small:10800; do
  m=${mode%%:*} max=${mode##*:}
  last=$(cut -d' ' -f1 "$DIR/last-$m" 2>/dev/null || echo 0)
  [ $((now - last)) -le "$max" ] || problems+=("last $m backup is $(((now - last) / 3600)) h old")
done
read -r used avail_kb < <(df -P -k /var/lib/postgresql | awk 'NR == 2 { sub("%", "", $5); print $5, $4 }')
[ "$used" -le 85 ] || problems+=("disk ${used}% full")
[ "$avail_kb" -ge 5242880 ] || problems+=("only $((avail_kb / 1048576)) GB free on disk")
if [ -d /run/systemd/system ]; then
  if systemctl list-unit-files cloudflared-cm-db.service >/dev/null 2>&1; then
    if ! systemctl is-active -q cloudflared-cm-db.service; then problems+=("cloudflared-cm-db is not running")
    # /ready answers 200 only while at least one connection to Cloudflare is up.
    elif ! curl -fsS -m 5 -o /dev/null http://127.0.0.1:20241/ready; then problems+=("the tunnel has no connection to Cloudflare")
    fi
  fi
  ! systemctl is-failed -q cm-db-restore-test.service || problems+=("the restore drill failed: journalctl -u cm-db-restore-test")
fi
# OOM kills since the last check (the counter starts at 0 on boot, like /run).
oom=$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)
if [ -n "$oom" ]; then
  last_oom=$(cat /run/cm-db-check.oom 2>/dev/null || echo "$oom")
  echo "$oom" > /run/cm-db-check.oom
  [ "$oom" -le "$last_oom" ] || problems+=("the kernel killed $((oom - last_oom)) process(es) for memory: journalctl -k | grep -i oom")
fi
# Time stalled on memory over 5 minutes (all tasks at once): above 10 % the box is short of RAM.
psi=$(awk '$1 == "full" { sub("avg300=", "", $4); print int($4) }' /proc/pressure/memory 2>/dev/null || echo 0)
[ "${psi:-0}" -lt 10 ] || problems+=("memory pressure ${psi}% (5 min)")

if [ ${#problems[@]} -eq 0 ]; then
  [ -n "$HC_URL" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$HC_URL"
  echo "ok"
  exit 0
fi
msg=$(printf '%s; ' "${problems[@]}")
[ -n "$HC_URL" ] && curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$msg" "$HC_URL/fail"
echo "PROBLEM: $msg" >&2
exit 1
