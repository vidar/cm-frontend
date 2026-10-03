#!/usr/bin/env python3
"""Extract Stockfish evaluations for every named opening position from the Lichess
evaluations database (CC0, ~22 GB compressed, 400M+ positions), streamed once.

Usage:
  pip install zstandard
  node scripts/opening-fens.mjs > /tmp/opening-fens.json
  python3 scripts/opening-evals.py --fens /tmp/opening-fens.json

Writes src/data/opening-evals.json keyed by the line's SAN moves joined with spaces:
{"cp" | "mate", "depth", "pv": [first 8 moves in UCI]} from the deepest evaluation.
"""
import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import zstandard

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://database.lichess.org/lichess_db_eval.jsonl.zst'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fens', required=True)
    ap.add_argument('--out', default=str(ROOT / 'src/data/opening-evals.json'))
    args = ap.parse_args()

    # The dump's FENs have 4 fields; it may omit an en-passant square that chess.js includes, so index both.
    wanted = {}
    for key, fen in json.load(open(args.fens)).items():
        f = fen.split(' ')[:4]
        wanted.setdefault(' '.join(f).encode(), []).append(key)
        if f[3] != '-':
            wanted.setdefault(' '.join(f[:3] + ['-']).encode(), []).append(key)

    raw = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'chessmoments-evals/1.0'}), timeout=120)
    lines = io.BufferedReader(zstandard.ZstdDecompressor().stream_reader(raw), buffer_size=1 << 20)
    found = {}
    t0 = time.time()
    for i, line in enumerate(lines):
        if i % 20_000_000 == 0 and i:
            print(f'{i:,} positions scanned, {len(found)} found, {time.time() - t0:.0f}s', file=sys.stderr, flush=True)
        fen = line[8 : line.index(b'"', 8)]  # line starts with {"fen":"
        keys = wanted.get(fen)
        if not keys:
            continue
        rec = json.loads(line)
        best = max(rec['evals'], key=lambda e: e['depth'])
        pv = best['pvs'][0]
        value = {'cp': pv.get('cp'), 'mate': pv.get('mate'), 'depth': best['depth'], 'pv': pv['line'].split(' ')[:8]}
        for k in keys:
            # Prefer the exact FEN match (with en passant square) if both occur.
            if k not in found or fen.split(b' ')[3] != b'-':
                found[k] = value

    Path(args.out).write_text(json.dumps({'source': 'Lichess evaluations database (CC0)', 'evals': found}, separators=(',', ':')))
    print(f'done: {i + 1:,} positions scanned, {len(found)} of {len(json.load(open(args.fens)))} lines found, {time.time() - t0:.0f}s', file=sys.stderr)


if __name__ == '__main__':
    main()
