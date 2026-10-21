#!/usr/bin/env bash
# Back up the chessmoments.com database (installed as /usr/local/sbin/cm-db-backup by install.sh).
#   cm-db-backup full    nightly: the whole database (pg_dump custom format, zstd), 7 daily + 5 weekly kept
#   cm-db-backup small   hourly: only what can't be rebuilt from TWIC (engine analyses, AI notes,
#                        organisers' uploads), 7 days kept
# Dumps are private (TWIC data may not be republished in bulk): root only, or BACKUP_GROUP read-only.
# Each dump is read back in full before it replaces anything (pg_restore --list alone passes truncated
# or damaged dumps); the time of the last good one is written to last-<mode>, which cm-db-check watches.
# Restore: see ops/postgres/README.md.
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
  # --strict-names: a missing (renamed) table fails the dump instead of silently dropping out of it.
  small) sub=small; keep=168; tables=(--strict-names -t game_analysis -t game_annotation -t uploads -t upload_rounds -t uploads_id_seq) ;;
  *) echo "usage: $0 full|small" >&2; exit 2 ;;
esac
install -d -m 750 "$DIR" "$DIR/$sub" "$DIR/weekly"
stamp=$(date -u +%Y-%m-%dT%H%MZ)
out=$DIR/$sub/$DB-$MODE-$stamp.dump
# A failed dump leaves nothing behind (and leftovers of a killed run go after half a day).
trap 'rm -f "$out.part"' EXIT
find "$DIR" -name '*.part' -mmin +720 -delete

# pg_dump runs as postgres (peer authentication); the file is written by root.
# Behind a long lock (a TWIC --reset), fail after 5 minutes rather than queue the site's reads behind us.
runuser -u postgres -- pg_dump -Fc -Z zstd:3 --lock-wait-timeout=5min "${tables[@]}" -d "$DB" > "$out.part"
pg_restore -f /dev/null "$out.part"   # read every byte back: fail before replacing anything (needs no database)
mv "$out.part" "$out"

# Rotation: newest $keep in $sub; on Sundays the full dump is also kept as a weekly one (5 kept).
ls -1t "$DIR/$sub"/*.dump | tail -n +$((keep + 1)) | xargs -r rm -f
if [ "$MODE" = full ] && [ "$(date -u +%u)" = 7 ]; then
  ln -f "$out" "$DIR/weekly/$(basename "$out")"
  ls -1t "$DIR/weekly"/*.dump | tail -n +6 | xargs -r rm -f
fi

size=$(stat -c %s "$out")
printf '%s %s %s\n' "$(date -u +%s)" "$size" "$out" > "$DIR/last-$MODE"
# BACKUP_GROUP reads every finished file (also dumps made before it was set); partial .part files stay root's.
if [ -n "$BACKUP_GROUP" ]; then
  chgrp -R "$BACKUP_GROUP" "$DIR"
  find "$DIR" -type d -exec chmod 750 {} +
  find "$DIR" -type f ! -name '*.part' -exec chmod 640 {} +
fi
echo "backup $MODE ok: $out ($((size / 1024 / 1024)) MB)"

if [ -n "$RCLONE_REMOTE" ]; then
  # The same retention off-site, pruned only after this dump is up (a dead box never empties the bucket).
  # last-offsite-<mode> is watched separately, so a failed upload doesn't look like a failed backup.
  rc=(rclone --config /etc/cm-db/rclone.conf --s3-no-check-bucket)
  "${rc[@]}" copy "$out" "$RCLONE_REMOTE/$sub/"
  "${rc[@]}" delete --min-age 180h "$RCLONE_REMOTE/$sub/"            # 7.5 days: 7 daily or a week of hourly
  if [ "$MODE" = full ] && [ "$(date -u +%u)" = 7 ]; then
    "${rc[@]}" copyto "$RCLONE_REMOTE/$sub/$(basename "$out")" "$RCLONE_REMOTE/weekly/$(basename "$out")"   # server-side
    "${rc[@]}" delete --min-age 864h "$RCLONE_REMOTE/weekly/"       # 36 days: 5 weekly
  fi
  printf '%s %s %s\n' "$(date -u +%s)" "$size" "$RCLONE_REMOTE/$sub/$(basename "$out")" > "$DIR/last-offsite-$MODE"
  [ -z "$BACKUP_GROUP" ] || { chgrp "$BACKUP_GROUP" "$DIR/last-offsite-$MODE"; chmod 640 "$DIR/last-offsite-$MODE"; }
  echo "copied to $RCLONE_REMOTE/$sub/"
fi
