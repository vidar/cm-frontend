import type { APIRoute } from 'astro';
import { getOpenings } from '../lib/openings';
import { getStats, getEval, sumWdb, percents, statsSource, sample } from '../lib/opening-stats';

export const GET: APIRoute = ({ site }) =>
  new Response(
    JSON.stringify({
      source: 'https://github.com/lichess-org/chess-openings (CC0)',
      stats: { source: statsSource, gamesInSample: sample.gamesCounted, note: 'games reaching the line by this exact move order; blitz and slower; bots excluded' },
      count: getOpenings().length,
      openings: getOpenings().map((o) => {
        const st = getStats(o);
        const ev = getEval(o);
        const [white, draw, black] = st ? percents(sumWdb(st.r)) : [null, null, null];
        return {
          name: o.name,
          eco: o.eco,
          pgn: o.pgn,
          fen: o.fen,
          url: new URL(`/openings/${o.slug}/`, site).href,
          games: st?.n ?? 0,
          results: st ? { white, draw, black } : null,
          topMoves: st?.next.slice(0, 3).map(([san, n]) => ({ san, games: n })) ?? [],
          eval: ev ? { cp: ev.cp, mate: ev.mate, depth: ev.depth } : null,
        };
      }),
    }),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } },
  );
