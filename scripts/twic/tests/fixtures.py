"""Tiny TWIC issues for the importer tests: PGN zips written into a temporary directory, built with build.py."""
import random
import subprocess
import sys
import zipfile
from pathlib import Path

import chess

TWIC = Path(__file__).resolve().parents[1]


def moves(seed, plies=30):
    """A legal game of `plies` half-moves (random but fixed by the seed), as PGN movetext."""
    rng = random.Random(seed)
    board, out = chess.Board(), []
    while len(out) < plies:
        legal = list(board.legal_moves)
        if not legal or board.is_game_over():
            board, out = chess.Board(), []  # start again: a different game of the same seed
            continue
        move = rng.choice(legal)
        if board.turn == chess.WHITE:
            out.append(f'{board.fullmove_number}.')
        out.append(board.san(move))
        board.push(move)
    return ' '.join(out)


def pgn(event, date, rnd, white, black, result, seed, site='Somewhere NOR', plies=30, **tags):
    head = {'Event': event, 'Site': site, 'Date': date, 'Round': rnd, 'White': white, 'Black': black, 'Result': result, **tags}
    return ''.join(f'[{k} "{v}"]\n' for k, v in head.items()) + '\n' + moves(seed, plies) + f' {result}\n\n'


def write_issue(directory, n, games):
    with zipfile.ZipFile(Path(directory) / f'twic{n}g.zip', 'w') as z:
        z.writestr(f'twic{n}.pgn', ''.join(games).encode('latin-1'))


def write_fide(path, players):
    """A players_list.zip in FIDE's fixed-width layout: players = [(id, 'Surname, Given', fed, title, born)]."""
    cols = [('ID Number', 15), ('Name', 61), ('Fed', 4), ('Sex', 4), ('Tit', 5), ('WTit', 5), ('OTit', 15), ('B-day', 6), ('Flag', 4)]
    line = lambda values: ''.join(str(v).ljust(w) for v, (_, w) in zip(values, cols))
    text = line([c for c, _ in cols]) + '\n' + ''.join(line([i, name, fed, 'M', tit or '', '', '', born, '']) + '\n'
                                                       for i, name, fed, tit, born in players)
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('players_list_foa.txt', text.encode('latin-1'))


def build(directory, out, *args):
    r = subprocess.run([sys.executable, str(TWIC / 'build.py'), '--dir', str(directory), '--out', str(out), *map(str, args)],
                       capture_output=True, text=True)
    if r.returncode:
        raise AssertionError(f'build.py failed:\n{r.stderr}')
    return r.stderr


def remap(old, new, *args):
    return subprocess.run([sys.executable, str(TWIC / 'remap_events.py'), '--old', str(old), '--new', str(new), *args],
                          capture_output=True, text=True)


# Two issues. 1002 continues Alpha Open (round 3, a new player), re-sends a game of 1001 with a board number in its
# Round tag, starts Gamma Open with a game dated before everything in 1001 (that used to shift every id), and has a
# TCEC game and an online event.
FIDE = [(1503014, 'Carlsen, Magnus', 'NOR', 'GM', 1990), (2004887, 'So, Wesley', 'USA', 'GM', 1993),
        (2020009, 'Caruana, Fabiano', 'USA', 'GM', 1992), (13401319, 'Nepomniachtchi, Ian', 'FID', 'GM', 1990)]
P = {
    'carlsen': dict(name='Carlsen,M', fide=1503014), 'so': dict(name='So,W', fide=2004887),
    'caruana': dict(name='Caruana,F', fide=2020009), 'nepo': dict(name='Nepomniachtchi,I', fide=13401319),
    'olsen': dict(name='Olsen,Kari', fide=None), 'hansen': dict(name='Hansen,Per', fide=None),
}


def g(event, date, rnd, w, b, result, seed, welo=2700, belo=2700, **kw):
    tags = {'WhiteElo': welo, 'BlackElo': belo}
    if P[w]['fide']:
        tags['WhiteFideId'] = P[w]['fide']
    if P[b]['fide']:
        tags['BlackFideId'] = P[b]['fide']
    return pgn(event, date, rnd, P[w]['name'], P[b]['name'], result, seed, **tags, **kw)


ISSUE_1001 = [
    g('Alpha Open 2026', '2026.01.05', '1', 'carlsen', 'so', '1-0', 1),
    g('Alpha Open 2026', '2026.01.05', '1', 'caruana', 'nepo', '1/2-1/2', 2),
    g('Alpha Open 2026', '2026.01.06', '2', 'so', 'caruana', '0-1', 3),
    g('Alpha Open 2026', '2026.01.06', '2', 'nepo', 'carlsen', '1/2-1/2', 4, belo=204269),  # a typo
    g('Beta Cup', '2026.01.07', '1', 'olsen', 'hansen', '1-0', 5, welo=1900, belo=1850),
]
ISSUE_1002 = [
    g('Alpha Open 2026', '2026.01.07', '3', 'carlsen', 'caruana', '1/2-1/2', 6),
    pgn('Alpha Open 2026', '2026.01.07', '3', 'Newcomer,Nina', 'Nepomniachtchi,I', '0-1', 7, WhiteElo=2400, BlackElo=2750,
        BlackFideId=13401319),
    g('Alpha Open 2026', '2026.01.05', '1.2', 'caruana', 'nepo', '1/2-1/2', 2),  # re-sent with the board number
    g('Gamma Open', '2025.12.20', '1', 'olsen', 'hansen', '0-1', 8, welo=1900, belo=1850),  # dated before issue 1001
    pgn('TCEC Season 99', '2026.01.08', '1', 'Stockfish 18', 'LCZero 0.40', '1/2-1/2', 9, WhiteElo=3650, BlackElo=3640),
    pgn('Titled Tue 6th Jan 2026', '2026.01.06', '1', 'Carlsen,M', 'So,W', '1-0', 10, site='chess.com INT',
        WhiteElo=2830, BlackElo=2760, WhiteFideId=1503014, BlackFideId=2004887),
]
