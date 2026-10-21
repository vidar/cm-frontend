import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAnalysis } from '../../../lib/analysis';
import { annotationEnabled, createAnnotation, getAnnotation, type AnnotationState } from '../../../lib/annotate';
import { idParam, limiterKey, sameSite } from '../../../lib/client';
import { isUploaded } from '../../../lib/uploads';

// AI annotation of an analysed game: GET the state, POST to write it (takes 10-30 s; the response
// carries the result).
export const prerender = false;

const json = (body: AnnotationState | { error: string }, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });

export const GET: APIRoute = async ({ params, url }) => {
  const id = idParam(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  const state = await getAnnotation(id);
  // Finished notes never change; "no notes yet" is cached a few minutes except for a client's ?poll=1.
  // (Uploaded games, like their pages, only 5 minutes: an organiser can replace them.)
  const done = isUploaded(id) ? 'public, max-age=60, s-maxage=300' : 'public, max-age=86400, s-maxage=2592000';
  const cache = state.status === 'done' ? done : state.status === 'none' && !url.searchParams.has('poll') ? 'public, max-age=60, s-maxage=300' : 'no-store';
  return json(state, 200, cache);
};

export const POST: APIRoute = async ({ params, request, url, clientAddress }) => {
  const id = idParam(params.id);
  if (!id) return json({ error: 'bad game id' }, 400);
  if (!annotationEnabled()) return json({ status: 'unavailable' });
  // Same-site requests only (the button on the game page).
  if (!sameSite(request, url)) return json({ error: 'forbidden' }, 403);
  const limiter = (env as { ANALYSIS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).ANALYSIS_LIMITER;
  if (limiter && !(await limiter.limit({ key: `ai:${limiterKey(clientAddress)}` })).success) return json({ error: 'Too many requests, try again in a minute.' }, 429);
  const current = await getAnnotation(id);
  if (current.status !== 'none' && current.status !== 'failed') return json(current);
  if ((await getAnalysis(id)).status !== 'done') return json({ error: 'Analyse the game with Stockfish first.' }, 409);
  const r = await createAnnotation(id);
  return 'refused' in r ? json({ error: r.refused }, r.code) : json(r);
};
