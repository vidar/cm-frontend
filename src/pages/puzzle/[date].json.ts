import type { APIRoute } from 'astro';
import { getPuzzle, todayUtc } from '../../lib/puzzles';

export const prerender = false;

/** /puzzle/today.json or /puzzle/YYYY-MM-DD.json */
export const GET: APIRoute = ({ params, site }) => {
  const date = params.date === 'today' ? todayUtc() : (params.date ?? '');
  const p = getPuzzle(date);
  if (!p) return Response.json({ error: 'Puzzle not found' }, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  return Response.json(
    {
      number: p.number,
      date: p.date,
      url: new URL(`/puzzle/${p.date}/`, site).href,
      sideToMove: p.solverColor === 'w' ? 'white' : 'black',
      fen: p.startFen,
      rating: p.rating,
      themes: p.themes,
      opening: p.opening,
      solution: { san: p.solutionSan, uci: p.moves.slice(1) },
      image: new URL(`/board.svg?fen=${p.startFen.replace(/ /g, '_')}&lastmove=${p.setupMove.join('')}${p.solverColor === 'b' ? '&flip=1' : ''}`, site).href,
      source: { lichessPuzzleId: p.id, game: p.gameUrl, license: 'CC0' },
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': params.date === 'today' ? 'public, max-age=60' : 'public, max-age=86400',
      },
    },
  );
};
