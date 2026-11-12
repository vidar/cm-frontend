#!/usr/bin/env python3
"""Recreate the SQLite build that is loaded in Postgres (twic-live.sqlite) from Postgres itself.

Weekly updates need the build loaded now as `build.py --previous` and `remap_events.py --old`. If that file
is lost, this writes an equivalent one: the TWIC rows of games, players and events (ids below
UPLOAD_ID_BASE; uploaded tournaments stay out, as in a build), event_redirects, openings and meta, in the
build's schema (schema.sql). That is everything --previous and remap_events.py read: games match by TWIC issue
and moves, players by their games, events by their games, and the ids and slugs are the loaded ones. The
SQLite-only column events.kind stays empty (build.py works it out again).

Usage, on the database server as root (no password: root maps to cm_owner over the local socket):

  DATABASE_URL='postgresql://cm_owner@/cm_games?host=/var/run/postgresql' \
    python3 scripts/twic/export_live.py --out /tmp/twic-live.sqlite

Standard library only; it talks to Postgres through the psql client, as import_pg.py does. Reads only.
"""
import argparse
import csv
import io
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_pg import GAME_COLS, TABLES, UPLOAD_ID_BASE, libpq_env  # noqa: E402

NULL = '\\N'
# Table -> filter. Uploaded rows (ids from UPLOAD_ID_BASE) are not part of a TWIC build.
EXPORT = {
    'openings': '',
    'events': f'WHERE id < {UPLOAD_ID_BASE}',
    'players': f'WHERE id < {UPLOAD_ID_BASE}',
    'games': f'WHERE id < {UPLOAD_ID_BASE}',
    'event_redirects': f'WHERE event_id < {UPLOAD_ID_BASE}',
    'meta': '',
}


def copy_out(env: dict, table: str, cols: list[str], where: str):
    """Rows of one table as lists of strings (None for NULL), streamed from psql's COPY."""
    sql = f"COPY (SELECT {', '.join(cols)} FROM {table} {where} ORDER BY 1) TO STDOUT WITH (FORMAT csv, NULL '{NULL}')"
    p = subprocess.Popen(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], env={**os.environ, **env},
                         stdout=subprocess.PIPE)
    for row in csv.reader(io.TextIOWrapper(p.stdout, encoding='utf-8', newline='')):
        yield [None if v == NULL else v for v in row]
    if p.wait() != 0:
        sys.exit(f'psql failed while reading {table}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='SQLite file to write (must not exist)')
    args = ap.parse_args()
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit("set DATABASE_URL (as root on the server: 'postgresql://cm_owner@/cm_games?host=/var/run/postgresql')")
    out = Path(args.out)
    if out.exists():
        sys.exit(f'{out} exists already: remove it or choose another --out')
    env = libpq_env(url)
    tmp = out.with_name(out.name + '.part')
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript((Path(__file__).resolve().parent / 'schema.sql').read_text())
    db.execute('CREATE TABLE IF NOT EXISTS event_redirects (slug TEXT PRIMARY KEY, event_id INTEGER NOT NULL)')
    counts = {}
    for table, where in EXPORT.items():
        cols = [c for c, _ in (GAME_COLS if table == 'games' else TABLES[table][1])]
        insert = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"
        n, batch = 0, []
        for row in copy_out(env, table, cols, where):
            batch.append(row)
            if len(batch) >= 20000:
                db.executemany(insert, batch)
                n += len(batch)
                batch = []
                print(f'\r{table}: {n:,}', end='', file=sys.stderr, flush=True)
        db.executemany(insert, batch)
        n += len(batch)
        counts[table] = n
        print(f'\r{table}: {n:,} rows        ', file=sys.stderr, flush=True)
    db.commit()
    # The totals in meta describe what Postgres holds, uploads included; a build's meta counts only TWIC rows.
    meta = dict(db.execute('SELECT key, value FROM meta'))
    for t in ('games', 'players', 'events'):
        if meta.get(t) not in (None, str(counts[t])):
            print(f'note: meta says {meta[t]} {t}, exported {counts[t]:,} TWIC {t} (the rest are uploads)', file=sys.stderr)
    db.execute('ANALYZE')
    db.commit()
    db.close()
    tmp.rename(out)
    print(f'wrote {out}: {counts["games"]:,} games, {counts["players"]:,} players, {counts["events"]:,} events, '
          f'{counts["event_redirects"]:,} redirects', file=sys.stderr)


if __name__ == '__main__':
    main()
