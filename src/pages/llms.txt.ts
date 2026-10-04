import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { TOOLS } from '../lib/tools';

// Keep in sync with the site's features: see CLAUDE.md.
export const GET: APIRoute = async ({ site }) => {
  const abs = (path: string) => new URL(path, site).href;
  const pages = await getCollection('pages');
  const body = `# chessmoments

> Free chess tools and data: a daily chess puzzle, every named chess opening with moves and FEN, a chess board image (SVG) API, an online chess clock and a coordinates trainer. All pages work without JavaScript except the interactive tools. Data is CC0 (from Lichess).

## Tools

${TOOLS.map((t) => `- [${t.name}](${abs(t.href)}): ${t.blurb} ${t.agent}`).join('\n')}

## Machine-readable endpoints

- ${abs('/board.svg')}?fen=<FEN>: render any position as SVG. Parameters: fen (spaces may be "_"), flip=1, lastmove=e2e4, highlight=a1,h8, size=64..2048, coords=0. CORS enabled.
- ${abs('/puzzle/today.json')}: today's puzzle (FEN, side to move, rating, themes, solution in SAN and UCI, image URL). Changes at 00:00 UTC.
- ${abs('/puzzle/')}YYYY-MM-DD.json: a past daily puzzle.
- ${abs('/openings-index.json')}: compact map of SAN move sequences (space-separated) to [slug, name, ECO] for every named opening.
- ${abs('/openings.json')}: all named openings (name, ECO, PGN, FEN, page URL, games in a Lichess sample, white/draw/black %, top replies, Stockfish eval).

## Pages

- [Puzzle archive](${abs('/puzzle/archive/')})
- [Openings index](${abs('/openings/')})
${pages.map((p) => `- [${p.data.title}](${abs(`/${p.id}/`)})`).join('\n')}
- [Sitemap](${abs('/sitemap-index.xml')})
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
