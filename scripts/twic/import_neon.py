#!/usr/bin/env python3
"""Load the TWIC SQLite build into Neon Postgres over Neon's HTTPS SQL endpoint (no psql needed).

    NEON_DATABASE_URL=postgres://owner:...@ep-xxx.region.aws.neon.tech/neondb \
      python3 scripts/twic/import_neon.py --db twic.sqlite [--reset] [--batch 4000]

Resumable: each table is copied in id order and a rerun continues after the highest id already
in Postgres. --reset drops the tables first (do this for a full rebuild). Afterwards it creates
the indexes (indexes.pg.sql), grants SELECT to the read-only role used by Hyperdrive (--reader),
and ANALYZEs. Use the owner role's direct (non-pooler) connection string. Standard library only.
"""
import argparse
import json
import os
import re
import sqlite3
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
                      ('end_date', 'text'), ('games', 'int'), ('twic', 'int')]),
    'players': ('id', [('id', 'int'), ('fide_id', 'int'), ('name', 'text'), ('slug', 'text'), ('search', 'text'),
                       ('title', 'text'), ('fed', 'text'), ('born', 'int'), ('max_elo', 'int'), ('games', 'int'),
                       ('last_date', 'text')]),
    'games': ('id', [('id', 'int'), ('event_id', 'int'), ('white_id', 'int'), ('black_id', 'int'), ('white_elo', 'int'),
                     ('black_elo', 'int'), ('white_title', 'text'), ('black_title', 'text'), ('elo_avg', 'int'),
                     ('result', 'text'), ('date', 'text'), ('round', 'text'), ('eco', 'text'), ('opening', 'text'),
                     ('plies', 'int'), ('twic', 'int'), ('moves', 'text')]),
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

    def script(self, path: Path):
        for stmt in re.sub(r'--[^\n]*', '', path.read_text()).split(';'):
            if stmt.strip():
                self(stmt)


def copy_table(neon: Neon, src: sqlite3.Connection, table: str, batch: int):
    key, cols = TABLES[table]
    names = ', '.join(c for c, _ in cols)
    total = src.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    if key == 'id':
        done = int(neon(f'SELECT COALESCE(MAX(id), 0) AS m FROM {table}')['rows'][0]['m'])
    else:
        done = None  # small key/value tables: upsert everything
    insert = (f'INSERT INTO {table} ({names}) SELECT * FROM unnest('
              + ', '.join(f'${i + 1}::{t}[]' for i, (_, t) in enumerate(cols))
              + f') ON CONFLICT ({key}) DO ' + ('NOTHING' if key == 'id' else
              'UPDATE SET ' + ', '.join(f'{c} = EXCLUDED.{c}' for c, _ in cols if c != key)))
    where, args = ('WHERE id > ?', [done]) if done is not None else ('', [])
    cur = src.execute(f'SELECT {names} FROM {table} {where} ORDER BY {key}', args)
    copied, t0 = 0, time.time()
    while rows := cur.fetchmany(batch):
        neon(insert, [pg_array(col) for col in zip(*rows)])
        copied += len(rows)
        rate = copied / max(time.time() - t0, 1e-6)
        print(f'\r{table}: {copied + (done or 0):,}/{total:,} ({rate:,.0f} rows/s)', end='', flush=True)
    print(f'\r{table}: {total:,} rows' + ' ' * 30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True, help='SQLite file from build.py')
    ap.add_argument('--batch', type=int, default=4000, help='rows per INSERT')
    ap.add_argument('--reset', action='store_true', help='drop and recreate the tables first')
    ap.add_argument('--reader', default='readonly', help='role to grant SELECT to (Hyperdrive user)')
    a = ap.parse_args()
    url = os.environ.get('NEON_DATABASE_URL') or sys.exit('set NEON_DATABASE_URL')
    neon, src = Neon(url), sqlite3.connect(a.db)
    if a.reset:
        neon('DROP TABLE IF EXISTS games, players, events, openings, meta')
    neon.script(HERE / 'schema.pg.sql')
    for table in TABLES:
        copy_table(neon, src, table, a.batch)
    print('creating indexes…')
    neon.script(HERE / 'indexes.pg.sql')
    if a.reader:
        neon(f'GRANT USAGE ON SCHEMA public TO {a.reader}')
        neon(f'GRANT SELECT ON ALL TABLES IN SCHEMA public TO {a.reader}')
    neon('ANALYZE')
    print('done')


if __name__ == '__main__':
    main()
