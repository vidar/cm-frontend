"""build.py and remap_events.py: pure helpers with hand-made fixtures, then two tiny issues built end to end.

    python3 -m unittest discover -s scripts/twic/tests     (needs python-chess)
"""
import collections
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402
import fixtures  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]


class Helpers(unittest.TestCase):
    def test_rating(self):
        self.assertEqual(build.rating('2750'), 2750)
        self.assertEqual(build.rating('3000'), 3000)
        self.assertIsNone(build.rating('3001'))
        self.assertIsNone(build.rating('204269'))
        self.assertIsNone(build.rating('0'))
        self.assertIsNone(build.rating('?'))
        self.assertIsNone(build.rating(None))

    def test_event_kind(self):
        self.assertEqual(build.event_kind('TCEC Season 26 Premier', 'chessdom INT', 10, 0), 'engine')
        self.assertEqual(build.event_kind('CCC 23 Rapid', 'chess.com INT', 10, 0), 'engine')
        self.assertEqual(build.event_kind('Engine Cup', None, 10, 6), 'engine')  # mostly games rated above MAX_ELO
        self.assertEqual(build.event_kind('Titled Tue 1st Sep 2026', 'chess.com INT', 10, 0), 'online')
        self.assertEqual(build.event_kind('Lichess Titled Arena', 'lichess.org INT', 10, 0), 'online')
        self.assertIsNone(build.event_kind('CCCSA Labor Day GM-A 2026', 'Charlotte USA', 10, 0))  # not CCC
        self.assertIsNone(build.event_kind('59th Biel Blitz Open 2026', 'Biel SUI', 10, 4))
        self.assertIsNone(build.event_kind('Tata Steel Masters', 'Wijk aan Zee NED', 10, 0))

    def test_short_names(self):
        self.assertEqual(build.surname_given('So,W'), ('so', 'w'))
        self.assertTrue(build.short_name_match('So,W', ('so', 'wesley')))
        self.assertTrue(build.short_name_match('Li,Di', ('li', 'di')))
        self.assertFalse(build.short_name_match('So,A', ('so', 'wesley')))  # another initial
        self.assertFalse(build.short_name_match('Xu,W', ('so', 'wesley')))  # another surname
        self.assertFalse(build.short_name_match('So', ('so', 'wesley')))  # no initial to compare
        self.assertEqual(build.name_parts('So,W'), set())  # why the fallback exists


def game(white, black, date, rnd, event='Open', result='1-0'):
    return {'White': white, 'Black': black, 'Date': date, 'Round': rnd, 'Event': event, 'Result': result}


LONG = ' '.join(['e4'] * 24)  # moves are only compared, never replayed here


class DedupeTest(unittest.TestCase):
    def test_copy_from_a_later_issue_brings_its_headers(self):
        d = build.Dedupe()
        d.add(1, game('A,B', 'C,D', '2026.01.01', '1'), LONG)
        d.add(2, game('A,B', 'C,D', '2026.01.01', '1.4'), LONG)
        self.assertEqual(len(d.games), 1)
        self.assertEqual(d.copies, 1)
        issue, h, _ = d.games[0]
        self.assertEqual((issue, h['Round']), (1, '1.4'))  # first issue (the credit), corrected Round

    def test_copy_in_the_same_issue_keeps_the_first(self):
        d = build.Dedupe()
        d.add(1, game('A,B', 'C,D', '2026.01.01', '1'), LONG)
        d.add(1, game('A,B', 'C,D', '2026.01.01', '1.4'), LONG)
        self.assertEqual((len(d.games), d.games[0][1]['Round']), (1, '1'))

    def test_resent_with_a_corrected_name(self):
        d = build.Dedupe()
        d.add(1, game('Vojtech,Ladislav', 'C,D', '2026.01.01', '2.3'), LONG)
        d.add(2, game('Vojtech,Ladislav Jr', 'C,D', '2026.01.01', '2.3'), LONG)
        self.assertEqual((len(d.games), d.resends), (1, 1))
        self.assertEqual(d.games[0][0], 1)
        self.assertEqual(d.games[0][1]['White'], 'Vojtech,Ladislav Jr')
        # a third copy under the corrected name is an ordinary copy
        d.add(3, game('Vojtech,Ladislav Jr', 'C,D', '2026.01.01', '2.3'), LONG)
        self.assertEqual((len(d.games), d.copies), (1, 1))

    def test_not_resent(self):
        d = build.Dedupe()
        d.add(1, game('A,B', 'C,D', '2026.01.01', '2.1'), LONG)
        d.add(1, game('E,F', 'C,D', '2026.01.01', '2.2'), LONG)  # same issue: two games
        d.add(2, game('G,H', 'I,J', '2026.01.01', '2.3'), LONG)  # both names differ
        d.add(2, game('A,B', 'X,Y', '2026.01.01', '3.1'), LONG)  # another round
        d.add(2, game('A,B', 'Q,R', '2026.01.01', '2.1', result='0-1'), LONG)  # another result
        short = ' '.join(['e4'] * (build.RESENT_MIN_PLIES - 1))
        d.add(1, game('A,B', 'C,D', '2026.01.01', '4.1'), short)
        d.add(2, game('A,B', 'Z,Z', '2026.01.01', '4.1'), short)  # too short to tell
        self.assertEqual(len(d.games), 7)
        self.assertEqual(d.copies + d.resends, 0)


