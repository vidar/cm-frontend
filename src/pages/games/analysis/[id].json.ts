import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { analysisEnabled, engineBusy, getAnalysis, queueAnalysis, type AnalysisState } from '../../../lib/analysis';
import { idParam, limiterKey, sameSite } from '../../../lib/client';
import { isUploaded } from '../../../lib/uploads';

// Stockfish analysis of a game: GET the state (polled while queued/running), POST to queue it.
export const prerender = false;

const json = (body: AnalysisState | { error: string }, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });

export const GET: APIRoute = async ({ params, url }) => {
  const id = idParam(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  const state = await getAnalysis(id);
  // A finished analysis never changes: let the edge cache it. "Not analysed yet" is cached for a few
  // minutes too (most views of most games), except for the ?poll=1 requests of a client that has just
  // queued the game. Queued/running states are never cached.
  // (Uploaded games, like their pages, only 5 minutes: an organiser can replace them.)
  const done = isUploaded(id) ? 'public, max-age=60, s-maxage=300' : 'public, max-age=86400, s-maxage=2592000';
  const cache = state.status === 'done' ? done : state.status === 'none' && !url.searchParams.has('poll') ? 'public, max-age=60, s-maxage=300' : 'no-store';
  return json(state, 200, cache);
};

export const POST: APIRoute = async ({ params, request, url, clientAddress }) => {
  const id = idParam(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  if (!analysisEnabled()) return json({ status: 'unavailable' });
  // Same-site requests only (the button on the game page).
  if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
  const limiter = (env as { ANALYSIS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).ANALYSIS_LIMITER;
  if (limiter && !(await limiter.limit({ key: limiterKey(clientAddress) })).success) return json({ error: 'Too many requests, try again in a minute.' }, 429);
  const current = await getAnalysis(id);
  if (current.status !== 'none' && current.status !== 'failed') return json(current);
  if (await engineBusy()) return json({ error: 'The engine is busy right now. Please try again in a few minutes.' }, 503);
  const r = await queueAnalysis(id);
  return 'refused' in r ? json({ error: r.refused }, r.code) : json(r);
};
