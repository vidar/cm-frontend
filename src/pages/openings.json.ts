import type { APIRoute } from 'astro';
import { getOpenings } from '../lib/openings';

export const GET: APIRoute = ({ site }) =>
  new Response(
    JSON.stringify({
      source: 'https://github.com/lichess-org/chess-openings (CC0)',
      count: getOpenings().length,
      openings: getOpenings().map((o) => ({
        name: o.name,
        eco: o.eco,
        pgn: o.pgn,
        fen: o.fen,
        url: new URL(`/openings/${o.slug}/`, site).href,
      })),
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } },
  );
