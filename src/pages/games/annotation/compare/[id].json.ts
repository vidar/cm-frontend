import type { APIRoute } from 'astro';
import { annotationEnabled, generate, MODELS, type ModelKey } from '../../../../lib/annotate';

// TEMPORARY (remove before merging): writes an annotation with ?model=haiku|sonnet without storing it,
// to compare the models. Answers on preview hosts (*.workers.dev) only.
export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  if (!url.hostname.endsWith('.workers.dev') || !annotationEnabled()) return new Response('Not found', { status: 404 });
  const model = (url.searchParams.get('model') ?? 'haiku') as ModelKey;
  if (!(model in MODELS)) return new Response('bad model', { status: 400 });
  const r = await generate(Number(params.id), model);
  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
};
