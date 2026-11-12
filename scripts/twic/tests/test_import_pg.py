"""import_pg.py: SQL helpers, and (with TWIC_TEST_DATABASE_URL, a scratch database it may wipe, and psql) a load,
a resume, a refused plain load of another build, and the weekly --patch with an uploaded event in the way.

    TWIC_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/twic_test python3 -m unittest discover -s scripts/twic/tests
"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixtures  # noqa: E402
import import_pg  # noqa: E402

URL = os.environ.get('TWIC_TEST_DATABASE_URL')
BASE = import_pg.UPLOAD_ID_BASE


class Helpers(unittest.TestCase):
    def test_pg_array(self):
        self.assertEqual(import_pg.pg_array([1, None, 'a"b\\c']), '{"1",NULL,"a\\"b\\\\c"}')

    def test_literal(self):
        self.assertEqual(import_pg.literal(None), 'NULL')
        self.assertEqual(import_pg.literal(5), '5')
        self.assertEqual(import_pg.literal("it's"), "$q$it's$q$")
        self.assertEqual(import_pg.literal('$q$'), '$qq$$q$$qq$')

    def test_libpq_env(self):
        env = import_pg.libpq_env('postgresql://cm_owner:p%40ss@db.example:6432/cm_games?sslmode=require')
        self.assertEqual(env, {'PGHOST': 'db.example', 'PGPORT': '6432', 'PGUSER': 'cm_owner', 'PGPASSWORD': 'p@ss',
                               'PGDATABASE': 'cm_games', 'PGSSLMODE': 'require'})

    def test_meta_is_copied_last(self):
        self.assertEqual(list(import_pg.TABLES)[-1], 'meta')
        self.assertEqual(import_pg.TABLES['changed_games'][1], import_pg.TABLES['games'][1])


@unittest.skipUnless(URL and shutil.which('psql'), 'set TWIC_TEST_DATABASE_URL (a scratch database) and install psql')
class Import(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        one, two = cls.tmp / 'one', cls.tmp / 'two'
        one.mkdir()
        two.mkdir()
        for d in (one, two):
            fixtures.write_issue(d, 1001, fixtures.ISSUE_1001)
        fixtures.write_issue(two, 1002, fixtures.ISSUE_1002)
        cls.b1, cls.b2, cls.plain2 = cls.tmp / 'b1.sqlite', cls.tmp / 'b2.sqlite', cls.tmp / 'plain2.sqlite'
        fixtures.build(one, cls.b1)
        fixtures.build(two, cls.b2, '--previous', cls.b1)
        fixtures.build(two, cls.plain2)
        r = fixtures.remap(cls.b1, cls.b2)
        assert r.returncode == 0, r.stderr
        cls.db = import_pg.Psql(URL)
        cls.db.run('DROP TABLE IF EXISTS games, players, events, openings, meta, event_redirects, patch_games, patch_events, patch_players, patch_gone')

    @classmethod
    def tearDownClass(cls):
        cls.db.run('DROP TABLE IF EXISTS games, players, events, openings, meta, event_redirects, patch_games, patch_events, patch_players, patch_gone')
        shutil.rmtree(cls.tmp)

    def load(self, build, *flags):
        return subprocess.run([sys.executable, str(fixtures.TWIC / 'import_pg.py'), '--db', str(build), '--grants', '', *flags],
                              capture_output=True, text=True, env={**os.environ, 'DATABASE_URL': URL})

    def q(self, sql):
        return [tuple(r.values()) for r in self.db(sql)['rows']]

    def same_as(self, build, table, cols):
        mine = {tuple('' if v is None else str(v) for v in r) for r in sqlite3.connect(build).execute(f'SELECT {cols} FROM {table}')}
        theirs = set(self.q(f'SELECT {cols} FROM {table} WHERE id < {BASE}'))
        self.assertEqual(theirs, mine, table)

    def test_load_resume_refuse_patch(self):
        r = self.load(self.b1, '--reset')
        self.assertEqual(r.returncode, 0, r.stderr)
        games = [c for c, _ in import_pg.TABLES['games'][1]]
        self.same_as(self.b1, 'games', ', '.join(games))
        # a rerun of the same build resumes and changes nothing
        r = self.load(self.b1)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.same_as(self.b1, 'games', ', '.join(games))

        # an uploaded tournament holding the slugs the new issue's event and player take, and a leftover staging row
        gamma = sqlite3.connect(self.b2).execute("SELECT slug FROM events WHERE name = 'Gamma Open'").fetchone()[0]
        nina = sqlite3.connect(self.b2).execute("SELECT slug FROM players WHERE name LIKE 'Nina%'").fetchone()[0]
        self.db(f"INSERT INTO events (id, name, slug, games) VALUES ({BASE}, 'Uploaded', $1, 1)", [gamma])
        self.db(f"INSERT INTO players (id, name, slug, search, games) VALUES ({BASE}, 'Nina Newcomer', $1, 'x', 1)", [nina])
        self.db('CREATE TABLE patch_games (LIKE games INCLUDING ALL)')
        self.db("INSERT INTO patch_games SELECT * FROM games WHERE id = 1")
        self.db("UPDATE patch_games SET white_team = 'Stale'")

        # a plain load of another numbering (or of the next build) is refused before anything is written
        meta = self.q("SELECT value FROM meta WHERE key = 'games'")
        for other in (self.plain2, self.b2):
            r = self.load(other)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('another build', r.stderr)
        self.assertEqual(self.q("SELECT value FROM meta WHERE key = 'games'"), meta)
        # --patch of a build that renumbered is refused too
        shifted = self.tmp / 'shifted.sqlite'
        shutil.copy(self.plain2, shifted)
        with sqlite3.connect(shifted) as s:
            s.execute('CREATE TABLE changed_games AS SELECT * FROM games WHERE 0')
        r = self.load(shifted, '--patch')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('other games or players', r.stderr)

        # the weekly update
        for _ in range(2):  # and a rerun changes nothing
            r = self.load(self.b2, '--patch')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.same_as(self.b2, 'games', ', '.join(games))
            self.same_as(self.b2, 'players', ', '.join(c for c, _ in import_pg.TABLES['players'][1]))
            self.same_as(self.b2, 'events', ', '.join(c for c, _ in import_pg.TABLES['events'][1]))
            self.assertEqual(self.q(f'SELECT slug FROM events WHERE id = {BASE}'), [(f'{gamma}-u1',)])
            self.assertEqual(self.q(f'SELECT slug FROM players WHERE id = {BASE}'), [(f'{nina}-u1',)])
            self.assertEqual(self.q("SELECT value FROM meta WHERE key = 'games'"), [('10',)])  # 5 + 6, one of them a copy
            self.assertEqual(self.q("SELECT COUNT(*) FROM games WHERE white_team = 'Stale'"), [('0',)])
            self.assertEqual(self.q("SELECT COUNT(*) FROM pg_tables WHERE tablename LIKE 'patch_%'"), [('0',)])
        # and afterwards a plain rerun of that build is a resume again
        r = self.load(self.b2)
        self.assertEqual(r.returncode, 0, r.stderr)

        # a build that no longer has an old game (a stricter dedup): remap_events.py --drop-missing, then --patch deletes it
        b3 = self.tmp / 'b3.sqlite'
        shutil.copy(self.b2, b3)
        with sqlite3.connect(b3) as s:
            s.execute('DELETE FROM games WHERE id = 3')
        r = fixtures.remap(self.b2, b3, '--drop-missing')
        self.assertEqual(r.returncode, 0, r.stderr)
        for _ in range(2):
            r = self.load(b3, '--patch')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.same_as(b3, 'games', ', '.join(games))

        # --reset also empties event_redirects (they point at event ids the reload renumbers)
        self.db("INSERT INTO event_redirects VALUES ('old-slug', 1) ON CONFLICT DO NOTHING")
        r = self.load(self.b1, '--reset')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.q('SELECT COUNT(*) FROM event_redirects'), [('0',)])


if __name__ == '__main__':
    unittest.main()
