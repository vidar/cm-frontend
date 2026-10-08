import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { analysisEnabled, engineBusy, getAnalysis, queueAnalysis, type AnalysisState } from '../../../lib/analysis';

// Stockfish analysis of a game: GET the state (polled while queued/running), POST to queue it.
export const prerender = false;

const json = (body: AnalysisState | { error: string }, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });

const gameId = (s: string | undefined) => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const GET: APIRoute = async ({ params }) => {
  const id = gameId(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  const state = await getAnalysis(id);
  // A finished analysis never changes: let the edge cache it.
  return json(state, 200, state.status === 'done' ? 'public, max-age=86400, s-maxage=2592000' : 'no-store');
};

export const POST: APIRoute = async ({ params, request, url, clientAddress }) => {
  const id = gameId(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  if (!analysisEnabled()) return json({ status: 'unavailable' });
  // Same-site requests only (the button on the game page).
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403);
  const limiter = (env as { ANALYSIS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).ANALYSIS_LIMITER;
  if (limiter && !(await limiter.limit({ key: clientAddress ?? 'anon' })).success) return json({ error: 'Too many requests, try again in a minute.' }, 429);
  const current = await getAnalysis(id);
  if (current.status !== 'none' && current.status !== 'failed') return json(current);
  if (await engineBusy()) return json({ error: 'The engine is busy right now. Please try again in a few minutes.' }, 503);
  return json(await queueAnalysis(id));
};
