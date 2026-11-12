#!/usr/bin/env python3
"""Build the TWIC games database (SQLite, same schema as the D1 database) from downloaded issues.

- Parses every twic<N>g.zip in the cache directory (see download.py).
- Validates each game's moves with python-chess and re-emits normalized SAN; invalid games and
  forfeits (no moves) are skipped.
- Removes duplicates, keeping the earliest issue (the TWIC credit) with the latest copy's headers (later
  issues fix Round tags and names): same players, date and moves, or, from a later issue, same event,
  round, result and moves with one player's name unchanged (a corrected spelling).
- Merges players by FIDE ID (falling back to the name), choosing the fullest spelling for display.
- Tags each game with the longest matching named opening line (src/data/openings/*.tsv).
- Ratings above MAX_ELO (typos such as 204269, engines) are stored as NULL. Engine events (TCEC, CCC)
  get no games.elo_avg, so rating-sorted lists skip them, and engine and online events are marked in
  events.kind (this SQLite file only) for opening_games.py.

- With --fide (FIDE's players_list.zip, https://ratings.fide.com/download/players_list.zip), players
  get their official full name, federation, title and birth year. A game only counts for a FIDE ID
  if its name shares a name part with that player's name (TWIC occasionally attaches a wrong ID), or,
  for names without a part of 3+ letters ('So,W'), the surname and first initial.

- With --previous (the build loaded in Postgres now), every game, player and event of that build keeps
  its id and slug: games match by issue and moves, players by the games they played, events by the
  games they hold. New rows get ids above the highest the previous build used, in the usual order, so a
  weekly issue only appends (README: "Updating the live database"). Previous players no game matches
  any more are kept unchanged (Postgres keeps them too). Without --previous ids are numbered from 1:
  games by date, players by game count, events by start date.

Usage:
  pip install chess
  python3 scripts/twic/build.py --dir /path/to/cache --out /path/to/twic.sqlite --fide players_list.zip [--previous twic-live.sqlite]
"""
import argparse
import collections
import datetime
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
EVENT_GAP = 120  # days without games that split two same-named events
MAX_ELO = 3000  # higher ratings are typos (204269) or engines: stored as NULL
ENGINE_EVENT = re.compile(r'\b(TCEC|CCC)\b')  # Top Chess Engine Championship, Chess.com Computer Chess Championship
ONLINE_SITE = re.compile(r'chess\.com|lichess|chess24|playchess|internet|online', re.I)  # TWIC's Site of online events
RESENT_MIN_PLIES = 20  # re-sent copies with a corrected name are matched by event, round and moves from this length
# Headers kept per game (everything else is dropped early to bound memory on ~3M games).
KEEP = ('Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteTitle', 'BlackTitle', 'WhiteElo', 'BlackElo',
        'ECO', 'WhiteFideId', 'BlackFideId', 'EventDate', 'WhiteTeam', 'BlackTeam', 'EventType')


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


def rating(v):
    """An Elo from a WhiteElo/BlackElo tag; None when missing or implausible (above MAX_ELO)."""
    e = int_or_none(v)
    return e if e and 0 < e <= MAX_ELO else None


def event_kind(name, site, games, engine_games):
    """'engine' for computer events (TCEC, CCC, or mostly games between two players rated above MAX_ELO), 'online'
    for events on a chess server (TWIC's Site 'chess.com INT'), None for over-the-board events."""
    if ENGINE_EVENT.search(name) or engine_games * 2 > games:
        return 'engine'
    if (site and ONLINE_SITE.search(site)) or re.search(r'\bonline\b', name, re.I):
        return 'online'
    return None


def round_number(r):
    """Round number from TWIC's Round tag: '5' (round), '5.3' (round.board, or round.match in team
    events) or '5.3.2' (knockout: round.match.game). None when missing or implausible."""
    m = re.match(r'\s*(\d+)', r or '')
    return int(m.group(1)) if m and 0 < int(m.group(1)) <= 60 else None