class MatchTest(unittest.TestCase):
    def test_games_and_players(self):
        # previous: (id, game_key, white_id, black_id, date, result, event_id)
        prev = [(1, 'k1', 10, 11, '2026-01-01', '1-0', 1), (2, 'k2', 11, 12, '2026-01-02', '0-1', 1),
                (3, 'k3', 12, 10, '2026-01-02', '1-0', 1), (4, 'k3', 13, 10, '2026-01-02', '1-0', 1)]
        # new: (game_key, white key, black key, date, result); k3 occurs twice (same issue and moves)
        new = [('k3', 'f3', 'f1', '2026-01-02', '1-0'), ('k1', 'f1', 'nb', '2026-01-01', '1-0'),
               ('k2', 'nb', 'f3', '2026-01-02', '0-1'), ('k3', 'nd', 'f1', '2026-01-02', '1-0'),
               ('k9', 'f1', 'f5', '2026-01-09', '1-0')]
        games, players = build.match_previous(prev, new, ['f1', 'nb', 'f3', 'nd', 'f5'], {1: 99, 5: 15})
        # nd only plays in k3, which occurs twice: no vote, and no FIDE ID; f5 is new here but had a FIDE row before
        self.assertEqual(players, {'f1': 10, 'nb': 11, 'f3': 12, 'f5': 15})
        self.assertEqual({i: r[0] for i, r in games.items()}, {0: 3, 1: 1, 2: 2, 3: 4})

    def test_fide_fallback(self):
        prev = [(1, 'k1', 10, 11, None, '1-0', 1), (2, 'k1', 11, 10, None, '1-0', 1)]
        new = [('k1', 'f7', 'f8', None, '1-0'), ('k1', 'f8', 'f7', None, '1-0')]
        games, players = build.match_previous(prev, new, ['f7', 'f8'], {7: 10, 8: 11})
        self.assertEqual(players, {'f7': 10, 'f8': 11})
        self.assertEqual({i: r[0] for i, r in games.items()}, {0: 1, 1: 2})

    def test_events(self):
        overlap = {('Open', 0): collections.Counter({5: 10, 6: 3}), ('Open', 1): collections.Counter({6: 4}),
                   ('Cup', 0): collections.Counter()}
        prev_slugs = {5: 'open-2026', 6: 'open-2026-2'}
        got = build.match_events([(('Open', 0), 'open-2026', 13), (('Open', 1), 'open-2026', 4), (('Cup', 0), 'cup-2026', 2)],
                                 overlap, prev_slugs)
        self.assertEqual(got, {('Open', 0): 5, ('Open', 1): 6})


