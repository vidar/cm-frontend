#!/usr/bin/env python3
"""Build the TWIC games database (SQLite, same schema as the D1 database) from downloaded issues.

- Parses every twic<N>g.zip in the cache directory (see download.py).
- Validates each game's moves with python-chess and re-emits normalized SAN; invalid games and
  forfeits (no moves) are skipped.
- Removes duplicates (same players, date and moves), keeping the earliest issue.
- Merges players by FIDE ID (falling back to the name), choosing the fullest spelling for display.
- Tags each game with the longest matching named opening line (src/data/openings/*.tsv).

- With --fide (FIDE's players_list.zip, https://ratings.fide.com/download/players_list.zip), players
  get their official full name, federation, title and birth year. A game only counts for a FIDE ID
  if its name shares a name part with that player's name (TWIC occasionally attaches a wrong ID).

Usage:
  pip install chess
  python3 scripts/twic/build.py --dir /path/to/cache --out /path/to/twic.sqlite --fide players_list.zip
Then scripts/twic/export_sql.py turns the SQLite file into SQL for D1.
"""
import argparse
import collections
import hashlib
import io
import multiprocessing as mp
import re
import sqlite3
import sys
import time
import unicodedata
import zipfile
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = (Path(__file__).parent / 'schema.sql').read_text()
MOVE_NUM = re.compile(r'^\d+\.+$')
TAG = re.compile(r'^\[(\w+)\s+"(.*)"\]\s*$')
RESULTS = {'1-0', '0-1', '1/2-1/2'}
# Headers kept per game (everything else is dropped early to bound memory on ~3M games).
KEEP = ('Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteTitle', 'BlackTitle', 'WhiteElo', 'BlackElo',
        'ECO', 'WhiteFideId', 'BlackFideId', 'EventDate')


def slugify(s: str) -> str:
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"['’]", '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def load_openings():
    """SAN-moves key -> slug, matching src/lib/openings.ts (files in path order, duplicate names get -2, -3…)."""
    rows = []
    for f in sorted((ROOT / 'src/data/openings').glob('*.tsv')):
        for line in f.read_text().splitlines()[1:]:
            eco, name, pgn = line.split('\t')
            rows.append((name, ' '.join(t for t in pgn.split() if not MOVE_NUM.match(t)), eco))
    counts = collections.Counter(r[0] for r in rows)
    used = collections.Counter()
    by_moves = {}
    for name, key, eco in rows:
        slug = slugify(name)
        if counts[name] > 1:
            used[name] += 1
            if used[name] > 1:
                slug = f'{slug}-{used[name]}'
        by_moves.setdefault(key, slug)
        NAMES[slug] = (name, eco)
    prefixes = {' '.join(k.split(' ')[:i]) for k in by_moves for i in range(1, len(k.split(' ')) + 1)}
    return by_moves, prefixes


NAMES = {}  # slug -> (name, eco)
OPENINGS, PREFIXES = load_openings()


def opening_for(sans):
    best, prefix = None, ''
    for i, san in enumerate(sans[:40]):
        prefix = san if i == 0 else f'{prefix} {san}'
        if prefix not in PREFIXES:
            break
        best = OPENINGS.get(prefix, best)
    return best


def clean_movetext(text: str):
    text = re.sub(r'\{[^}]*\}', ' ', text)
    while '(' in text:  # strip (nested) variations
        new = re.sub(r'\([^()]*\)', ' ', text)
        if new == text:
            break
        text = new
    toks = []
    for t in text.split():
        if MOVE_NUM.match(t) or t.startswith('$') or t in RESULTS or t == '*':
            continue
        t = re.sub(r'^\d+\.+', '', t)  # "1.e4"
        t = re.sub(r'[?!]+$', '', t)
        if t:
            toks.append(t)
    return toks


def parse_issue(path: str):
    n = int(re.search(r'twic(\d+)g', path).group(1))
    out, bad = [], 0
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.lower().endswith('.pgn'):
                continue
            text = z.read(name).decode('latin-1')
            for chunk in re.split(r'\n(?=\[Event )', text):
                headers, body = {}, []
                for line in chunk.splitlines():
                    m = TAG.match(line)
                    if m:
                        headers[m.group(1)] = m.group(2)
                    elif line.strip():
                        body.append(line)
                if not headers or headers.get('Result') not in RESULTS:
                    continue
                if headers.get('SetUp') == '1' or 'FEN' in headers:
                    continue  # games from set-up positions (rare) are skipped
                board = chess.Board()
                sans = []
                try:
                    for tok in clean_movetext(' '.join(body)):
                        move = board.parse_san(tok)
                        sans.append(board.san(move))
                        board.push(move)
                except ValueError:
                    bad += 1
                    continue
                if not sans:  # forfeits: a result without moves
                    continue
                out.append((n, {k: headers[k] for k in KEEP if k in headers}, ' '.join(sans)))
    return n, out, bad


