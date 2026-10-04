// Data loading shared by the event overview and round pages (on-demand routes only).
import { Chess } from 'chess.js';
import { getEvent, eventGamesAll, gameMoves } from './games';
import { analyseEvent, type EventAnalysis, type EventGame } from './event';

export async function loadEvent(slug: string) {
  const [event, games] = await Promise.all([getEvent(slug), eventGamesAll(slug)]);
  if (!event) return null;
  return { event, games, a: analyseEvent(games, event.type) };
}

/** Games worth a diagram: the decisive ones on the top boards, topped up with draws to at least two. */
export function featured(a: EventAnalysis, round: number, max = 4): EventGame[] {
  const r = a.rounds.find((x) => x.n === round);
  if (!r) return [];
  let pool: EventGame[];
  if (a.teams) pool = a.teams.matches.filter((m) => m.round === round).slice(0, 3).flatMap((m) => m.games);
  else if (a.knockout) pool = [...r.games].sort((x, y) => avg(y) - avg(x));
  else pool = r.games.slice(0, 8);
  // Decisive games first, then the top boards' draws.
  const decisive = pool.filter((g) => g.result !== '1/2-1/2');
  const rest = pool.filter((g) => g.result === '1/2-1/2');
  return [...decisive, ...rest].slice(0, Math.min(max, Math.max(2, decisive.length)));
}
const avg = (g: EventGame) => ((g.white_elo ?? 0) + (g.black_elo ?? 0)) / 2;

/** Final position and last move of each game, for static diagrams. */
export async function finalPositions(games: EventGame[]) {
  const moves = await gameMoves(games.map((g) => g.id));
  return games.flatMap((g) => {
    const sans = moves.get(g.id)?.split(' ').filter(Boolean);
    if (!sans) return [];
    const chess = new Chess();
    let last: string[] = [];
    try {
      for (const san of sans) {
        const m = chess.move(san);
        last = [m.from, m.to];
      }
    } catch {
      return [];
    }
    return [{ game: g, fen: chess.fen(), last }];
  });
}
