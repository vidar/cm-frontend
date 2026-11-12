// Integration tests for the claim logic of on-demand engine analysis (queueAnalysis/getAnalysis in
// src/lib/analysis.ts) and AI notes (createAnnotation in src/lib/annotate.ts): a game that doesn't exist,
// an engine that can't be reached, a row left queued by an interrupted submit, the daily limits, and the
// retry pause after a failed annotation, the per-client daily limits, an engine job the engine stops answering
// for, and an AI outage (nothing stored). No engine or model is ever called: ENGINE_URL and the Anthropic
// base URL point at a closed port, and most annotated games have no analysis, so generate() stops before the call.
// Needs a test database with at least five games (tests/db.ts; skips itself without one). Writes only game_analysis
// and game_annotation rows, for games that had none and for ids FAKE..FAKE_END that no game has, and removes them in
// afterAll. Those ids are below UPLOAD_ID_BASE (and far above any TWIC id), so the upload tests, which check and drop
// rows of uploaded ids without a game, never see them.
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_DAILY_LIMIT as ENGINE_CLIENT_LIMIT, DAILY_LIMIT as ENGINE_DAILY_LIMIT, getAnalysis, queueAnalysis, requesterId } from '../src/lib/analysis';
import { CLIENT_DAILY_LIMIT as AI_CLIENT_LIMIT, createAnnotation, DAILY_LIMIT as AI_DAILY_LIMIT, getAnnotation, UNAVAILABLE } from '../src/lib/annotate';
import { query } from '../src/lib/games';
import { UPLOAD_ID_BASE } from '../src/lib/uploads';
import { writableDbAvailable } from './db';

const vars = env as unknown as Record<string, string | undefined>;
const saved = { ENGINE_URL: vars.ENGINE_URL, STOCKFISH_TOKEN: vars.STOCKFISH_TOKEN, ANTHROPIC_KEY: vars.ANTHROPIC_KEY };
const savedBase = process.env.ANTHROPIC_BASE_URL;
/** Ids no game has, between the TWIC ids (a few million) and UPLOAD_ID_BASE: filler rows for the daily-limit tests. */
const FAKE = UPLOAD_ID_BASE - 10_000_000;
const FAKE_END = FAKE + 1_000_000;
/** Real games without analyses or notes, picked in beforeAll. */
let ids: number[] = [];

const analysisRow = async (id: number) =>
  (await query<{ status: string; job_id: string | null; error: string | null; requested_at: string }>('SELECT status, job_id, error, requested_at::text AS requested_at FROM game_analysis WHERE game_id = $1', [id]))[0] ?? null;
const annotationRow = async (id: number) =>
  (await query<{ status: string; error: string | null; requested_at: string }>('SELECT status, error, requested_at::text AS requested_at FROM game_annotation WHERE game_id = $1', [id]))[0] ?? null;
const cleanup = async () => {
  if (!ids.length) return;
  const list = `{${ids.join(',')}}`;
  await query('DELETE FROM game_analysis WHERE game_id = ANY($1::int[]) OR (game_id >= $2 AND game_id < $3)', [list, FAKE, FAKE_END]);
  await query('DELETE FROM game_annotation WHERE game_id = ANY($1::int[]) OR (game_id >= $2 AND game_id < $3)', [list, FAKE, FAKE_END]);
};

