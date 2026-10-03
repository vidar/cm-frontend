#!/usr/bin/env python3
"""Compute per-opening statistics from a sample of the Lichess open database (CC0).

Streams a monthly rated-games file, follows each game through the named lines in
src/data/openings/*.tsv (exact move order, no transpositions) and writes
src/data/opening-stats.json, keyed by the line's SAN moves joined with spaces.

Usage:
  pip install zstandard
  python3 scripts/opening-stats.py --month 2026-09 --games 10000000

Only blitz and slower games (base time >= 3 min) between humans (no BOT accounts) with both
ratings are counted.
"""
import argparse
import heapq
import io
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parent.parent
BANDS = [(0, 1500), (1500, 2000), (2000, 9999)]  # by average rating of the two players
MOVE_NUM = re.compile(r'^\d+\.+$')
COMMENT = re.compile(r'\{[^}]*\}')
ANNOT = re.compile(r'[?!]+$')
RESULT_IDX = {'1-0': 0, '1/2-1/2': 1, '0-1': 2}


def load_lines():
    keys = set()
    for f in sorted((ROOT / 'src/data/openings').glob('*.tsv')):
        for line in f.read_text().splitlines()[1:]:
            eco, name, pgn = line.split('\t')
            keys.add(' '.join(t for t in pgn.split() if not MOVE_NUM.match(t)))
    prefixes = set()
    for k in keys:
        toks = k.split(' ')
        for i in range(1, len(toks) + 1):
            prefixes.add(' '.join(toks[:i]))
    return keys, prefixes, max(len(k.split(' ')) for k in keys)


def games(stream):
    """Yields (headers, movetext) from a PGN text stream."""
    headers = {}
    for line in stream:
        if line.startswith('['):
            sp = line.find(' ')
            headers[line[1:sp]] = line[sp + 2 : line.rfind('"')]
        elif line.strip() and headers:
            yield headers, line
            headers = {}


def band_of(avg):
    for i, (lo, hi) in enumerate(BANDS):
        if lo <= avg < hi:
            return i
    return len(BANDS) - 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--month', required=True, help='YYYY-MM')
    ap.add_argument('--games', type=int, default=10_000_000, help='games to read (sample size)')
    ap.add_argument('--file', help='local .pgn.zst instead of downloading')
    ap.add_argument('--out', default=str(ROOT / 'src/data/opening-stats.json'))
    args = ap.parse_args()

    keys, prefixes, max_ply = load_lines()
    url = f'https://database.lichess.org/standard/lichess_db_standard_rated_{args.month}.pgn.zst'
    raw = open(args.file, 'rb') if args.file else urllib.request.urlopen(
        urllib.request.Request(url, headers={'User-Agent': 'chessmoments-stats/1.0'}), timeout=120)
    text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(raw), encoding='utf-8', errors='replace')

    stats = {}  # key -> {'n', 'r': [[w,d,b]*bands], 'next': {san: [n,w,d,b]}, 'top': heap}
    read = counted = 0
    t0 = time.time()
    try:
        for h, movetext in games(text):
            read += 1
            if read > args.games:
                break
            if read % 500_000 == 0:
                print(f'{read:,} games, {counted:,} counted, {time.time() - t0:.0f}s', file=sys.stderr)
            res = RESULT_IDX.get(h.get('Result'))
            tc = h.get('TimeControl', '-')
            if res is None or tc == '-' or int(tc.split('+')[0]) < 180:
                continue
            wt, bt = h.get('WhiteTitle', ''), h.get('BlackTitle', '')
            if wt == 'BOT' or bt == 'BOT':
                continue
            try:
                we, be = int(h['WhiteElo']), int(h['BlackElo'])
            except (KeyError, ValueError):
                continue
            toks = [ANNOT.sub('', t) for t in COMMENT.sub('', movetext[:4000]).split() if not MOVE_NUM.match(t)]
            toks = toks[: max_ply + 1]
            avg = (we + be) // 2
            band = band_of(avg)
            counted += 1
            prefix = ''
            for i, san in enumerate(toks[:max_ply]):
                prefix = san if i == 0 else f'{prefix} {san}'
                if prefix not in prefixes:
                    break
                if prefix not in keys:
                    continue
                s = stats.get(prefix)
                if s is None:
                    s = stats[prefix] = {'n': 0, 'r': [[0, 0, 0] for _ in BANDS], 'next': {}, 'top': []}
                s['n'] += 1
                s['r'][band][res] += 1
                if i + 1 < len(toks) and toks[i + 1] not in RESULT_IDX:
                    nx = s['next'].setdefault(toks[i + 1], [0, 0, 0, 0])
                    nx[0] += 1
                    nx[1 + res] += 1
                game = (avg, h.get('Site', ''), h.get('White', ''), we, h.get('Black', ''), be, h.get('Result'), h.get('UTCDate', ''), tc, wt, bt)
                if len(s['top']) < 3:
                    heapq.heappush(s['top'], game)
                elif avg > s['top'][0][0]:
                    heapq.heapreplace(s['top'], game)
    except (zstandard.ZstdError, EOFError) as e:  # truncated local sample
        print(f'stream ended: {e}', file=sys.stderr)

    out = {
        'source': f'Lichess open database, {args.month} (CC0)',
        'sample': {'gamesRead': min(read, args.games), 'gamesCounted': counted, 'minBaseSeconds': 180, 'excludes': 'BOT accounts'},
        'bands': [f'{lo}-{hi - 1}' if hi < 9999 else f'{lo}+' for lo, hi in BANDS],
        'lines': {
            k: {
                'n': s['n'],
                'r': s['r'],
                'next': sorted(([san, *v] for san, v in s['next'].items()), key=lambda x: -x[1])[:8],
                'top': [
                    {'url': g[1], 'white': g[2], 'whiteElo': g[3], 'black': g[4], 'blackElo': g[5], 'result': g[6], 'date': g[7].replace('.', '-'), 'tc': g[8], 'whiteTitle': g[9] or None, 'blackTitle': g[10] or None}
                    for g in sorted(s['top'], reverse=True)
                ],
            }
            for k, s in stats.items()
        },
    }
    Path(args.out).write_text(json.dumps(out, separators=(',', ':')))
    print(f'done: {read:,} read, {counted:,} counted, {len(stats):,}/{len(keys):,} lines seen, {time.time() - t0:.0f}s -> {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
