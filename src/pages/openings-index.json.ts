import type { APIRoute } from 'astro';
import { getOpenings } from '../lib/openings';

/** Compact lookup used by the analysis board: SAN moves joined with spaces -> [slug, name, eco]. */
export const GET: APIRoute = () => {
  const index: Record<string, [string, string, string]> = {};
  for (const o of getOpenings()) index[o.moves.join(' ')] ??= [o.slug, o.name, o.eco];
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
};
