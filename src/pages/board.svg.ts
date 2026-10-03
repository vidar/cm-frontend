import type { APIRoute } from 'astro';
import { renderBoardSvg, isValidSquare } from '../lib/chess/board-svg';

// Rendered per request: the image is a pure function of the query string.
export const prerender = false;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const truthy = (v: string | null) => v !== null && ['1', 'true', 'yes', 'black', 'b'].includes(v.toLowerCase());

export const GET: APIRoute = ({ url }) => {
  const q = url.searchParams;
  const fen = (q.get('fen') ?? START).replace(/_/g, ' ');
  const size = Math.min(2048, Math.max(64, Number.parseInt(q.get('size') ?? '', 10) || 400));
  const flip = truthy(q.get('flip')) || q.get('orientation')?.toLowerCase() === 'black';
  const lastMove = q.get('lastmove')?.toLowerCase();
  const highlight = lastMove
    ? [lastMove.slice(0, 2), lastMove.slice(2, 4)]
    : (q.get('highlight')?.toLowerCase().split(',') ?? []);

  let svg: string;
  try {
    svg = renderBoardSvg({ fen, size, flip, coords: q.get('coords') !== '0', highlight: highlight.filter(isValidSquare) });
  } catch (err) {
    return new Response(`Invalid FEN: ${(err as Error).message}\nUsage: https://chessmoments.com/board-image/\n`, {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
