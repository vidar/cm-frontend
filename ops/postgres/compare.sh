#!/usr/bin/env bash
# Compare two copies of the chessmoments.com database table by table: row counts, content checksums
# (md5 over every row in key order, in buckets for the big tables), sequence values, extensions and
# indexes. Exit 0 only when everything matches.
#
#   compare.sh <source> <target>     each a libpq connection: a postgresql:// URL, "service=neon", or
#                                    "dbname=cm_games" (the local socket, as the user running it)
#
# Used by migrate-from-neon.sh (Neon vs the restored copy). Read-only on both sides.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <source-conninfo> <target-conninfo>" >&2; exit 2; }
SRC=$1 DST=$2

# Session settings that fix how values are printed, so both servers produce identical text.
SET="SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1; SET bytea_output = 'hex';"
checksum() { # table, key expression, bucket expression
  echo "SELECT '$1' AS tbl, $3 AS bucket, count(*) AS n, md5(string_agg(md5(t::text), '' ORDER BY $2)) AS md5 FROM public.$1 t GROUP BY 2 ORDER BY 2;"
}
SQL="$SET
$(checksum games id 'id / 500000')
$(checksum players id 'id / 500000')
$(checksum events id 0)
$(checksum event_redirects slug 0)
$(checksum openings slug 0)
$(checksum meta key 0)
$(checksum game_analysis game_id 0)
$(checksum game_annotation game_id 0)
$(checksum uploads id 0)
$(checksum upload_rounds 'upload_id, round' 0)
SELECT 'seq uploads_id_seq', 0, last_value, is_called::text FROM public.uploads_id_seq;
SELECT 'extension pg_trgm', 0, count(*), '' FROM pg_extension WHERE extname = 'pg_trgm';
SELECT 'database', 0, 0, pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || datctype FROM pg_database WHERE datname = current_database();
SELECT 'indexes', 0, count(*), md5(string_agg(indexdef, ';' ORDER BY indexname)) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'constraints', 0, count(*), md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname)) FROM pg_constraint WHERE connamespace = 'public'::regnamespace;"

run() { psql -X -q -At -F ' | ' -v ON_ERROR_STOP=1 -d "$1" -f - <<< "$SQL"; }
a=$(mktemp) b=$(mktemp)
trap 'rm -f "$a" "$b"' EXIT
echo "reading the source..."; run "$SRC" > "$a"
echo "reading the target..."; run "$DST" > "$b"
if diff -u --label source --label target "$a" "$b"; then
  echo
  awk -F' \\| ' '{ printf "  %-20s %-3s %12s  %s\n", $1, $2, $3, $4 }' "$a"
  echo "ALL OK: the copies are identical."
else
  echo "MISMATCH: see the diff above (- source, + target)." >&2
  exit 1
fi
