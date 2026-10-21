#!/usr/bin/env python3
"""Load the TWIC SQLite build into the site's PostgreSQL database.

    # on the database server, as root (the owner role over the local socket, no password):
    sudo DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' \
      python3 scripts/twic/import_pg.py --db twic.sqlite [--reset] [--batch 4000]

DATABASE_URL is any PostgreSQL server, driven through the psql client (on the database server
itself, or over Tailscale: postgresql://cm_owner@<host>/cm_games?sslmode=require with the password in
~/.pgpass, never in the URL, where shell history and `ps` would keep it). NEON_DATABASE_URL instead
talks to Neon over its HTTPS SQL endpoint (no psql needed), for as long as the Neon project exists.
Use the owner role either way.

Resumable: each table is copied in id order and a rerun continues after the highest id already
in Postgres. --reset drops the tables first (do this for a full rebuild). Afterwards it creates
the indexes (indexes.pg.sql), ANALYZEs and applies the grants: on a server set up by ops/postgres
(role cm_web exists) scripts/db/grants.sql, the site role's rights; on Neon the read grant to its
role `readonly`; on a database without either (local development) none. --grants FILE or '' overrides.
Standard library only.

Uploaded tournaments (/upload/, ids from 100000000) are left alone, except by --reset, which drops
them from games/players/events: republish them afterwards from /upload/admin/. An uploaded event or
player whose slug TWIC now uses (the same tournament, or a namesake) is renamed to <slug>-u<n> first.

--patch updates a loaded database in place from a build processed by remap_events.py (same game
ids): it uploads `changed_games` and the events table into staging tables, then swaps them in with
one transaction, so the site never sees a half-updated database.
"""
import argparse
import csv
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
# table -> (key column, [(column, postgres array type)])
TABLES = {
    'openings': ('slug', [('slug', 'text'), ('name', 'text'), ('eco', 'text')]),
    'meta': ('key', [('key', 'text'), ('value', 'text')]),
    'events': ('id', [('id', 'int'), ('name', 'text'), ('site', 'text'), ('slug', 'text'), ('start_date', 'text'),
                      ('end_date', 'text'), ('games', 'int'), ('twic', 'int'), ('type', 'text'), ('rounds', 'int')]),
    'players': ('id', [('id', 'int'), ('fide_id', 'int'), ('name', 'text'), ('slug', 'text'), ('search', 'text'),
                       ('title', 'text'), ('fed', 'text'), ('born', 'int'), ('max_elo', 'int'), ('games', 'int'),
                       ('last_date', 'text')]),
    'event_redirects': ('slug', [('slug', 'text'), ('event_id', 'int')]),
    'changed_games': ('id', [('id', 'int'), ('event_id', 'int'), ('white_team', 'text'), ('black_team', 'text')]),
    'games': ('id', [('id', 'int'), ('event_id', 'int'), ('white_id', 'int'), ('black_id', 'int'), ('white_elo', 'int'),
                     ('black_elo', 'int'), ('white_title', 'text'), ('black_title', 'text'), ('elo_avg', 'int'),
                     ('result', 'text'), ('date', 'text'), ('round', 'text'), ('eco', 'text'), ('opening', 'text'),
                     ('plies', 'int'), ('twic', 'int'), ('moves', 'text'), ('white_team', 'text'), ('black_team', 'text')]),
}


def pg_array(values) -> str:
    """Postgres array literal, so a whole column travels as one query parameter."""
    def item(v):
        if v is None:
            return 'NULL'
        return '"' + str(v).replace('\\', '\\\\').replace('"', '\\"') + '"'
    return '{' + ','.join(item(v) for v in values) + '}'


class Neon:
    def __init__(self, url: str):
        host = urllib.parse.urlparse(url).hostname or ''
        self.endpoint = f'https://{host.replace("-pooler.", ".")}/sql'
        self.url = url

    def __call__(self, query: str, params=(), retries=6):
        body = json.dumps({'query': query, 'params': list(params)}).encode()
        for attempt in range(retries):
            req = urllib.request.Request(self.endpoint, data=body, method='POST', headers={
                'Content-Type': 'application/json', 'Neon-Connection-String': self.url, 'Neon-Raw-Text-Output': 'true'})
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                msg = e.read().decode(errors='replace')[:500]
                if e.code < 500 and e.code != 429:
                    sys.exit(f'Neon error {e.code}: {msg}')
                err = f'{e.code} {msg}'
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                err = str(e)
            wait = 2 ** attempt
            print(f'  retry in {wait}s ({err})', file=sys.stderr)
            time.sleep(wait)
        sys.exit('giving up')

    def transaction(self, queries):
        body = json.dumps({'queries': [{'query': q, 'params': []} for q in queries]}).encode()
        req = urllib.request.Request(self.endpoint, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'Neon-Connection-String': self.url, 'Neon-Raw-Text-Output': 'true',
            'Neon-Batch-Isolation-Level': 'ReadCommitted'})
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f'transaction failed (rolled back): {e.code} {e.read().decode(errors="replace")[:500]}')

    def script(self, path: Path):
        for stmt in re.sub(r'--[^\n]*', '', path.read_text()).split(';'):
            if stmt.strip():
                self(stmt)


