import type { APIRoute } from 'astro';
import { suggestPlayers } from '../../lib/game-search';

// Player name suggestions for the game search form: /players/suggest.json?q=carl
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const rows = await suggestPlayers((url.searchParams.get('q') ?? '').slice(0, 60));
  return new Response(JSON.stringify(rows.map((r) => ({ name: r.name, title: r.title, fed: r.fed, games: r.games }))), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
};
