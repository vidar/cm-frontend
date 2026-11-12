#!/usr/bin/env python3
"""Keep event ids and slugs stable across rebuilds, and list the games that changed.

    python3 scripts/twic/remap_events.py --old twic-live.sqlite --new twic.sqlite

The new build must come from `build.py --previous twic-live.sqlite`, which keeps the ids and slugs of
the old build's games, players and events and numbers new rows after them. This refuses to run when
an id names another game or player in the two builds, when old games or players are missing from the
new build, or when a new game has an id the old build already passed (import_pg.py appends games
after the highest id it holds). With --drop-missing, old games the new build no longer has (a build
change such as a stricter dedup) are accepted and listed in `gone_games` for `import_pg.py --patch`
to delete.

Event grouping can change between builds (e.g. merging a league's weekends). Events that kept their
id and slug stay; any other event that continues an old event takes that event's id and slug (the
old event whose slug is the new event's natural slug, else the one holding most of its games).
Events with no old counterpart keep their new ids (above the old ones).

Old events folded into another one get a row in `event_redirects` (old slug -> event id), so
their URLs can redirect. It also writes a `changed_games` table (whole game rows) with the games whose
row differs from the old build (event, players, ratings, round, opening...), for `import_pg.py --patch`.
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
    ap.add_argument('--drop-missing', action='store_true', help='accept old games missing from the new build: --patch deletes them')
    a = ap.parse_args()
    db = sqlite3.connect(a.new)
    db.execute('ATTACH ? AS old', (a.old,))

    # Every old game and player still under its id? (New ones only after them.)
    moved = db.execute('SELECT COUNT(*) FROM games g JOIN old.games o ON o.id = g.id WHERE g.twic IS NOT o.twic OR g.moves IS NOT o.moves').fetchone()[0]
    gone = db.execute('SELECT COUNT(*) FROM old.games o WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.id = o.id)').fetchone()[0]
    early = db.execute('SELECT COUNT(*) FROM games g WHERE g.id <= (SELECT MAX(id) FROM old.games) '
                       'AND NOT EXISTS (SELECT 1 FROM old.games o WHERE o.id = g.id)').fetchone()[0]
    pdiff = db.execute('SELECT COUNT(*) FROM old.players o LEFT JOIN players p ON p.id = o.id WHERE p.slug IS NOT o.slug').fetchone()[0]
    if moved or (gone and not a.drop_missing) or early or pdiff:
        sys.exit(f'ids differ between the builds ({moved:,} game ids name other games, {gone:,} old games missing, {early:,} new games '
                 f'below the old highest id, {pdiff:,} old players missing or renamed): build with --previous {a.old}, '
                 'or do a full import (import_pg.py --reset); --drop-missing accepts missing old games (a stricter build)')
    db.execute('DROP TABLE IF EXISTS gone_games')
    db.execute('CREATE TABLE gone_games AS SELECT id FROM old.games o WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.id = o.id)')
    if gone:
        print(f'{gone:,} old games are not in the new build: import_pg.py --patch deletes them')

    old_slug = dict(db.execute('SELECT id, slug FROM old.events'))
    old_by_slug = {s: i for i, s in old_slug.items()}
    # new event -> Counter(old event -> games)
    overlap = collections.defaultdict(collections.Counter)
    for new_e, old_e, n in db.execute('SELECT g.event_id, o.event_id, COUNT(*) FROM games g JOIN old.games o ON o.id = g.id GROUP BY 1, 2'):
        overlap[new_e][old_e] += n
    new_events = db.execute('SELECT id, slug, games FROM events ORDER BY games DESC').fetchall()
    mapping, taken = {}, set()
    for new_e, slug, _ in new_events:
        if old_slug.get(new_e) == slug:  # kept by build.py --previous
            mapping[new_e] = new_e
            taken.add(new_e)
    for new_e, slug, _ in new_events:
        if new_e in mapping:
            continue
        natural = re.sub(r'-\d+$', '', slug)
        candidates = [o for o, _ in overlap[new_e].most_common() if o not in taken]
        pick = next((o for o in candidates if old_slug[o] in (slug, natural)), candidates[0] if candidates else None)
        if pick is not None:
            mapping[new_e] = pick
            taken.add(pick)
    top = max(old_slug)
    for new_e, _, _ in new_events:
        if new_e not in mapping and new_e > top:  # new events numbered after the old ones by build.py --previous
            mapping[new_e] = new_e
    next_id = max([top, *mapping.values()]) + 1
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

    # Folded old events: redirect to the event that now holds most of their games.
    holder = {}
    for new_e, c in overlap.items():
        for old_e, k in c.items():
            if old_e not in holder or k > holder[old_e][1]:
                holder[old_e] = (mapping[new_e], k)
    kept = set(mapping.values())
    db.execute('CREATE TABLE IF NOT EXISTS event_redirects (slug TEXT PRIMARY KEY, event_id INTEGER NOT NULL)')
    db.execute('INSERT OR REPLACE INTO event_redirects SELECT slug, event_id FROM old.event_redirects') if db.execute(
        "SELECT 1 FROM old.sqlite_master WHERE name = 'event_redirects'").fetchone() else None
    db.executemany('INSERT OR REPLACE INTO event_redirects VALUES (?, ?)',
                   [(old_slug[o], holder[o][0]) for o in old_slug if o not in kept and o in holder])

    # Games whose row changed (event, players, ratings, round, opening, teams...): import_pg.py --patch rewrites them.
    db.execute('DROP TABLE IF EXISTS changed_games')
    cols = [r[1] for r in db.execute('PRAGMA table_info(games)')]
    old_cols = {r[1] for r in db.execute('PRAGMA old.table_info(games)')}
    differs = ' OR '.join(f'g.{c} IS NOT ' + (f'o.{c}' if c in old_cols else 'NULL') for c in cols if c != 'id')
    db.execute(f'CREATE TABLE changed_games AS SELECT g.* FROM games g JOIN old.games o ON o.id = g.id WHERE {differs}')
    db.commit()
    changed = db.execute('SELECT COUNT(*) FROM changed_games').fetchone()[0]
    merged = sum(1 for c in overlap.values() if len(c) > 1)
    gone = len(old_slug) - len(set(mapping.values()) & set(old_slug))
    new = sum(1 for e in mapping.values() if e not in old_slug)
    print(f'{len(new_events):,} events ({merged:,} merged from several old events, {gone:,} old events folded into others, '
          f'{new:,} new); {changed:,} games changed')
    db.execute('VACUUM')


if __name__ == '__main__':
    main()
