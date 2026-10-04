#!/usr/bin/env python3
"""Download TWIC PGN issues (The Week in Chess, (c) Mark Crowther; used with permission).

Fetches https://theweekinchess.com/zips/twic<N>g.zip for a range of issues into a local cache
directory, politely (one request at a time, a pause between requests), skipping files already
present. PGN zips exist from issue 920 onwards.

Usage: python3 scripts/twic/download.py --from 920 --to 1664 --dir /path/to/cache
"""
import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

UA = 'chessmoments-import/1.0 (+https://chessmoments.com; contact vidar.masson@gmail.com)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='start', type=int, default=920)
    ap.add_argument('--to', dest='end', type=int, required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--pause', type=float, default=2.0, help='seconds between requests')
    args = ap.parse_args()
    out = Path(args.dir)
    out.mkdir(parents=True, exist_ok=True)
    for n in range(args.start, args.end + 1):
        dest = out / f'twic{n}g.zip'
        if dest.exists() and dest.stat().st_size > 0:
            continue
        url = f'https://theweekinchess.com/zips/twic{n}g.zip'
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=120) as r:
                    data = r.read()
                tmp = dest.with_suffix('.part')
                tmp.write_bytes(data)
                tmp.rename(dest)
                print(f'{n}: {len(data):,} bytes', file=sys.stderr, flush=True)
                break
            except urllib.error.HTTPError as e:
                print(f'{n}: HTTP {e.code}', file=sys.stderr, flush=True)
                break
            except Exception as e:  # network hiccup: back off and retry
                print(f'{n}: {e}, retrying', file=sys.stderr, flush=True)
                time.sleep(10 * (attempt + 1))
        time.sleep(args.pause)


if __name__ == '__main__':
    main()
