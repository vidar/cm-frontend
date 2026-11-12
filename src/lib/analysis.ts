// On-demand Stockfish analysis of database games. The engine runs on our VPS (ENGINE_URL, bearer
// STOCKFISH_TOKEN; API described at ENGINE_URL/llm.txt). Results live in table game_analysis
// (scripts/analysis.pg.sql), through the site's Hyperdrive binding (its role may insert/update
// that table only). Only import from on-demand routes.
import { env } from 'cloudflare:workers';
import { limiterKey } from './client';
import { getGame, query } from './games';

export const DEPTH = 18;
/** At most this many games sent to the engine per day across the site (the VPS has a fixed capacity). */
export const DAILY_LIMIT = 1000;
/** At most this many new analyses per client (address, IPv6 /64) per day, so one client can't use up DAILY_LIMIT. */
export const CLIENT_DAILY_LIMIT = 30;
/** A queued row that never got its engine job (the submit failed or the Worker was cut off) can be retried after this long. */
const STALE_MINUTES = 5;
/**
 * A job still queued or running this long after its last change (or that the engine keeps answering
 * with an error: a bad token, a tunnel fault, a hung engine) is marked failed, so it can be retried.
 */
const JOB_MINUTES = 30;

interface Env {
  ENGINE_URL?: string;
  STOCKFISH_TOKEN?: string;
}
const cfg = () => env as unknown as Env;

/** Analysis is switched on when the engine URL and token are configured. */
export const analysisEnabled = () => !!(cfg().ENGINE_URL && cfg().STOCKFISH_TOKEN);

const aquery = query;

/**
 * Who asked, for the per-client daily limits (here and in src/lib/annotate.ts): the client's limiterKey()
 * (address, IPv6 by /64), hashed with a secret so the database holds no addresses.
 */
export async function requesterId(clientAddress: string | null | undefined) {
  const data = new TextEncoder().encode(`requester:${cfg().STOCKFISH_TOKEN ?? ''}:${limiterKey(clientAddress)}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Row {
  game_id: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  job_id: string | null;
  depth: number | null;
  evals: string | null;
  error: string | null;
  stale: boolean;
  expired: boolean;
}

/**
 * Per position (ply 0 = start): eval from White's view as centipawns, or "#n" / "#-n" for mate; best move
 * in UCI; the engine's line (up to PV_MOVES UCI moves, space-separated; absent in analyses before depth 18).
 */
export interface Evals {
  e: (number | string | null)[];
  b: (string | null)[];
  p?: (string | null)[];
}
const PV_MOVES = 8;

export type AnalysisState =
  | { status: 'none' }
  | { status: 'queued' | 'running'; done: number; total: number }
  | { status: 'done'; depth: number; evals: Evals }
  | { status: 'failed'; error: string }
  | { status: 'unavailable' };

async function engine<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, cfg().ENGINE_URL), {
    ...init,
    headers: { Authorization: `Bearer ${cfg().STOCKFISH_TOKEN}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Minimal PGN for the engine: just the mainline moves. */
function pgnOf(moves: string, result: string) {
  const sans = moves.split(' ').filter(Boolean);
  return `[Result "${result}"]\n\n${sans.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ')} ${result}\n`;
}

async function submit(gameId: number): Promise<{ jobId: string } | { error: string }> {
  const game = await getGame(gameId);
  if (!game) return { error: 'no such game' };
  const r = await engine<{ job_id?: string; error?: { code: string; message: string } }>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ pgn: pgnOf(game.moves, game.result), depth: DEPTH }),
  });
  if (r.status === 202 && r.body.job_id) return { jobId: r.body.job_id };
  console.error('Engine analysis: submit refused', { game: gameId, status: r.status, error: r.body.error?.code ?? null });
  return { error: r.body.error?.code ?? `engine ${r.status}` };
}

/** submit(), with a network or database failure as an error, so the row is marked failed instead of staying queued. */
const trySubmit = (gameId: number) => submit(gameId).catch((): { error: string } => ({ error: 'engine unreachable' }));

interface EngineResult {
  ply?: number;
  lines: { cp: number | null; mate: number | null; best: string; pv?: string[] }[];
}

function compact(results: EngineResult[]): Evals {
  const e: Evals['e'] = [];
  const b: Evals['b'] = [];
  const p: NonNullable<Evals['p']> = [];
  for (const r of results) {
    const l = r.lines[0];
    e.push(!l ? null : l.mate !== null && l.mate !== undefined ? `#${l.mate}` : l.cp);
    b.push(l?.best ?? null);
    p.push(l?.pv?.length ? l.pv.slice(0, PV_MOVES).join(' ') : null);
  }
  return { e, b, p };
}

const touch = (gameId: number, set: string, params: (string | number | null)[]) =>
  aquery(`UPDATE game_analysis SET ${set}, updated_at = now() WHERE game_id = $1`, [gameId, ...params]);