def team_name(t):
    t = re.sub(r'\s+', ' ', t or '').strip()
    return t if t and t not in ('?', '-') else None


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
    """FIDE players list (fixed-width TXT inside the zip) -> {id: (name, fed, title, born, (surname, given names) slugified)}."""
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
        out[fid] = (name, line[c_fed:c_sex].strip() or None, title, int(born) if born.isdigit() and born != '0' else None,
                    (slugify(last), slugify(first)))
    return out


def name_parts(name):
    """Name parts of 3+ letters, e.g. 'Carlsen,M' -> {'carlsen'}, 'Magnus Carlsen' -> {'magnus', 'carlsen'}."""
    return {t for t in slugify(name).split('-') if len(t) >= 3}


def surname_given(name):
    """'So,W' -> ('so', 'w'): TWIC's 'Surname,Given' spelling, slugified."""
    last, _, first = name.partition(',')
    return slugify(last), slugify(first)


def short_name_match(name, ref):
    """For names without a part of 3+ letters ('So,W', 'Li,Di'), which name_parts() can't compare: the same surname
    and first initial as ref, the (surname, given names) of the FIDE ID's player."""
    last, first = surname_given(name)
    return bool(last and first and ref[0] and ref[1] and last == ref[0] and first[0] == ref[1][0])


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


class Dedupe:
    """Drops copies of games TWIC sent twice. A copy has the same players, date and moves, or comes from a later issue
    with the same event, round, result and moves (RESENT_MIN_PLIES or more) and one player's name unchanged (the
    other corrected). The first issue stays (the credit); a later issue's copy brings its headers, which fix Round
    tags and names."""

    def __init__(self):
        self.games = []  # (issue, headers, sans)
        self.seen, self.resent = {}, {}  # key -> index in games
        self.copies = self.resends = 0

    def add(self, issue, h, sans):
        key = hashlib.sha1('|'.join([h.get('White', '').lower(), h.get('Black', '').lower(), h.get('Date', ''), sans]).encode()).digest()[:12]
        rnd = round_number(h.get('Round'))
        rkey = hashlib.sha1('|'.join([h.get('Event', '').strip(), str(rnd), h.get('Result', ''), sans]).encode()).digest()[:12] if (
            rnd and sans.count(' ') + 1 >= RESENT_MIN_PLIES) else None
        i = self.seen.get(key)
        if i is not None:
            self.copies += 1
        elif rkey is not None and (i := self.resent.get(rkey)) is not None and self.games[i][0] != issue and any(
                self.games[i][1].get(s, '').strip().lower() == h.get(s, '').strip().lower() for s in ('White', 'Black')):
            self.resends += 1
        else:
            self.seen[key] = len(self.games)
            if rkey is not None:
                self.resent.setdefault(rkey, len(self.games))
            self.games.append((issue, h, sans))
            return
        first = self.games[i][0]
        if first != issue:
            self.games[i] = (first, h, sans)
            self.seen.setdefault(key, i)
            if rkey is not None:
                self.resent.setdefault(rkey, i)


PLAYER_COLS = 'id, fide_id, name, slug, search, title, fed, born, max_elo, games, last_date'


def game_key(issue, sans):
    """What identifies a game across builds (--previous): its TWIC issue (the first that had it) and its moves."""
    return hashlib.sha1(f'{issue}|{sans}'.encode()).digest()[:12]


def load_previous(path):
    """From the build loaded now (--previous): its games (id, game_key, white_id, black_id, date, result, event_id),
    player rows by id, event slugs by id, the redirected event slugs and the highest id each table ever used."""
    db = sqlite3.connect(path)
    have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    games = [(gid, game_key(twic, moves), w, b, date, result, eid) for gid, twic, moves, w, b, date, result, eid in
             db.execute('SELECT id, twic, moves, white_id, black_id, date, result, event_id FROM games')]
    players = {r[0]: r for r in db.execute(f'SELECT {PLAYER_COLS} FROM players')}
    events = dict(db.execute('SELECT id, slug FROM events'))
    redirects = {s for s, in db.execute('SELECT slug FROM event_redirects')} if 'event_redirects' in have else set()
    floor = {t: db.execute(f'SELECT COALESCE(MAX(id), 0) FROM {t}').fetchone()[0] for t in ('games', 'players', 'events')}
    if 'id_floor' in have:
        for t, m in db.execute('SELECT tbl, max_id FROM id_floor'):
            floor[t] = max(floor.get(t, 0), m)
    db.close()
    return {'games': games, 'players': players, 'events': events, 'redirects': redirects, 'floor': floor}