def rows(path, table, cols='*', where=''):
    db = sqlite3.connect(path)
    out = {r[0]: r for r in db.execute(f'SELECT {cols} FROM {table} {where} ORDER BY 1')}
    db.close()
    return out


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        one, two = cls.tmp / 'one', cls.tmp / 'two'
        one.mkdir()
        two.mkdir()
        for d in (one, two):
            fixtures.write_issue(d, 1001, fixtures.ISSUE_1001)
        fixtures.write_issue(two, 1002, fixtures.ISSUE_1002)
        cls.fide = cls.tmp / 'players_list.zip'
        fixtures.write_fide(cls.fide, fixtures.FIDE)
        cls.b1, cls.b2, cls.plain2 = cls.tmp / 'b1.sqlite', cls.tmp / 'b2.sqlite', cls.tmp / 'plain2.sqlite'
        fixtures.build(one, cls.b1, '--fide', cls.fide)
        cls.log2 = fixtures.build(two, cls.b2, '--fide', cls.fide, '--previous', cls.b1)
        fixtures.build(two, cls.plain2, '--fide', cls.fide)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_previous_ids_and_slugs_stay(self):
        old_games, new_games = rows(self.b1, 'games', 'id, twic, moves, white_id, black_id, event_id'), rows(self.b2, 'games', 'id, twic, moves, white_id, black_id, event_id')
        for gid, r in old_games.items():
            self.assertEqual(new_games[gid], r)
        old_players, new_players = rows(self.b1, 'players', 'id, slug'), rows(self.b2, 'players', 'id, slug')
        for pid, r in old_players.items():
            self.assertEqual(new_players[pid], r)
        old_events, new_events = rows(self.b1, 'events', 'id, slug'), rows(self.b2, 'events', 'id, slug')
        for eid, r in old_events.items():
            self.assertEqual(new_events[eid], r)
        # new rows only after the old ones, the early Gamma Open game included
        self.assertEqual(min(set(new_games) - set(old_games)), max(old_games) + 1)
        self.assertEqual(min(set(new_players) - set(old_players)), max(old_players) + 1)
        self.assertEqual(min(set(new_events) - set(old_events)), max(old_events) + 1)
        gamma = rows(self.b2, 'games', 'g.id', "g JOIN events e ON e.id = g.event_id WHERE e.name = 'Gamma Open'")
        self.assertGreater(min(gamma), max(old_games))
        # ...where a plain build numbers it first and shifts the others
        self.assertEqual(list(rows(self.plain2, 'games', 'g.id', "g JOIN events e ON e.id = g.event_id WHERE e.name = 'Gamma Open'")), [1])
        floor = dict(sqlite3.connect(self.b2).execute('SELECT tbl, max_id FROM id_floor'))
        self.assertEqual(floor['games'], max(new_games))

    def test_previous_of_itself_changes_nothing(self):
        again = self.tmp / 'again.sqlite'
        fixtures.build(self.tmp / 'two', again, '--fide', self.fide, '--previous', self.b2)
        for table in ('games', 'players', 'events'):
            self.assertEqual(rows(again, table), rows(self.b2, table))

    def test_without_previous_ids_are_as_before(self):
        self.assertFalse(sqlite3.connect(self.plain2).execute("SELECT 1 FROM sqlite_master WHERE name = 'id_floor'").fetchone())
        self.assertEqual(sorted(rows(self.plain2, 'games')), list(range(1, 11)))

    def test_short_name_gets_its_fide_identity(self):
        so = [r for r in rows(self.b1, 'players').values() if r[1] == 2004887]
        self.assertEqual(len(so), 1)
        self.assertEqual((so[0][2], so[0][6]), ('Wesley So', 'USA'))

    def test_ratings_and_engines(self):
        db = sqlite3.connect(self.b2)
        typo = db.execute("SELECT black_elo, elo_avg FROM games WHERE white_elo = 2700 AND black_elo IS NULL").fetchall()
        self.assertEqual(typo, [(None, None)])
        engine = db.execute("SELECT g.white_elo, g.black_elo, g.elo_avg, e.kind FROM games g JOIN events e ON e.id = g.event_id "
                            "WHERE e.name LIKE 'TCEC%'").fetchall()
        self.assertEqual(engine, [(None, None, None, 'engine')])
        kinds = dict(db.execute('SELECT name, kind FROM events'))
        self.assertEqual(kinds['Titled Tue 6th Jan 2026'], 'online')
        self.assertIsNone(kinds['Alpha Open 2026'])
        self.assertEqual(db.execute('SELECT MAX(max_elo) FROM players').fetchone()[0], 2830)

    def test_resent_game_takes_the_board_number(self):
        db = sqlite3.connect(self.b2)
        self.assertEqual(db.execute("SELECT twic, round FROM games WHERE round LIKE '1.2'").fetchall(), [(1001, '1.2')])

    def test_remap_accepts_previous_build_and_lists_changes(self):
        new = self.tmp / 'remapped.sqlite'
        shutil.copy(self.b2, new)
        r = fixtures.remap(self.b1, new)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(rows(new, 'events', 'id, slug'), rows(self.b2, 'events', 'id, slug'))  # nothing to remap
        changed = rows(new, 'changed_games')
        old = rows(self.b1, 'games')
        self.assertTrue(changed)
        self.assertTrue(set(changed) <= set(old))
        self.assertIn('1.2', {r[11] for r in changed.values()})  # the corrected Round tag
        cols = [c[1] for c in sqlite3.connect(new).execute('PRAGMA table_info(changed_games)')]
        self.assertEqual(cols, [c[1] for c in sqlite3.connect(new).execute('PRAGMA table_info(games)')])

    def test_remap_drop_missing(self):
        new = self.tmp / 'dropped.sqlite'
        shutil.copy(self.b2, new)
        with sqlite3.connect(new) as db:
            db.execute('DELETE FROM games WHERE id = 2')  # as if a stricter build dropped it
        r = fixtures.remap(self.b1, new)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('1 old games missing', r.stderr)
        r = fixtures.remap(self.b1, new, '--drop-missing')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(list(rows(new, 'gone_games')), [2])

    def test_remap_refuses_shifted_ids(self):
        new = self.tmp / 'shifted.sqlite'
        shutil.copy(self.plain2, new)
        r = fixtures.remap(self.b1, new)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('ids differ', r.stderr)


class UploadIdBase(unittest.TestCase):
    def test_same_as_uploads_ts(self):
        ts = (ROOT / 'src/lib/uploads.ts').read_text()
        value = int(re.search(r'export const UPLOAD_ID_BASE = ([\d_]+);', ts).group(1).replace('_', ''))
        py = (Path(build.__file__).parent / 'import_pg.py').read_text()
        self.assertEqual(int(re.search(r'^UPLOAD_ID_BASE = ([\d_]+)', py, re.M).group(1).replace('_', '')), value)


if __name__ == '__main__':
    unittest.main()
