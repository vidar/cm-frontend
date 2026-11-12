#!/usr/bin/env bash
# Creates a test database for the *-db tests from the repository's own schema scripts, as CI does
# (.github/workflows/test.yml): roles cm_owner (owns everything) and cm_web (the site's role, with exactly the rights
# in scripts/db/grants.sql, which the tests then run as), the schema applied twice (the scripts must stay idempotent:
# ops/postgres/install.sh reruns them on every kit update) and the few rows of tests/fixtures/ci-seed.pg.sql.
# Connects as a superuser through the usual PG* variables. Prints the TEST_DATABASE_URL to use.
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash tests/fixtures/create-test-db.sh cm_games_test
set -euo pipefail
db=${1:-cm_games_test}
root=$(cd "$(dirname "$0")/../.." && pwd)
run() { PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 "$@"; }

run -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cm_owner') THEN CREATE ROLE cm_owner LOGIN PASSWORD 'cm_owner'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cm_web') THEN CREATE ROLE cm_web LOGIN PASSWORD 'cm_web'; END IF;
END $$;
SQL
run -d postgres -c "CREATE DATABASE \"$db\" OWNER cm_owner"
for pass in 1 2; do
  for f in scripts/twic/schema.pg.sql scripts/twic/indexes.pg.sql scripts/analysis.pg.sql scripts/annotation.pg.sql scripts/uploads.pg.sql scripts/db/grants.sql; do
    run -d "$db" -c 'SET ROLE cm_owner' -f "$root/$f"
  done
done
run -d "$db" -c 'SET ROLE cm_owner' -f "$root/tests/fixtures/ci-seed.pg.sql"
echo "TEST_DATABASE_URL=postgres://cm_web:cm_web@${PGHOST:-localhost}:${PGPORT:-5432}/$db"
