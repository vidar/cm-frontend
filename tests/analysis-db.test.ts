// Integration tests for the claim logic of on-demand engine analysis (queueAnalysis/getAnalysis in
// src/lib/analysis.ts) and AI notes (createAnnotation in src/lib/annotate.ts): a game that doesn't exist,
// an engine that can't be reached, a row left queued by an interrupted submit, the daily limits, and the
// retry pause after a failed annotation. No engine or model is ever called: ENGINE_URL points at a closed
// port, and the annotated game has no analysis, so generate() stops before the API call.
// Needs the local Postgres copy (tests/db.ts; skips itself without it). Writes only game_analysis and
// game_annotation rows, for games that had none and for ids above any real game, and removes them in afterAll.
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAILY_LIMIT as ENGINE_DAILY_LIMIT, getAnalysis, queueAnalysis } from '../src/lib/analysis';
import { createAnnotation, DAILY_LIMIT as AI_DAILY_LIMIT, getAnnotation } from '../src/lib/annotate';
import { query } from '../src/lib/games';
import { dbAvailable } from './db';

const vars = env as unknown as Record<string, string | undefined>;
const saved = { ENGINE_URL: vars.ENGINE_URL, STOCKFISH_TOKEN: vars.STOCKFISH_TOKEN, ANTHROPIC_KEY: vars.ANTHROPIC_KEY };
/** Ids no game has (int4 still holds them): filler rows for the daily-limit tests. */
const FAKE = 2_100_000_000;
/** Real games without analyses or notes, picked in beforeAll. */
let ids: number[] = [];

const analysisRow = async (id: number) =>
  (await query<{ status: string; job_id: string | null; error: string | null; requested_at: string }>('SELECT status, job_id, error, requested_at::text AS requested_at FROM game_analysis WHERE game_id = $1', [id]))[0] ?? null;
const annotationRow = async (id: number) =>
  (await query<{ status: string; error: string | null; requested_at: string }>('SELECT status, error, requested_at::text AS requested_at FROM game_annotation WHERE game_id = $1', [id]))[0] ?? null;
const cleanup = async () => {
  if (!ids.length) return;
  const list = `{${ids.join(',')}}`;
  await query('DELETE FROM game_analysis WHERE game_id = ANY($1::int[]) OR game_id >= $2', [list, FAKE]);
  await query('DELETE FROM game_annotation WHERE game_id = ANY($1::int[]) OR game_id >= $2', [list, FAKE]);
};