def match_previous(prev_games, new_games, keys, prev_fide):
    """Pairs this build's games and players with the previous build's.
    prev_games: (id, game_key, white_id, black_id, date, result, ...) rows; new_games: indexable
    (game_key, white key, black key, date, result) per game; keys: every player key; prev_fide: {fide_id: player id}.
    Players take the previous id their games voted for most (from games whose issue and moves occur once in both
    builds), else that of their FIDE ID. Games with the same issue and moves pair up by players and date/result.
    Returns ({new game index: previous row}, {player key: previous id})."""
    by_key = collections.defaultdict(list)
    for row in prev_games:
        by_key[row[1]].append(row)
    new_by = collections.defaultdict(list)
    for i in range(len(new_games)):
        new_by[new_games[i][0]].append(i)
    votes = collections.Counter()
    for k, idxs in new_by.items():
        olds = by_key.get(k)
        if olds and len(olds) == 1 and len(idxs) == 1:
            n, o = new_games[idxs[0]], olds[0]
            votes[(n[1], o[2])] += 1
            votes[(n[2], o[3])] += 1
    player, used = {}, set()
    for (key, pid), _ in sorted(votes.items(), key=lambda v: (-v[1], v[0][1], v[0][0])):
        if key not in player and pid not in used:
            player[key] = pid
            used.add(pid)
    for key in sorted(keys):
        if key not in player and key.startswith('f') and (pid := prev_fide.get(int(key[1:]))) is not None and pid not in used:
            player[key] = pid
            used.add(pid)

    passes = (
        lambda n, o: player.get(n[1]) == o[2] and player.get(n[2]) == o[3] and n[3] == o[4] and n[4] == o[5],
        lambda n, o: player.get(n[1]) == o[2] and player.get(n[2]) == o[3],
        lambda n, o: n[3] == o[4] and n[4] == o[5],
        lambda n, o: True,
    )
    game = {}
    for k, idxs in new_by.items():
        olds = sorted(by_key.get(k, ()))
        if not olds:
            continue
        rest = [(i, new_games[i]) for i in idxs]
        for same in passes:
            for i, n in list(rest):
                o = next((o for o in olds if same(n, o)), None)
                if o is not None:
                    game[i] = o
                    olds.remove(o)
                    rest.remove((i, n))
            if not olds or not rest:
                break
    return game, player


