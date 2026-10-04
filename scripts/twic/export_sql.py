#!/usr/bin/env python3
"""Export the TWIC SQLite database (build.py) as SQL files for D1's import API.

D1 imports don't allow BEGIN/COMMIT, each statement must be < 100 KB, and one very large import can
make D1 reset mid-way, so the output is split into parts of about --part-mb each:
  part 1: DROP + CREATE tables and indexes (indexes first, so no huge index build at the end),
          then meta, players, events, openings;
  parts 2..N: games, as batched multi-row INSERTs.
Import the parts in order.

Usage: python3 scripts/twic/export_sql.py --db twic.sqlite --out twic   # -> twic.part01.sql, ...

Each part must import within one polling session (D1 cancels an import that isn't polled every
15 s), so keep parts small (default 60 MB, ~20 s each). To resume after a failed part, or to append
new games to an existing database, use --games-from-id N: only games with id >= N are written, with
no schema or other tables.
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


class Parts:
    def __init__(self, prefix, part_bytes):
        self.prefix, self.part_bytes, self.n, self.f, self.size = prefix, part_bytes, 0, None, 0
        self.paths = []
        self.new()

    def new(self):
        if self.f:
            self.f.close()
        self.n += 1
        path = Path(f'{self.prefix}.part{self.n:02d}.sql')
        self.paths.append(path)
        self.f, self.size = open(path, 'w', encoding='utf-8'), 0

    def write(self, stmt, splittable=True):
        if splittable and self.size and self.size + len(stmt) > self.part_bytes:
            self.new()
        self.f.write(stmt)
        self.size += len(stmt)

    def close(self):
        self.f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True, help='output prefix')
    ap.add_argument('--part-mb', type=int, default=60)
    ap.add_argument('--games-from-id', type=int, help='only games with id >= N (append/resume)')
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    stmts = [re.sub(r'--[^\n]*', '', s).strip() for s in SCHEMA.split(';')]
    parts = Parts(args.out, args.part_mb * 1_000_000)
    tables = ('games',) if args.games_from_id else ('meta', 'players', 'events', 'openings', 'games')
    if not args.games_from_id:
        for t in ('games', 'events', 'players', 'openings', 'meta'):
            parts.write(f'DROP TABLE IF EXISTS {t};\n', splittable=False)
        for s in stmts:
            if s:
                parts.write(s + ';\n', splittable=False)
    for table in tables:
        if table == 'games' and not args.games_from_id:
            parts.new()  # games start in their own part
        cols = [r[1] for r in db.execute(f'PRAGMA table_info({table})')]
        head = f"INSERT INTO {table} ({', '.join(cols)}) VALUES "
        batch, size, rows = [], len(head), 0
        where = f' WHERE id >= {int(args.games_from_id)}' if table == 'games' and args.games_from_id else ''
        for row in db.execute(f'SELECT {", ".join(cols)} FROM {table}{where} ORDER BY rowid'):
            values = '(' + ','.join(lit(v) for v in row) + ')'
            if batch and size + len(values) + 1 > MAX_STMT:
                parts.write(head + ','.join(batch) + ';\n', splittable=table == 'games')
                batch, size = [], len(head)
            batch.append(values)
            size += len(values) + 1
            rows += 1
        if batch:
            parts.write(head + ','.join(batch) + ';\n', splittable=table == 'games')
        print(f'{table}: {rows:,} rows')
    parts.write('ANALYZE;\n', splittable=False)
    parts.close()
    for p in parts.paths:
        print(f'{p} ({p.stat().st_size / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
