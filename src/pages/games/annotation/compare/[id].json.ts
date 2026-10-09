import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { annotationEnabled, generate, MODELS, type ModelKey } from '../../../../lib/annotate';

// TEMPORARY (remove after the model comparison): writes an annotation with ?model=haiku|sonnet without
// storing it, to compare the models. Rate-limited per visitor.
export const prerender = false;

export const GET: APIRoute = async ({ params, url, clientAddress }) => {
  if (!annotationEnabled()) return new Response('Not found', { status: 404 });
  const model = (url.searchParams.get('model') ?? 'haiku') as ModelKey;
  if (!(model in MODELS)) return new Response('bad model', { status: 400 });
  const limiter = (env as { ANALYSIS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }).ANALYSIS_LIMITER;
  if (limiter && !(await limiter.limit({ key: `cmp:${clientAddress ?? 'anon'}` })).success) return new Response('Too many requests', { status: 429 });
  const r = await generate(Number(params.id), model);
  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};