def match_events(new_events, overlap, prev_slugs):
    """Pairs this build's events with the previous build's: each takes the previous event holding most of its games
    (one whose slug is its natural slug first), biggest events first. new_events: (key, natural slug, games);
    overlap: {key: Counter(previous event id -> games)}. Returns {key: previous event id}."""
    out, taken = {}, set()
    for key, base, _ in sorted(new_events, key=lambda e: (-e[2], e[0][0], str(e[0][1]))):
        cands = [o for o, _ in sorted(overlap.get(key, {}).items(), key=lambda c: (-c[1], c[0])) if o not in taken]
        natural = re.compile(re.escape(base) + r'(-\d+)?')
        pick = next((o for o in cands if natural.fullmatch(prev_slugs[o])), cands[0] if cands else None)
        if pick is not None:
            out[key] = pick
            taken.add(pick)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, help='only the first N issues (testing)')
    ap.add_argument('--fide', help="FIDE players_list.zip for official names, federations and titles")
    ap.add_argument('--previous', help='the SQLite build loaded in Postgres now: keep its ids and slugs, number new rows after them')
    args = ap.parse_args()
    if args.previous and Path(args.previous).resolve() == Path(args.out).resolve():
        sys.exit('--previous and --out must be different files')

    files = sorted(Path(args.dir).glob('twic*g.zip'), key=lambda p: int(re.search(r'twic(\d+)g', p.name).group(1)))
    if args.limit:
        files = files[: args.limit]
    t0 = time.time()

    dedupe = Dedupe()
    bad = 0
    with mp.Pool() as pool:
        for i, (n, parsed, nbad) in enumerate(pool.imap(parse_issue, map(str, files), chunksize=2)):
            bad += nbad
            for issue, h, sans in parsed:
                dedupe.add(issue, h, sans)
            if (i + 1) % 50 == 0:
                print(f'{i + 1}/{len(files)} issues, {len(dedupe.games):,} games, {time.time() - t0:.0f}s', file=sys.stderr, flush=True)
    games = dedupe.games

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
    id_parts, id_ref = {}, {}
    for fid, c in id_names.items():
        ref = fide[fid][0] if fid in fide else c.most_common(1)[0][0]
        id_parts[fid] = name_parts(ref)
        id_ref[fid] = fide[fid][4] if fid in fide else surname_given(ref)

    def pkey(h, side):
        fid = int_or_none(h.get(side + 'FideId'))
        name = h.get(side, '').strip()
        if fid:
            parts = name_parts(name)
            if (parts & id_parts[fid]) if parts else short_name_match(name, id_ref[fid]):
                return f'f{fid}'
        return f'n{name.lower()}'
    names = collections.defaultdict(collections.Counter)
    pinfo = {}
    dropped = 0  # ratings above MAX_ELO
    for issue, h, _ in games:
        for side in ('White', 'Black'):
            k = pkey(h, side)
            names[k][h.get(side, '?').strip()] += 1
            elo = rating(h.get(side + 'Elo'))
            dropped += elo is None and (int_or_none(h.get(side + 'Elo')) or 0) > MAX_ELO
            date = norm_date(h.get('Date'))
            p = pinfo.setdefault(k, {'max_elo': None, 'last': None, 'title': None, 'games': 0})
            p['games'] += 1
            if elo and (p['max_elo'] is None or elo > p['max_elo']):
                p['max_elo'] = elo
            if date and (p['last'] is None or date >= p['last']):
                p['last'] = date
                if h.get(side + 'Title'):
                    p['title'] = h[side + 'Title']

    # --previous: the loaded build's ids for the games and players this one shares with it.
    old = load_previous(args.previous) if args.previous else None
    floor = dict(old['floor']) if old else {'games': 0, 'players': 0, 'events': 0}
    game_match, player_match = {}, {}
    if old:
        class NewGames:  # (game_key, white key, black key, date, result), computed when read
            __len__ = lambda self: len(games)
            __getitem__ = lambda self, i: (game_key(games[i][0], games[i][2]), pkey(games[i][1], 'White'), pkey(games[i][1], 'Black'),
                                           norm_date(games[i][1].get('Date')), games[i][1]['Result'])
        prev_fide = {r[1]: pid for pid, r in old['players'].items() if r[1] is not None}
        game_match, player_match = match_previous(old['games'], NewGames(), pinfo.keys(), prev_fide)

    db_path = Path(args.out)
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    taken = set(r[3] for r in old['players'].values()) if old else set()
    player_id = {}
    next_id = floor['players']
    for k in sorted(pinfo, key=lambda k: -pinfo[k]['games']):
        p = pinfo[k]
        fid = int(k[1:]) if k.startswith('f') else None
        official = fide.get(fid) if fid else None
        name = official[0] if official else display_name(names[k])
        title = (official[2] if official else None) or p['title']
        if k in player_match:
            i = player_match[k]
            slug = old['players'][i][3]
        else:
            i = next_id = next_id + 1
            slug = unique_slug(slugify(name), taken)
        player_id[k] = i
        db.execute(
            f'INSERT INTO players ({PLAYER_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (i, fid, name, slug, slugify(name).replace('-', ' '), title,
             official[1] if official else None, official[3] if official else None, p['max_elo'], p['games'], p['last']),
        )
    matched = set(player_match.values())
    kept_players = [r for pid, r in old['players'].items() if pid not in matched] if old else []
    # Previous players no game names any more (their games moved to another spelling or FIDE ID): kept as they were,
    # like in Postgres, so their ids and slugs are never given to anyone else.
    db.executemany(f'INSERT INTO players ({PLAYER_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)', kept_players)

    # Events: same name, games no more than EVENT_GAP days apart. (Not keyed by site or EventDate:
    # leagues move venue every weekend, and their EventDate changes with it.) Undated games join the
    # cluster their issue's other games of that event are in.
    def day(h):
        for d in (norm_date(h.get('Date')), norm_date(h.get('EventDate'))):
            if d and len(d) == 10:
                return datetime.date.fromisoformat(d).toordinal()
        return None
    by_name = collections.defaultdict(list)
    for i, (_, h, _) in enumerate(games):
        by_name[h.get('Event', '?').strip()].append(i)
    gkey = [None] * len(games)
    for name, idxs in by_name.items():
        dated = sorted((d, i) for i in idxs if (d := day(games[i][1])) is not None)
        cluster, prev, by_issue = 0, None, collections.defaultdict(collections.Counter)
        for d, i in dated:
            if prev is not None and d - prev > EVENT_GAP:
                cluster += 1
            prev = d
            gkey[i] = (name, cluster)
            by_issue[games[i][0]][cluster] += 1
        for i in idxs:
            if gkey[i] is None:
                issue = games[i][0]
                gkey[i] = (name, by_issue[issue].most_common(1)[0][0] if by_issue[issue] else f'i{issue}')
    einfo = {}
    for (issue, h, _), k in zip(games, gkey):
        e = einfo.setdefault(k, {'start': None, 'end': None, 'games': 0, 'twic': issue, 'types': collections.Counter(), 'rounds': 0,
                                 'sites': collections.Counter(), 'engine': 0})
        d = norm_date(h.get('Date'))
        e['games'] += 1
        e['twic'] = min(e['twic'], issue)
        if h.get('Site', '').strip():
            e['sites'][h['Site'].strip()] += 1
        if h.get('EventType'):
            e['types'][h['EventType'].strip().lower()] += 1
        r = round_number(h.get('Round'))
        if r and r > e['rounds']:
            e['rounds'] = r
        if d:
            e['start'] = min(e['start'] or d, d)
            e['end'] = max(e['end'] or d, d)
        if min(int_or_none(h.get('WhiteElo')) or 0, int_or_none(h.get('BlackElo')) or 0) > MAX_ELO:
            e['engine'] += 1

    def natural_slug(k):
        year = (einfo[k]['start'] or '')[:4]
        base = slugify(k[0])
        return f'{base}-{year}' if year and year not in base else base
    event_match = {}
    if old:
        overlap = collections.defaultdict(collections.Counter)
        for i, row in game_match.items():
            overlap[gkey[i]][row[6]] += 1
        event_match = match_events([(k, natural_slug(k), e['games']) for k, e in einfo.items()], overlap, old['events'])
    taken = set(old['events'].values()) | old['redirects'] if old else set()
    event_id, kind = {}, {}
    next_id = floor['events']
    for k in sorted(einfo, key=lambda k: (einfo[k]['start'] or '', k[0])):
        e = einfo[k]
        site = e['sites'].most_common(1)[0][0] if e['sites'] else None
        if k in event_match:
            i = event_match[k]
            slug = old['events'][i]
        else:
            i = next_id = next_id + 1
            slug = unique_slug(natural_slug(k), taken)
        event_id[k] = i
        kind[k] = event_kind(k[0], site, e['games'], e['engine'])
        db.execute(
            'INSERT INTO events (id, name, site, slug, start_date, end_date, games, twic, type, rounds, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (i, k[0], site, slug, e['start'], e['end'], e['games'], e['twic'],
             e['types'].most_common(1)[0][0] if e['types'] else None, e['rounds'] or None, kind[k]),
        )

    rows = []
    order = sorted(range(len(games)), key=lambda i: (norm_date(games[i][1].get('Date')) or '', games[i][0]))
    next_id = floor['games']
    for gi in order:
        issue, h, sans = games[gi]
        if gi in game_match:
            gid = game_match[gi][0]
        else:
            gid = next_id = next_id + 1
        we, be = rating(h.get('WhiteElo')), rating(h.get('BlackElo'))
        rows.append((
            gid, event_id[gkey[gi]], player_id[pkey(h, 'White')], player_id[pkey(h, 'Black')], we, be,
            h.get('WhiteTitle') or None, h.get('BlackTitle') or None,
            (we + be) // 2 if we and be and kind[gkey[gi]] != 'engine' else None,  # engines stay out of rating sorts
            h['Result'], norm_date(h.get('Date')), h.get('Round') if h.get('Round') not in (None, '?', '-') else None,
            h.get('ECO') or None, opening_for(sans.split(' ')), sans.count(' ') + 1, issue, sans,
            team_name(h.get('WhiteTeam')), team_name(h.get('BlackTeam')),
        ))
    used_openings = {r[13] for r in rows if r[13]}
    db.executemany('INSERT INTO openings (slug, name, eco) VALUES (?,?,?)', [(s, *NAMES[s]) for s in sorted(used_openings)])
    db.executemany(
        'INSERT INTO games (id, event_id, white_id, black_id, white_elo, black_elo, white_title, black_title, elo_avg, result, date, round, eco, opening, plies, twic, moves, white_team, black_team) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        rows,
    )
    issues = [int(re.search(r'twic(\d+)g', f.name).group(1)) for f in files]
    nplayers = len(player_id) + len(kept_players)
    db.executemany('INSERT INTO meta (key, value) VALUES (?, ?)', [
        ('games', str(len(rows))), ('players', str(nplayers)), ('events', str(len(event_id))),
        ('first_issue', str(min(issues))), ('last_issue', str(max(issues))), ('built_at', time.strftime('%Y-%m-%d')),
    ])
    if old:
        # The highest ids ever used, so that ids of rows a later build drops are never given again.
        db.execute('CREATE TABLE id_floor (tbl TEXT PRIMARY KEY, max_id INTEGER NOT NULL)')
        used = {'games': max((r[0] for r in rows), default=0), 'players': max(player_id.values(), default=0), 'events': max(event_id.values(), default=0)}
        db.executemany('INSERT INTO id_floor VALUES (?, ?)', [(t, max(floor[t], used[t])) for t in ('games', 'players', 'events')])
    db.commit()
    db.execute('ANALYZE')
    db.commit()
    db.close()
    engine = sum(1 for k in kind if kind[k] == 'engine')
    online = sum(1 for k in kind if kind[k] == 'online')
    print(
        f'done: {len(files)} issues, {len(rows):,} games, {nplayers:,} players, {len(event_id):,} events '
        f'({engine:,} engine, {online:,} online), {dedupe.copies:,} duplicates, {dedupe.resends:,} re-sent copies with a corrected name '
        f'and {bad:,} invalid games skipped, {dropped:,} ratings above {MAX_ELO} dropped, '
        f'{db_path.stat().st_size / 1e9:.2f} GB, {time.time() - t0:.0f}s',
        file=sys.stderr,
    )
    if old:
        gone = len(old['games']) - len(game_match)
        print(f'--previous: kept the ids of {len(game_match):,} games, {len(player_match):,} players and {len(event_match):,} events; '
              f'new: {len(rows) - len(game_match):,} games, {len(player_id) - len(player_match):,} players, '
              f'{len(event_id) - len(event_match):,} events; {len(kept_players):,} previous players kept without games, '
              f'{len(old["events"]) - len(event_match):,} previous events folded into others (remap_events.py redirects them)', file=sys.stderr)
        if gone:
            print(f'WARNING: {gone:,} games of the previous build are not in this one (changed input or dedup): '
                  'remap_events.py refuses it unless given --drop-missing (then import_pg.py --patch deletes them; '
                  'expected once after the dedup fix of November 2026, a few thousand at most). Do not --reset.', file=sys.stderr)


if __name__ == '__main__':
    main()