# libpq environment variables for the parts of a postgresql:// URL (so the password never shows in `ps`).
URL_PARAMS = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
              'host': 'PGHOST', 'port': 'PGPORT', 'options': 'PGOPTIONS', 'connect_timeout': 'PGCONNECT_TIMEOUT'}


def libpq_env(url: str) -> dict:
    u = urllib.parse.urlparse(url)
    if u.scheme not in ('postgres', 'postgresql'):
        sys.exit('DATABASE_URL must be a postgresql:// URL')
    env = {}
    for var, value in (('PGHOST', u.hostname), ('PGPORT', u.port), ('PGUSER', u.username), ('PGPASSWORD', u.password),
                       ('PGDATABASE', u.path.lstrip('/'))):
        if value:
            env[var] = urllib.parse.unquote(str(value))
    for k, v in urllib.parse.parse_qsl(u.query):
        if k not in URL_PARAMS:
            sys.exit(f'DATABASE_URL: unsupported parameter {k!r}')
        env[URL_PARAMS[k]] = v
    return env


def literal(v) -> str:
    """An SQL literal for a parameter: numbers as they are, text dollar-quoted (no escaping to get wrong)."""
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    s, tag = str(v), 'q'
    while f'${tag}$' in s or s.endswith(f'${tag}'):
        tag += 'q'
    return f'${tag}${s}${tag}$'


class Psql:
    """Any PostgreSQL server, through the psql client: one psql run per call, $n parameters inlined
    as literals, results read back as CSV (text values, like the Neon endpoint's raw text output)."""

    def __init__(self, url: str):
        if not shutil.which('psql'):
            sys.exit('psql not found: apt install postgresql-client (or brew install libpq)')
        self.env = {**os.environ, **libpq_env(url), 'PGAPPNAME': 'twic-import'}

    def run(self, sql: str, single_transaction=False, retries=6) -> str:
        args = ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-f', '-']
        if single_transaction:
            args.insert(1, '--single-transaction')
        for attempt in range(retries):
            r = subprocess.run(args, input=sql, capture_output=True, text=True, env=self.env)
            if r.returncode == 0:
                return r.stdout
            # 2: the connection failed or broke (worth retrying); 3: an SQL error; 1: psql itself failed.
            if r.returncode != 2:
                what = 'transaction failed (rolled back)' if single_transaction else 'psql error'
                sys.exit(f'{what}: {r.stderr.strip()[:800]}')
            wait = 2 ** attempt
            print(f'  retry in {wait}s ({r.stderr.strip()[:200]})', file=sys.stderr)
            time.sleep(wait)
        sys.exit('giving up')

    def __call__(self, query: str, params=()):
        sql = re.sub(r'\$(\d+)', lambda m: literal(params[int(m.group(1)) - 1]), query)
        out = self.run(sql.rstrip().rstrip(';') + ';\n')
        return {'rows': list(csv.DictReader(io.StringIO(out))) if out.strip() else []}

    def transaction(self, queries):
        self.run(''.join(q.rstrip().rstrip(';') + ';\n' for q in queries), single_transaction=True)

    def script(self, path: Path):
        self.run(path.read_text())


Database = Neon | Psql


def copy_table(db: Database, src: sqlite3.Connection, table: str, batch: int, target: str | None = None):
    key, cols = TABLES[table]
    source, table = table, target or table
    names = ', '.join(c for c, _ in cols)
    total = src.execute(f'SELECT COUNT(*) FROM {source}').fetchone()[0]
    if key == 'id':
        # Uploaded tournaments (src/lib/uploads.ts) use ids from UPLOAD_ID_BASE up: resume below them.
        done = int(db(f'SELECT COALESCE(MAX(id), 0) AS m FROM {table} WHERE id < {UPLOAD_ID_BASE}')['rows'][0]['m'])
    else:
        done = None  # small key/value tables: upsert everything
    insert = (f'INSERT INTO {table} ({names}) SELECT * FROM unnest('
              + ', '.join(f'${i + 1}::{t}[]' for i, (_, t) in enumerate(cols))
              + f') ON CONFLICT ({key}) DO ' + ('NOTHING' if key == 'id' else
              'UPDATE SET ' + ', '.join(f'{c} = EXCLUDED.{c}' for c, _ in cols if c != key)))
    where, args = ('WHERE id > ?', [done]) if done is not None else ('', [])
    cur = src.execute(f'SELECT {names} FROM {source} {where} ORDER BY {key}', args)
    copied, t0 = 0, time.time()
    slug_at = next((i for i, (c, _) in enumerate(cols) if c == 'slug'), None)
    while rows := cur.fetchmany(batch):
        if table in ('events', 'players'):
            free_slugs(db, table, [r[slug_at] for r in rows])
        db(insert, [pg_array(col) for col in zip(*rows)])
        copied += len(rows)
        rate = copied / max(time.time() - t0, 1e-6)
        print(f'\r{table}: {copied + (done or 0):,}/{total:,} ({rate:,.0f} rows/s)', end='', flush=True)
    print(f'\r{table}: {total:,} rows' + ' ' * 30)


