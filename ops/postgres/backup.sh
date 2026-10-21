#!/usr/bin/env bash
# Back up the chessmoments.com database (installed as /usr/local/sbin/cm-db-backup by install.sh).
#   cm-db-backup full    nightly: the whole database (pg_dump custom format), 7 daily + 5 weekly kept
#   cm-db-backup small   every 6 hours: only what can't be rebuilt from TWIC (engine analyses, AI notes,
#                        organisers' uploads), 28 kept
# Dumps are private (TWIC data may not be republished in bulk): root only, or BACKUP_GROUP read-only.
# Each dump is checked with pg_restore --list before it replaces anything; the time of the last good
# one is written to last-<mode>, which cm-db-check watches. Restore: see ops/postgres/README.md.
set -euo pipefail
MODE=${1:-full}
DB=${DB:-cm_games}
DIR=${BACKUP_DIR:-/var/backups/cm-db}
[ -f /etc/cm-db/backup.env ] && . /etc/cm-db/backup.env
BACKUP_GROUP=${BACKUP_GROUP:-}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
umask 077

case $MODE in
  full) sub=daily; keep=7; tables=() ;;
  small) sub=small; keep=28; tables=(-t game_analysis -t game_annotation -t uploads -t upload_rounds -t uploads_id_seq) ;;
  *) echo "usage: $0 full|small" >&2; exit 2 ;;
esac
install -d -m 750 "$DIR" "$DIR/$sub" "$DIR/weekly"
stamp=$(date -u +%Y-%m-%dT%H%MZ)
out=$DIR/$sub/$DB-$MODE-$stamp.dump

# pg_dump runs as postgres (peer authentication); the file is written by root.
runuser -u postgres -- pg_dump -Fc -Z 6 "${tables[@]}" -d "$DB" > "$out.part"
pg_restore --list "$out.part" > /dev/null   # unreadable dump: fail before replacing anything (needs no database)
mv "$out.part" "$out"
if [ -n "$BACKUP_GROUP" ]; then chgrp "$BACKUP_GROUP" "$DIR" "$DIR/$sub" "$DIR/weekly" "$out"; chmod 640 "$out"; fi

# Rotation: newest $keep in $sub; on Sundays the full dump is also kept as a weekly one (5 kept).
ls -1t "$DIR/$sub"/*.dump | tail -n +$((keep + 1)) | xargs -r rm -f
if [ "$MODE" = full ] && [ "$(date -u +%u)" = 7 ]; then
  ln -f "$out" "$DIR/weekly/$(basename "$out")"
  ls -1t "$DIR/weekly"/*.dump | tail -n +6 | xargs -r rm -f
fi

if [ -n "$RCLONE_REMOTE" ]; then
  rclone --config /etc/cm-db/rclone.conf copy "$out" "$RCLONE_REMOTE/$sub/" --s3-no-check-bucket
fi

size=$(stat -c %s "$out")
printf '%s %s %s\n' "$(date -u +%s)" "$size" "$out" > "$DIR/last-$MODE"
echo "backup $MODE ok: $out ($((size / 1024 / 1024)) MB)"
