#!/usr/bin/env python3
"""Keep event ids and slugs stable across rebuilds, and list the games that changed.

    python3 scripts/twic/remap_events.py --old twic-live.sqlite --new twic.sqlite

Game and player ids are deterministic (same input = same ids), but event grouping can change
between builds (e.g. merging a league's weekends). This rewrites the new build's event ids and
slugs to the old ones where an event continues an old event: the old event whose slug is the new
event's natural slug, else the one holding most of its games. Events with no old counterpart get
fresh ids. It refuses to run if game or player ids differ between the builds.

It also writes a `changed_games` table (id, event_id, white_team, black_team) with the games whose
event or teams differ from the old build, for `import_neon.py --patch`.
"""
import argparse
import collections
import re
import sqlite3
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', required=True, help='SQLite build currently loaded in Postgres')
    ap.add_argument('--new', required=True, help='new SQLite build (rewritten in place)')
    a = ap.parse_args()
    db = sqlite3.connect(a.new)
    db.execute('ATTACH ? AS old', (a.old,))

    # Same games and players?
    cols = 'id, white_id, black_id, white_elo, black_elo, result, date, plies, twic'
    diff = db.execute(f'SELECT COUNT(*) FROM (SELECT {cols} FROM games EXCEPT SELECT {cols} FROM old.games)').fetchone()[0]
    diff += db.execute(f'SELECT COUNT(*) FROM (SELECT {cols} FROM old.games EXCEPT SELECT {cols} FROM games)').fetchone()[0]
    pdiff = db.execute('SELECT COUNT(*) FROM (SELECT id, slug FROM players EXCEPT SELECT id, slug FROM old.players)').fetchone()[0]
    if diff or pdiff:
        sys.exit(f'game/player ids differ between builds ({diff} games, {pdiff} players): do a full import instead')

    old_slug = dict(db.execute('SELECT id, slug FROM old.events'))
    old_by_slug = {s: i for i, s in old_slug.items()}
    # new event -> Counter(old event -> games)
    overlap = collections.defaultdict(collections.Counter)
    for new_e, old_e, n in db.execute('SELECT g.event_id, o.event_id, COUNT(*) FROM games g JOIN old.games o ON o.id = g.id GROUP BY 1, 2'):
        overlap[new_e][old_e] += n
    new_events = db.execute('SELECT id, slug, games FROM events ORDER BY games DESC').fetchall()
    mapping, taken = {}, set()
    for new_e, slug, _ in new_events:
        natural = re.sub(r'-\d+$', '', slug)
        candidates = [o for o, _ in overlap[new_e].most_common() if o not in taken]
        pick = next((o for o in candidates if old_slug[o] in (slug, natural)), candidates[0] if candidates else None)
        if pick is not None:
            mapping[new_e] = pick
            taken.add(pick)
    next_id = max(old_slug) + 1
    for new_e, _, _ in sorted(new_events):
        if new_e not in mapping:
            mapping[new_e] = next_id
            next_id += 1

    # Slugs: mapped events keep the old slug; new ones keep theirs unless it's taken.
    used = {old_slug[o] for o in mapping.values() if o in old_slug}
    rows = []
    for e in db.execute('SELECT * FROM events'):
        e = list(e)
        new_id = mapping[e[0]]
        if new_id in old_slug:
            e[3] = old_slug[new_id]
        else:
            base, k = e[3], 2
            while e[3] in used:
                e[3] = f'{base}-{k}'
                k += 1
            used.add(e[3])
        e[0] = new_id
        rows.append(e)
    db.execute('CREATE TEMP TABLE emap (new INTEGER PRIMARY KEY, old INTEGER)')
    db.executemany('INSERT INTO emap VALUES (?, ?)', mapping.items())
    db.execute('UPDATE games SET event_id = (SELECT old FROM emap WHERE new = games.event_id)')
    db.execute('DELETE FROM events')
    db.executemany(f'INSERT INTO events VALUES ({",".join("?" * len(rows[0]))})', rows)

    db.execute('DROP TABLE IF EXISTS changed_games')
    old_cols = {r[1] for r in db.execute('PRAGMA old.table_info(games)')}
    old_teams = 'o.white_team, o.black_team' if 'white_team' in old_cols else 'NULL, NULL'
    db.execute(f'''CREATE TABLE changed_games AS
        SELECT g.id, g.event_id, g.white_team, g.black_team FROM games g JOIN old.games o ON o.id = g.id
        WHERE g.event_id IS NOT o.event_id OR (g.white_team, g.black_team) IS NOT ({old_teams})''')
    db.commit()
    changed = db.execute('SELECT COUNT(*) FROM changed_games').fetchone()[0]
    merged = sum(1 for c in overlap.values() if len(c) > 1)
    gone = len(old_slug) - len(set(mapping.values()) & set(old_slug))
    print(f'{len(new_events):,} events ({merged:,} merged from several old events, {gone:,} old events folded into others, '
          f'{next_id - max(old_slug) - 1:,} new); {changed:,} games changed')
    db.execute('VACUUM')


if __name__ == '__main__':
    main()