/** Current state; advances a running job (fetches the result when the engine is done). */
export async function getAnalysis(gameId: number): Promise<AnalysisState> {
  if (!analysisEnabled()) return { status: 'unavailable' };
  // now() keeps Hyperdrive from caching the row: its status changes while a job runs.
  const [row] = await aquery<Row>(
    `SELECT game_id, status, job_id, depth, evals, error, updated_at < now() - interval '${STALE_MINUTES} minutes' AS stale,
       updated_at < now() - interval '${JOB_MINUTES} minutes' AS expired
     FROM game_analysis WHERE game_id = $1`,
    [gameId],
  );
  if (!row) return { status: 'none' };
  if (row.status === 'done' && row.evals) return { status: 'done', depth: row.depth ?? DEPTH, evals: JSON.parse(row.evals) };
  if (row.status === 'failed') return { status: 'failed', error: row.error ?? 'failed' };
  // No job yet: being submitted, or the submit never finished (then it can be retried like a failure).
  if (!row.job_id) return row.stale ? { status: 'failed', error: 'interrupted' } : { status: 'queued', done: 0, total: 0 };

  type Job = { status?: string; progress?: { done: number; total: number }; result?: { results: EngineResult[] }; error?: { code: string; message: string } };
  // A network failure counts as an unexpected answer (status 0) below.
  const job = await engine<Job>(`/jobs/${encodeURIComponent(row.job_id)}`).catch(() => ({ status: 0, body: {} as Job }));
  if (job.status === 404 || job.body.error?.code === 'restarted') {
    // The job expired or the engine restarted: post it again (finished positions come from its cache).
    const again = await trySubmit(gameId);
    if ('jobId' in again) await touch(gameId, `status = 'queued', job_id = $2`, [again.jobId]);
    else await touch(gameId, `status = 'failed', error = $2`, [again.error]);
    return 'jobId' in again ? { status: 'queued', done: 0, total: 0 } : { status: 'failed', error: again.error };
  }
  const s = job.body.status;
  if (s === 'done' && job.body.result) {
    const evals = compact(job.body.result.results);
    await touch(gameId, `status = 'done', depth = $2, evals = $3, error = NULL`, [DEPTH, JSON.stringify(evals)]);
    return { status: 'done', depth: DEPTH, evals };
  }
  if (s === 'failed') {
    const err = job.body.error?.message ?? job.body.error?.code ?? 'engine failure';
    await touch(gameId, `status = 'failed', error = $2`, [err]);
    return { status: 'failed', error: err };
  }
  // Anything but a 2xx answer (a bad token, a tunnel or engine fault, an HTML error page): logged for the
  // site owner; the job keeps its state until JOB_MINUTES have passed, so a short fault doesn't fail it.
  const ok = job.status >= 200 && job.status < 300;
  if (!ok) console.error('Engine analysis: unexpected answer', { game: gameId, job: row.job_id, status: job.status, error: job.body.error?.code ?? null });
  if (row.expired) {
    const err = ok ? 'the engine took too long' : 'the engine is not answering';
    await touch(gameId, `status = 'failed', error = $2`, [err]);
    return { status: 'failed', error: err };
  }
  if (!ok) return { status: row.status === 'running' ? 'running' : 'queued', done: 0, total: 0 };
  const p = job.body.progress ?? { done: 0, total: 0 };
  if (s === 'running' && row.status !== 'running') await touch(gameId, `status = 'running'`, []);
  return { status: s === 'running' ? 'running' : 'queued', done: p.done, total: p.total };
}

/** Why queueAnalysis() didn't queue a game, with the HTTP status for it. */
export interface Refused {
  refused: string;
  code: 404 | 429 | 503;
}

/**
 * Queue a game (once; a failed or interrupted analysis can be retried). Returns the new state.
 * `requester` (requesterId() of the client) also limits each client to CLIENT_DAILY_LIMIT games a day.
 */
export async function queueAnalysis(gameId: number, requester: string | null = null): Promise<AnalysisState | Refused> {
  if (!analysisEnabled()) return { status: 'unavailable' };
  // Claim the row first so concurrent clicks submit only one job; in the same statement, only for a
  // game that exists and while the site and the client are under their daily limits (a retry re-dates its row).
  const [c] = await aquery<{ game: boolean; over: boolean; mine: boolean; claimed: boolean }>(
    `WITH day AS (
       SELECT count(*) AS n, count(*) FILTER (WHERE requester = $3) AS mine FROM game_analysis WHERE requested_at > now() - interval '1 day'
     ), ok AS (
       SELECT EXISTS (SELECT 1 FROM games WHERE id = $1) AS game, (SELECT n FROM day) >= $2 AS over, (SELECT mine FROM day) >= $4 AS mine
     ), c AS (
       INSERT INTO game_analysis (game_id, status, requester) SELECT $1, 'queued', $3 FROM ok WHERE game AND NOT over AND NOT mine
       ON CONFLICT (game_id) DO UPDATE SET status = 'queued', job_id = NULL, error = NULL, requester = $3, requested_at = now(), updated_at = now()
         WHERE game_analysis.status = 'failed'
            OR (game_analysis.status = 'queued' AND game_analysis.job_id IS NULL AND game_analysis.updated_at < now() - interval '${STALE_MINUTES} minutes')
       RETURNING game_id
     )
     SELECT game, over, mine, EXISTS (SELECT 1 FROM c) AS claimed FROM ok`,
    [gameId, DAILY_LIMIT, requester, CLIENT_DAILY_LIMIT],
  );
  if (!c.game) return { refused: 'No such game.', code: 404 };
  if (!c.claimed && c.over) return { refused: 'The daily limit for engine analysis is reached. Please try again tomorrow.', code: 503 };
  if (!c.claimed && c.mine) return { refused: 'You have asked for many analyses today. Please try again tomorrow.', code: 429 };
  if (!c.claimed) return getAnalysis(gameId);
  const r = await trySubmit(gameId);
  if ('jobId' in r) {
    await touch(gameId, `job_id = $2`, [r.jobId]);
    return { status: 'queued', done: 0, total: 0 };
  }
  await touch(gameId, `status = 'failed', error = $2`, [r.error]);
  return { status: 'failed', error: r.error };
}

/** Engine busy? (Refuse new work when its queue is long.) */
export async function engineBusy(maxJobs = 25) {
  try {
    const r = await fetch(new URL('/healthz', cfg().ENGINE_URL));
    const h = (await r.json()) as { jobs_queued?: number };
    return (h.jobs_queued ?? 0) >= maxJobs;
  } catch {
    return true;
  }
}