def int_or_none(v):
    try:
        return int(v) if v and v.strip('?') else None
    except ValueError:
        return None


def norm_date(d):
    """'2012.07.02' -> '2012-07-02'; keeps a valid prefix ('2012-07', '2012') when parts are unknown or invalid."""
    parts = (d or '').split('.')
    y = parts[0]
    if not (len(y) == 4 and y.isdigit() and 1900 <= int(y) <= 2100):
        return None
    m = parts[1] if len(parts) > 1 else ''
    if not (len(m) == 2 and m.isdigit() and 1 <= int(m) <= 12):
        return y
    day = parts[2] if len(parts) > 2 else ''
    if not (len(day) == 2 and day.isdigit() and 1 <= int(day) <= 31):
        return f'{y}-{m}'
    return f'{y}-{m}-{day}'


def load_fide(path):
    """FIDE players list (fixed-width TXT inside the zip) -> {id: (name, fed, title, born)}."""
    with zipfile.ZipFile(path) as z:
        text = z.read(z.namelist()[0]).decode('latin-1')
    lines = text.splitlines()
    head = lines[0]
    col = lambda name: head.index(name)
    c_name, c_fed, c_sex, c_tit, c_wtit, c_bday, c_flag = col('Name'), col('Fed'), col('Sex'), col('Tit'), col('WTit'), col('B-day'), col('Flag')
    out = {}
    for line in lines[1:]:
        try:
            fid = int(line[:c_name].strip())
        except ValueError:
            continue
        raw = line[c_name:c_fed].strip()
        last, _, first = raw.partition(',')
        name = f'{first.strip()} {last.strip()}'.strip() if first.strip() else last.strip()
        title = line[c_tit:c_wtit].strip() or line[c_wtit:c_wtit + 5].strip() or None
        born = line[c_bday:c_flag].strip()
        out[fid] = (name, line[c_fed:c_sex].strip() or None, title, int(born) if born.isdigit() and born != '0' else None)
    return out


def name_parts(name):
    """Name parts of 3+ letters, e.g. 'Carlsen,M' -> {'carlsen'}, 'Magnus Carlsen' -> {'magnus', 'carlsen'}."""
    return {t for t in slugify(name).split('-') if len(t) >= 3}


def display_name(variants: collections.Counter) -> str:
    def full(v):  # "Carlsen,Magnus" beats "Carlsen,M"
        if ',' in v:
            first = v.split(',', 1)[1].strip()
            return len(first.rstrip('.')) > 2
        return True
    candidates = [v for v in variants if full(v)] or list(variants)
    best = max(candidates, key=lambda v: (variants[v], len(v)))
    if ',' in best:
        last, first = [p.strip() for p in best.split(',', 1)]
        if len(first.rstrip('.')) <= 2:  # only initials: "Carlsen, M."
            return f"{last}, {first.rstrip('.')}." if first else last
        return f'{first} {last}'.strip()
    return best.strip()


