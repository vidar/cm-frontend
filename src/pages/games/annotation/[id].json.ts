import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAnalysis } from '../../../lib/analysis';
import { annotationEnabled, createAnnotation, getAnnotation, overDailyLimit, type AnnotationState } from '../../../lib/annotate';

// AI annotation of an analysed game: GET the state, POST to write it (takes 10-30 s; the response
// carries the result).
export const prerender = false;

const json = (body: AnnotationState | { error: string }, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });

const gameId = (s: string | undefined) => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const GET: APIRoute = async ({ params }) => {
  const id = gameId(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  const state = await getAnnotation(id);
  return json(state, 200, state.status === 'done' ? 'public, max-age=86400, s-maxage=2592000' : 'no-store');
};

export const POST: APIRoute = async ({ params, request, url, clientAddress }) => {
  const id = gameId(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  if (!annotationEnabled()) return json({ status: 'unavailable' });
  // Same-site requests only (the button on the game page).
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'forbidden' }, 403);
  const limiter = (env as { ANALYSIS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).ANALYSIS_LIMITER;
  if (limiter && !(await limiter.limit({ key: `ai:${clientAddress ?? 'anon'}` })).success) return json({ error: 'Too many requests, try again in a minute.' }, 429);
  const current = await getAnnotation(id);
  if (current.status !== 'none' && current.status !== 'failed') return json(current);
  if ((await getAnalysis(id)).status !== 'done') return json({ error: 'Analyse the game with Stockfish first.' }, 409);
  if (await overDailyLimit()) return json({ error: 'The daily limit for AI notes is reached. Please try again tomorrow.' }, 503);
  return json(await createAnnotation(id));
};