describe.skipIf(!(await dbAvailable()))('engine analysis and AI notes against the database', () => {
  beforeAll(async () => {
    // A closed local port: every engine call fails at once, as when the VPS is down.
    vars.ENGINE_URL = 'http://127.0.0.1:9';
    vars.STOCKFISH_TOKEN = 'test-token';
    vars.ANTHROPIC_KEY = 'test-key';
    ids = (
      await query<{ id: number }>(
        `SELECT id FROM games g WHERE id < 100000000
           AND NOT EXISTS (SELECT 1 FROM game_analysis a WHERE a.game_id = g.id)
           AND NOT EXISTS (SELECT 1 FROM game_annotation n WHERE n.game_id = g.id)
         ORDER BY id LIMIT 4`,
      )
    ).map((r) => r.id);
    expect(ids).toHaveLength(4);
  });

  afterAll(async () => {
    await cleanup();
    Object.assign(vars, saved);
  });

  describe('queueAnalysis', () => {
    it('refuses a game that does not exist, without writing a row', async () => {
      expect(await queueAnalysis(FAKE + 999_999)).toEqual({ refused: 'No such game.', code: 404 });
      expect(await analysisRow(FAKE + 999_999)).toBeNull();
    });

    it('marks the row failed when the engine cannot be reached (it does not stay queued)', async () => {
      expect(await queueAnalysis(ids[0])).toEqual({ status: 'failed', error: 'engine unreachable' });
      expect(await analysisRow(ids[0])).toMatchObject({ status: 'failed', job_id: null, error: 'engine unreachable' });
      expect(await getAnalysis(ids[0])).toEqual({ status: 'failed', error: 'engine unreachable' });
    });

    it('lets a failed analysis be queued again', async () => {
      const before = (await analysisRow(ids[0]))!.requested_at;
      expect(await queueAnalysis(ids[0])).toEqual({ status: 'failed', error: 'engine unreachable' });
      expect((await analysisRow(ids[0]))!.requested_at).not.toBe(before);
    });

    it('shows a fresh queued row without a job as queued, and does not submit it twice', async () => {
      await query(`INSERT INTO game_analysis (game_id, status) VALUES ($1, 'queued')`, [ids[1]]);
      expect(await getAnalysis(ids[1])).toEqual({ status: 'queued', done: 0, total: 0 });
      expect(await queueAnalysis(ids[1])).toEqual({ status: 'queued', done: 0, total: 0 });
      expect(await analysisRow(ids[1])).toMatchObject({ status: 'queued', job_id: null, error: null });
    });

    it('treats a queued row whose submit never finished as interrupted, and reclaims it', async () => {
      await query(`UPDATE game_analysis SET updated_at = now() - interval '6 minutes' WHERE game_id = $1`, [ids[1]]);
      expect(await getAnalysis(ids[1])).toEqual({ status: 'failed', error: 'interrupted' });
      expect(await queueAnalysis(ids[1])).toEqual({ status: 'failed', error: 'engine unreachable' });
      expect(await analysisRow(ids[1])).toMatchObject({ status: 'failed', error: 'engine unreachable' });
    });

    it('refuses new games once the site-wide daily limit is reached', async () => {
      await query(`INSERT INTO game_analysis (game_id, status, error) SELECT $1::int + i, 'failed', 'filler' FROM generate_series(1, $2::int) AS i`, [FAKE, ENGINE_DAILY_LIMIT]);
      expect(await queueAnalysis(ids[2])).toEqual({ refused: 'The daily limit for engine analysis is reached. Please try again tomorrow.', code: 503 });
      expect(await analysisRow(ids[2])).toBeNull();
      await query('DELETE FROM game_analysis WHERE game_id >= $1', [FAKE]);
    });
  });

  describe('createAnnotation', () => {
    it('claims the row and records the failure on that same run', async () => {
      // No analysis for this game, so generate() gives up before calling the model.
      expect(await createAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
      expect(await annotationRow(ids[3])).toMatchObject({ status: 'failed', error: 'the game has no engine analysis yet' });
    });

    it('pauses retries of a failed annotation (each attempt is a paid call)', async () => {
      const before = (await annotationRow(ids[3]))!.requested_at;
      expect(await createAnnotation(ids[3])).toEqual({ refused: 'Writing the notes failed a moment ago. Please try again in a few minutes.', code: 429 });
      expect((await annotationRow(ids[3]))!.requested_at).toBe(before);
      await query(`UPDATE game_annotation SET updated_at = now() - interval '11 minutes' WHERE game_id = $1`, [ids[3]]);
      expect(await createAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
      expect((await annotationRow(ids[3]))!.requested_at).not.toBe(before);
    });

    it('does not take over a run that is still going, but reclaims one left running too long', async () => {
      await query(`UPDATE game_annotation SET status = 'running', error = NULL, updated_at = now() WHERE game_id = $1`, [ids[3]]);
      expect(await createAnnotation(ids[3])).toEqual({ status: 'running' });
      await query(`UPDATE game_annotation SET updated_at = now() - interval '6 minutes' WHERE game_id = $1`, [ids[3]]);
      expect(await getAnnotation(ids[3])).toEqual({ status: 'failed', error: 'interrupted' });
      expect(await createAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
    });

    it('refuses once the daily budget is used, also for parallel requests', async () => {
      // With the row of ids[3] from the tests above, two slots are left; five requests at once: the lock lets exactly two claim.
      await query(`INSERT INTO game_annotation (game_id, status) SELECT $1::int + i, 'done' FROM generate_series(1, $2::int - 3) AS i`, [FAKE, AI_DAILY_LIMIT]);
      const results = await Promise.all([ids[0], ids[1], ids[2], FAKE + 500_001, FAKE + 500_002].map((id) => createAnnotation(id)));
      const refused = results.filter((r) => 'refused' in r);
      expect(refused).toHaveLength(3);
      for (const r of refused) expect(r).toEqual({ refused: 'The daily limit for AI notes is reached. Please try again tomorrow.', code: 503 });
      const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM game_annotation WHERE requested_at > now() - interval '1 day'`);
      expect(Number(n)).toBe(AI_DAILY_LIMIT);
    });
  });
});