describe.skipIf(!(await writableDbAvailable()))('engine analysis and AI notes against the database', () => {
  beforeAll(async () => {
    // A closed local port: every engine call fails at once, as when the VPS is down.
    vars.ENGINE_URL = 'http://127.0.0.1:9';
    vars.STOCKFISH_TOKEN = 'test-token';
    vars.ANTHROPIC_KEY = 'test-key';
    // The Anthropic SDK reads its base URL from here: a closed port too, so no test ever reaches the API.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    ids = (
      await query<{ id: number }>(
        `SELECT id FROM games g WHERE id < $1
           AND NOT EXISTS (SELECT 1 FROM game_analysis a WHERE a.game_id = g.id)
           AND NOT EXISTS (SELECT 1 FROM game_annotation n WHERE n.game_id = g.id)
         ORDER BY id LIMIT 5`,
        [FAKE],
      )
    ).map((r) => r.id);
    expect(ids).toHaveLength(5);
  });

  afterAll(async () => {
    await cleanup();
    Object.assign(vars, saved);
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
  });

  describe('requesterId', () => {
    it('hashes the client key: the same for one /64, different for other clients, no address in it', async () => {
      const a = await requesterId('2001:db8:1:2:aaaa::1');
      expect(a).toMatch(/^[0-9a-f]{24}$/);
      expect(await requesterId('2001:db8:1:2:bbbb::9')).toBe(a);
      expect(await requesterId('2001:db8:1:3::1')).not.toBe(a);
      expect(await requesterId('192.0.2.1')).not.toBe(await requesterId('192.0.2.2'));
    });
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
      await query('DELETE FROM game_analysis WHERE game_id >= $1 AND game_id < $2', [FAKE, FAKE_END]);
    });

    it('refuses a client that has used its own daily limit, but not other clients', async () => {
      await query(`INSERT INTO game_analysis (game_id, status, error, requester) SELECT $1::int + i, 'failed', 'filler', 'busy-client' FROM generate_series(1, $2::int) AS i`, [FAKE, ENGINE_CLIENT_LIMIT]);
      expect(await queueAnalysis(ids[2], 'busy-client')).toEqual({ refused: 'You have asked for many analyses today. Please try again tomorrow.', code: 429 });
      expect(await analysisRow(ids[2])).toBeNull();
      expect(await queueAnalysis(ids[2], 'other-client')).toEqual({ status: 'failed', error: 'engine unreachable' });
      expect((await query<{ requester: string }>('SELECT requester FROM game_analysis WHERE game_id = $1', [ids[2]]))[0].requester).toBe('other-client');
      await query('DELETE FROM game_analysis WHERE game_id >= $1 AND game_id < $2', [FAKE, FAKE_END]);
    });

    it('keeps a job through a short engine fault, then fails it so it can be retried', async () => {
      // The engine (a closed port here) doesn't answer for a job it was given: a tunnel fault, a bad token, a hung engine.
      await query(`INSERT INTO game_analysis (game_id, status, job_id) VALUES ($1, 'running', 'j_1')`, [ids[4]]);
      expect(await getAnalysis(ids[4])).toEqual({ status: 'running', done: 0, total: 0 });
      expect(await analysisRow(ids[4])).toMatchObject({ status: 'running', job_id: 'j_1' });
      await query(`UPDATE game_analysis SET updated_at = now() - interval '31 minutes' WHERE game_id = $1`, [ids[4]]);
      expect(await getAnalysis(ids[4])).toEqual({ status: 'failed', error: 'the engine is not answering' });
      expect(await analysisRow(ids[4])).toMatchObject({ status: 'failed', error: 'the engine is not answering' });
      // Failed rows are claimed again by the next click.
      expect(await queueAnalysis(ids[4])).toEqual({ status: 'failed', error: 'engine unreachable' });
    });
  });

  describe('createAnnotation', () => {
    it('claims the row and records the failure on that same run', async () => {
      // No analysis for this game, so generate() gives up before calling the model.
      const waited: Promise<unknown>[] = [];
      expect(await createAnnotation(ids[3], { waitUntil: (p) => waited.push(p) })).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
      expect(await annotationRow(ids[3])).toMatchObject({ status: 'failed', error: 'the game has no engine analysis yet' });
      // The run was handed to waitUntil, so it goes on if the visitor leaves.
      expect(waited).toHaveLength(1);
    });

    it('pauses retries of a failed annotation (each attempt is a paid call)', async () => {
      const before = (await annotationRow(ids[3]))!.requested_at;
      expect(await createAnnotation(ids[3])).toEqual({ refused: 'Writing the notes failed a moment ago. Please try again in a few minutes.', code: 429 });
      expect((await annotationRow(ids[3]))!.requested_at).toBe(before);
      await query(`UPDATE game_annotation SET updated_at = now() - interval '11 minutes' WHERE game_id = $1`, [ids[3]]);
      expect(await createAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
      expect((await annotationRow(ids[3]))!.requested_at).not.toBe(before);
    });

    it('shows an old failure to later visitors as no notes yet, not as an error', async () => {
      await query(`UPDATE game_annotation SET updated_at = now() - interval '11 minutes' WHERE game_id = $1`, [ids[3]]);
      expect(await getAnnotation(ids[3])).toEqual({ status: 'none' });
      await query(`UPDATE game_annotation SET updated_at = now() WHERE game_id = $1`, [ids[3]]);
      expect(await getAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
    });

    it('stores nothing for an AI outage, so the game can be tried again at once', async () => {
      // A finished analysis (all evals 0), so generate() calls the API, at a closed port: a network failure.
      const [{ plies }] = await query<{ plies: number }>('SELECT plies FROM games WHERE id = $1', [ids[4]]);
      const evals = JSON.stringify({ e: Array(plies + 1).fill(0), b: Array(plies + 1).fill(null) });
      await query(`UPDATE game_analysis SET status = 'done', depth = 18, evals = $2, error = NULL WHERE game_id = $1`, [ids[4], evals]);
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
      expect(await createAnnotation(ids[4])).toEqual({ refused: UNAVAILABLE, code: 503 });
      expect(await annotationRow(ids[4])).toBeNull();
      expect(await getAnnotation(ids[4])).toEqual({ status: 'none' });
    });

    it('refuses a client that has used its own daily limit', async () => {
      await query(`INSERT INTO game_annotation (game_id, status, requester) SELECT $1::int + i, 'done', 'busy-client' FROM generate_series(1, $2::int) AS i`, [FAKE, AI_CLIENT_LIMIT]);
      expect(await createAnnotation(ids[4], { requester: 'busy-client' })).toEqual({ refused: 'You have asked for AI notes on many games today. Please try again tomorrow.', code: 429 });
      expect(await annotationRow(ids[4])).toBeNull();
      await query('DELETE FROM game_annotation WHERE game_id >= $1 AND game_id < $2', [FAKE, FAKE_END]);
    });

    it('does not take over a run that is still going, but reclaims one left running too long', async () => {
      await query(`UPDATE game_annotation SET status = 'running', error = NULL, updated_at = now() WHERE game_id = $1`, [ids[3]]);
      expect(await createAnnotation(ids[3])).toEqual({ status: 'running' });
      await query(`UPDATE game_annotation SET updated_at = now() - interval '6 minutes' WHERE game_id = $1`, [ids[3]]);
      expect(await getAnnotation(ids[3])).toEqual({ status: 'failed', error: 'interrupted' });
      expect(await createAnnotation(ids[3])).toEqual({ status: 'failed', error: 'the game has no engine analysis yet' });
    });

    it('refuses once the daily budget is used, also for parallel requests', async () => {
      // Fill the day's budget up to two slots (counting the row of ids[3] from the tests above and any other row of the
      // day); five requests at once: the lock lets exactly two claim.
      const [{ used }] = await query<{ used: number }>(`SELECT count(*)::int AS used FROM game_annotation WHERE requested_at > now() - interval '1 day'`);
      expect(used).toBeLessThanOrEqual(AI_DAILY_LIMIT - 2);
      await query(`INSERT INTO game_annotation (game_id, status) SELECT $1::int + i, 'done' FROM generate_series(1, $2::int) AS i`, [FAKE, AI_DAILY_LIMIT - 2 - used]);
      const results = await Promise.all([ids[0], ids[1], ids[2], FAKE + 500_001, FAKE + 500_002].map((id) => createAnnotation(id)));
      const refused = results.filter((r) => 'refused' in r);
      expect(refused).toHaveLength(3);
      for (const r of refused) expect(r).toEqual({ refused: 'The daily limit for AI notes is reached. Please try again tomorrow.', code: 503 });
      const [{ n }] = await query<{ n: string }>(`SELECT count(*) AS n FROM game_annotation WHERE requested_at > now() - interval '1 day'`);
      expect(Number(n)).toBe(AI_DAILY_LIMIT);
    });
  });
});
