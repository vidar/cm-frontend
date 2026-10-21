-- Rights of the site's database role cm_web (Hyperdrive connects as it). Least privilege, derived from
-- the statements in src/lib: read everything; write only what analysis, AI notes and tournament uploads
-- write. Idempotent; applied by ops/postgres/install.sh, migrate-from-neon.sh and the TWIC importer
-- (scripts/twic/import_pg.py, after a --reset recreates the tables). Tables are owned by cm_owner.
-- Add a line here whenever the app starts writing to another table.

GRANT USAGE ON SCHEMA public TO cm_web;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cm_web;

-- Engine analysis (src/lib/analysis.ts) and AI notes (src/lib/annotate.ts); uploads delete both for
-- games they take down (src/lib/uploads.ts dropRounds).
GRANT INSERT, UPDATE, DELETE ON game_analysis, game_annotation TO cm_web;

-- Tournament uploads (src/lib/uploads.ts): the organisers' tables, and publishing into the site's tables
-- (games are only inserted and deleted; players and events are also updated).
GRANT INSERT, UPDATE, DELETE ON uploads, upload_rounds TO cm_web;
GRANT USAGE ON SEQUENCE uploads_id_seq TO cm_web;
GRANT INSERT, DELETE ON games TO cm_web;
GRANT INSERT, UPDATE, DELETE ON players, events TO cm_web;

-- Tables created later by cm_owner (imports) are readable by default; writes still need a line above.
ALTER DEFAULT PRIVILEGES FOR ROLE cm_owner IN SCHEMA public GRANT SELECT ON TABLES TO cm_web;
