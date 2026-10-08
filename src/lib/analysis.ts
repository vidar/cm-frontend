// On-demand Stockfish analysis of database games. The engine runs on our VPS (ENGINE_URL, bearer
// STOCKFISH_TOKEN; API described at ENGINE_URL/llm.txt). Results live in Neon table game_analysis
// (scripts/analysis.pg.sql), through the site's Hyperdrive binding (its role may insert/update
// that table only). Only import from on-demand routes.
import { env } from 'cloudflare:workers';
import { getGame, query } from './games';

export const DEPTH = 16;

interface Env {
  ENGINE_URL?: string;
  STOCKFISH_TOKEN?: string;
}
const cfg = () => env as unknown as Env;

/** Analysis is switched on when the engine URL and token are configured. */
export const analysisEnabled = () => !!(cfg().ENGINE_URL && cfg().STOCKFISH_TOKEN);

const aquery = query;

interface Row {
  game_id: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  job_id: string | null;
  depth: number | null;
  evals: string | null;
  error: string | null;
}

/** Per position (ply 0 = start): eval from White's view as centipawns, or "#n" / "#-n" for mate; best move in UCI. */
export interface Evals {
  e: (number | string | null)[];
  b: (string | null)[];
}

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
  return { error: r.body.error?.code ?? `engine ${r.status}` };
}

interface EngineResult {
  ply?: number;
  lines: { cp: number | null; mate: number | null; best: string }[];
}

function compact(results: EngineResult[]): Evals {
  const e: Evals['e'] = [];
  const b: Evals['b'] = [];
  for (const r of results) {
    const l = r.lines[0];
    e.push(!l ? null : l.mate !== null && l.mate !== undefined ? `#${l.mate}` : l.cp);
    b.push(l?.best ?? null);
  }
  return { e, b };
}

const touch = (gameId: number, set: string, params: (string | number | null)[]) =>
  aquery(`UPDATE game_analysis SET ${set}, updated_at = now() WHERE game_id = $1`, [gameId, ...params]);

/** Current state; advances a running job (fetches the result when the engine is done). */
export async function getAnalysis(gameId: number): Promise<AnalysisState> {
  if (!analysisEnabled()) return { status: 'unavailable' };
  // now() keeps Hyperdrive from caching the row: its status changes while a job runs.
  const [row] = await aquery<Row>('SELECT game_id, status, job_id, depth, evals, error, now() AS t FROM game_analysis WHERE game_id = $1', [gameId]);
  if (!row) return { status: 'none' };
  if (row.status === 'done' && row.evals) return { status: 'done', depth: row.depth ?? DEPTH, evals: JSON.parse(row.evals) };
  if (row.status === 'failed') return { status: 'failed', error: row.error ?? 'failed' };
  if (!row.job_id) return { status: 'queued', done: 0, total: 0 };

  const job = await engine<{ status?: string; progress?: { done: number; total: number }; result?: { results: EngineResult[] }; error?: { code: string; message: string } }>(
    `/jobs/${encodeURIComponent(row.job_id)}`,
  );
  if (job.status === 404 || job.body.error?.code === 'restarted') {
    // The job expired or the engine restarted: post it again (finished positions come from its cache).
    const again = await submit(gameId);
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
  const p = job.body.progress ?? { done: 0, total: 0 };
  if (s === 'running' && row.status !== 'running') await touch(gameId, `status = 'running'`, []);
  return { status: s === 'running' ? 'running' : 'queued', done: p.done, total: p.total };
}

/** Queue a game (once; a failed analysis can be retried). Returns the new state. */
export async function queueAnalysis(gameId: number): Promise<AnalysisState> {
  if (!analysisEnabled()) return { status: 'unavailable' };
  // Claim the row first so concurrent clicks submit only one job.
  const claimed = await aquery<{ game_id: number }>(
    `INSERT INTO game_analysis (game_id, status) VALUES ($1, 'queued')
     ON CONFLICT (game_id) DO UPDATE SET status = 'queued', job_id = NULL, error = NULL, updated_at = now()
       WHERE game_analysis.status = 'failed'
     RETURNING game_id`,
    [gameId],
  );
  if (!claimed.length) return getAnalysis(gameId);
  const r = await submit(gameId);
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
