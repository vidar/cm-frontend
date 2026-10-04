#!/usr/bin/env python3
"""Export the TWIC SQLite database (build.py) as a SQL file for D1's import API.

D1 imports don't allow BEGIN/COMMIT and each statement must be < 100 KB, so rows are written as
batched multi-row INSERTs, and indexes are created after the data.

Usage: python3 scripts/twic/export_sql.py --db twic.sqlite --out twic.sql
"""
import argparse
import re
import sqlite3
from pathlib import Path

SCHEMA = (Path(__file__).parent / 'schema.sql').read_text()
MAX_STMT = 90_000


def lit(v):
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    tables = [s for s in SCHEMA.split(';') if 'CREATE TABLE' in s]
    indexes = [s for s in SCHEMA.split(';') if 'CREATE INDEX' in s]
    with open(args.out, 'w', encoding='utf-8') as out:
        for t in ('games', 'events', 'players', 'openings', 'meta'):
            out.write(f'DROP TABLE IF EXISTS {t};\n')
        for s in tables:
            out.write(re.sub(r'--[^\n]*', '', s).strip() + ';\n')
        for table in ('meta', 'players', 'events', 'openings', 'games'):
            cols = [r[1] for r in db.execute(f'PRAGMA table_info({table})')]
            head = f"INSERT INTO {table} ({', '.join(cols)}) VALUES "
            batch, size, rows = [], len(head), 0
            for row in db.execute(f'SELECT {", ".join(cols)} FROM {table} ORDER BY rowid'):
                values = '(' + ','.join(lit(v) for v in row) + ')'
                if batch and size + len(values) + 1 > MAX_STMT:
                    out.write(head + ','.join(batch) + ';\n')
                    batch, size = [], len(head)
                batch.append(values)
                size += len(values) + 1
                rows += 1
            if batch:
                out.write(head + ','.join(batch) + ';\n')
            print(f'{table}: {rows:,} rows')
        for s in indexes:
            out.write(s.strip() + ';\n')
        out.write('ANALYZE;\n')
    print(f'wrote {args.out} ({Path(args.out).stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
