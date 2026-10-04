#!/usr/bin/env python3
"""Write src/data/opening-master-games.json from the TWIC SQLite database (build.py):
for every named opening line, the number of TWIC games tagged with it, White/draw/Black results,
and the 5 games with the highest average rating (for "Master games" on opening pages).

Usage: python3 scripts/twic/opening_games.py --db twic.sqlite
"""
import argparse
import json
import re
import sqlite3
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def slugify(s):
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"['’]", '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def last_name(n):
    return n.split(',')[0] if ',' in n else n.split(' ')[-1]


def game_path(gid, white, black, event, date):
    year = (date or '')[:4]
    slug = slugify(f"{last_name(white)} vs {last_name(black)} {event} {'' if year in event else year}")[:90].rstrip('-')
    return f'/games/{gid}-{slug}/'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', default=str(ROOT / 'src/data/opening-master-games.json'))
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    out = {}
    for slug, n, w, d, b in db.execute(
        "SELECT opening, COUNT(*), SUM(result='1-0'), SUM(result='1/2-1/2'), SUM(result='0-1') FROM games WHERE opening IS NOT NULL GROUP BY opening"
    ):
        out[slug] = {'n': n, 'r': [w, d, b], 'top': []}
    q = '''SELECT g.id, w.name, g.white_elo, g.white_title, b.name, g.black_elo, g.black_title, g.result, g.date, e.name
           FROM games g JOIN players w ON w.id = g.white_id JOIN players b ON b.id = g.black_id JOIN events e ON e.id = g.event_id
           WHERE g.opening = ? AND g.elo_avg IS NOT NULL ORDER BY g.elo_avg DESC, g.date DESC LIMIT 5'''
    for slug in out:
        out[slug]['top'] = [
            {'path': game_path(gid, wn, bn, ev, date), 'white': wn, 'whiteElo': we, 'whiteTitle': wt, 'black': bn, 'blackElo': be,
             'blackTitle': bt, 'result': res, 'date': date, 'event': ev}
            for gid, wn, we, wt, bn, be, bt, res, date, ev in db.execute(q, (slug,))
        ]
    meta = dict(db.execute('SELECT key, value FROM meta'))
    Path(args.out).write_text(json.dumps({'source': f"The Week in Chess #{meta['first_issue']}–#{meta['last_issue']}", 'games': int(meta['games']), 'lines': out}, separators=(',', ':')))
    print(f'{len(out)} lines, {Path(args.out).stat().st_size / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