def unique_slug(base, taken):
    base = base or 'x'
    slug, i = base, 2
    while slug in taken:
        slug, i = f'{base}-{i}', i + 1
    taken.add(slug)
    return slug


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, help='only the first N issues (testing)')
    ap.add_argument('--fide', help="FIDE players_list.zip for official names, federations and titles")
    args = ap.parse_args()

    files = sorted(Path(args.dir).glob('twic*g.zip'), key=lambda p: int(re.search(r'twic(\d+)g', p.name).group(1)))
    if args.limit:
        files = files[: args.limit]
    t0 = time.time()

    seen = set()
    games = []  # (issue, headers, sans)
    bad = dupes = 0
    with mp.Pool() as pool:
        for i, (n, parsed, nbad) in enumerate(pool.imap(parse_issue, map(str, files), chunksize=2)):
            bad += nbad
            for issue, h, sans in parsed:
                key = hashlib.sha1('|'.join([h.get('White', '').lower(), h.get('Black', '').lower(), h.get('Date', ''), sans]).encode()).digest()[:12]
                if key in seen:
                    dupes += 1
                    continue
                seen.add(key)
                games.append((issue, h, sans))
            if (i + 1) % 50 == 0:
                print(f'{i + 1}/{len(files)} issues, {len(games):,} games, {time.time() - t0:.0f}s', file=sys.stderr, flush=True)

    fide = load_fide(args.fide) if args.fide else {}
    print(f'{len(fide):,} FIDE players loaded', file=sys.stderr)

    # Players: FIDE ID when the game's name matches that player (official FIDE name, else the most
    # common TWIC spelling for the ID); otherwise the exact name.
    id_names = collections.defaultdict(collections.Counter)
    for _, h, _ in games:
        for side in ('White', 'Black'):
            fid = int_or_none(h.get(side + 'FideId'))
            if fid:
                id_names[fid][h.get(side, '').strip()] += 1
    id_parts = {fid: name_parts(fide[fid][0] if fid in fide else c.most_common(1)[0][0]) for fid, c in id_names.items()}

    def pkey(h, side):
        fid = int_or_none(h.get(side + 'FideId'))
        name = h.get(side, '').strip()
        if fid and (name_parts(name) & id_parts[fid]):
            return f'f{fid}'
        return f'n{name.lower()}'
    names = collections.defaultdict(collections.Counter)
    pinfo = {}
    for issue, h, _ in games:
        for side in ('White', 'Black'):
            k = pkey(h, side)
            names[k][h.get(side, '?').strip()] += 1
            elo = int_or_none(h.get(side + 'Elo'))
            date = norm_date(h.get('Date'))
            p = pinfo.setdefault(k, {'max_elo': None, 'last': None, 'title': None, 'games': 0})
            p['games'] += 1
            if elo and (p['max_elo'] is None or elo > p['max_elo']):
                p['max_elo'] = elo
            if date and (p['last'] is None or date >= p['last']):
                p['last'] = date
                if h.get(side + 'Title'):
                    p['title'] = h[side + 'Title']

    db_path = Path(args.out)
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    taken = set()
    player_id = {}
    for i, k in enumerate(sorted(pinfo, key=lambda k: -pinfo[k]['games']), start=1):
        p = pinfo[k]
        fid = int(k[1:]) if k.startswith('f') else None
        official = fide.get(fid) if fid else None
        name = official[0] if official else display_name(names[k])
        title = (official[2] if official else None) or p['title']
        player_id[k] = i
        db.execute(
            'INSERT INTO players (id, fide_id, name, slug, search, title, fed, born, max_elo, games, last_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (i, fid, name, unique_slug(slugify(name), taken), slugify(name).replace('-', ' '), title,
             official[1] if official else None, official[3] if official else None, p['max_elo'], p['games'], p['last']),
        )

    # Events: name + site + event start (or year).
    ekey = lambda h: (h.get('Event', '?').strip(), h.get('Site', '').strip(), h.get('EventDate') or (h.get('Date') or '')[:4])
    einfo = {}
    for issue, h, _ in games:
        e = einfo.setdefault(ekey(h), {'start': None, 'end': None, 'games': 0, 'twic': issue})
        d = norm_date(h.get('Date'))
        e['games'] += 1
        if d:
            e['start'] = min(e['start'] or d, d)
            e['end'] = max(e['end'] or d, d)
    taken = set()
    event_id = {}
    for i, k in enumerate(sorted(einfo, key=lambda k: (einfo[k]['start'] or '', k[0])), start=1):
        e = einfo[k]
        year = (e['start'] or '')[:4]
        base = slugify(k[0])
        if year and year not in base:
            base = f'{base}-{year}'
        event_id[k] = i
        db.execute(
            'INSERT INTO events (id, name, site, slug, start_date, end_date, games, twic) VALUES (?,?,?,?,?,?,?,?)',
            (i, k[0], k[1] or None, unique_slug(base, taken), e['start'], e['end'], e['games'], e['twic']),
        )

    rows = []
    for gid, (issue, h, sans) in enumerate(sorted(games, key=lambda g: (norm_date(g[1].get('Date')) or '', g[0])), start=1):
        we, be = int_or_none(h.get('WhiteElo')), int_or_none(h.get('BlackElo'))
        rows.append((
            gid, event_id[ekey(h)], player_id[pkey(h, 'White')], player_id[pkey(h, 'Black')], we, be,
            h.get('WhiteTitle') or None, h.get('BlackTitle') or None, (we + be) // 2 if we and be else None,
            h['Result'], norm_date(h.get('Date')), h.get('Round') if h.get('Round') not in (None, '?', '-') else None,
            h.get('ECO') or None, opening_for(sans.split(' ')), sans.count(' ') + 1, issue, sans,
        ))
    used_openings = {r[13] for r in rows if r[13]}
    db.executemany('INSERT INTO openings (slug, name, eco) VALUES (?,?,?)', [(s, *NAMES[s]) for s in sorted(used_openings)])
    db.executemany(
        'INSERT INTO games (id, event_id, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, opening, plies, twic, moves) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        rows,
    )
    issues = [int(re.search(r'twic(\d+)g', f.name).group(1)) for f in files]
    db.executemany('INSERT INTO meta (key, value) VALUES (?, ?)', [
        ('games', str(len(rows))), ('players', str(len(player_id))), ('events', str(len(event_id))),
        ('first_issue', str(min(issues))), ('last_issue', str(max(issues))), ('built_at', time.strftime('%Y-%m-%d')),
    ])
    db.commit()
    db.execute('ANALYZE')
    db.commit()
    db.close()
    print(
        f'done: {len(files)} issues, {len(rows):,} games, {len(player_id):,} players, {len(event_id):,} events, '
        f'{dupes:,} duplicates and {bad:,} invalid games skipped, {db_path.stat().st_size / 1e9:.2f} GB, {time.time() - t0:.0f}s',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