def free_slugs(db: Database, table: str, slugs):
    """Rename uploaded rows (ids from UPLOAD_ID_BASE) holding any of these slugs, which TWIC is about to use
    (slugs are UNIQUE, and ON CONFLICT (id) doesn't cover them)."""
    db(f"UPDATE {table} SET slug = slug || '-u' || (id - {UPLOAD_ID_BASE} + 1) WHERE id >= {UPLOAD_ID_BASE} AND slug = ANY($1::text[])",
         [pg_array(slugs)])


def patch(db: Database, src: sqlite3.Connection, batch: int):
    db('CREATE TABLE IF NOT EXISTS patch_games (id INTEGER PRIMARY KEY, event_id INTEGER, white_team TEXT, black_team TEXT)')
    db('CREATE TABLE IF NOT EXISTS patch_events (LIKE events INCLUDING ALL)')
    copy_table(db, src, 'changed_games', batch, 'patch_games')
    db('TRUNCATE patch_events')
    copy_table(db, src, 'events', batch, 'patch_events')
    print('swapping in…')
    t0 = time.time()
    db.transaction([
        'UPDATE games g SET event_id = p.event_id, white_team = p.white_team, black_team = p.black_team FROM patch_games p WHERE g.id = p.id',
        f'DELETE FROM events WHERE id < {UPLOAD_ID_BASE}',  # keep uploaded tournaments
        # ...but move an uploaded event off a slug the new TWIC events use
        f"UPDATE events SET slug = slug || '-u' || (id - {UPLOAD_ID_BASE} + 1) WHERE id >= {UPLOAD_ID_BASE} AND slug IN (SELECT slug FROM patch_events)",
        'INSERT INTO events SELECT * FROM patch_events',
        'DROP TABLE patch_games, patch_events',
    ])
    print(f'swapped in {time.time() - t0:.0f}s')
    for table in ('openings', 'meta', 'event_redirects'):
        copy_table(db, src, table, batch)


UPLOAD_ID_BASE = 100_000_000  # src/lib/uploads.ts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True, help='SQLite file from build.py')
    ap.add_argument('--batch', type=int, default=4000, help='rows per INSERT')
    ap.add_argument('--reset', action='store_true', help='drop and recreate the tables first')
    ap.add_argument('--grants', default=None, help="SQL file with the site role's rights ('' to skip; default: see above)")
    ap.add_argument('--patch', action='store_true', help='update events and changed games in place (see remap_events.py)')
    a = ap.parse_args()
    if os.environ.get('DATABASE_URL'):
        db = Psql(os.environ['DATABASE_URL'])
    elif os.environ.get('NEON_DATABASE_URL'):
        db = Neon(os.environ['NEON_DATABASE_URL'])
    else:
        sys.exit('set DATABASE_URL (PostgreSQL, through psql) or NEON_DATABASE_URL (Neon over HTTPS)')
    src = sqlite3.connect(a.db)
    grants = a.grants
    if grants is None and isinstance(db, Psql):
        if db("SELECT 1 FROM pg_roles WHERE rolname = 'cm_web'")['rows']:
            grants = str(HERE.parent / 'db' / 'grants.sql')
            # The site's own tables come from Neon or a backup, never from here: without them this is the
            # wrong database (or a new one), and the grants would fail after hours of loading.
            have = {r['tablename'] for r in db("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")['rows']}
            missing = sorted({'game_analysis', 'game_annotation', 'uploads', 'upload_rounds'} - have)
            if missing:
                sys.exit(f'this database has no {", ".join(missing)}: restore them from a backup (ops/postgres/README.md), '
                         'or for a new, empty database create them first with psql -f scripts/analysis.pg.sql '
                         '-f scripts/annotation.pg.sql -f scripts/uploads.pg.sql')
        else:
            print('no role cm_web here: skipping the grants (a local database)')
    if a.reset:
        db('DROP TABLE IF EXISTS games, players, events, openings, meta')
    db.script(HERE / 'schema.pg.sql')
    if a.patch:
        patch(db, src, a.batch)
    else:
        for table in TABLES:
            if table != 'changed_games' and src.execute('SELECT 1 FROM sqlite_master WHERE name = ?', (table,)).fetchone():
                copy_table(db, src, table, a.batch)
    print('creating indexes…')
    db.script(HERE / 'indexes.pg.sql')
    db('ANALYZE')
    if grants:
        db.script(Path(grants))
    elif grants is None and isinstance(db, Neon):
        # Neon's site role; recreated tables (--reset) lose its rights otherwise. Nothing is revoked.
        db('GRANT USAGE ON SCHEMA public TO readonly')
        db('GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly')
    print('done')


if __name__ == '__main__':
    main()
