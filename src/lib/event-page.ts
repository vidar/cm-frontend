// Data loading shared by the event overview and round pages (on-demand routes only).
import { Chess } from 'chess.js';
import { gameMoves, getEventWithGames, query, type EventRow } from './games';
import { contains } from './game-search';
import { isUploaded } from './uploads';
import { analyseEvent, type EventAnalysis, type EventGame } from './event';
import { EVENTS_PAGE_SIZE } from './event-view';

export async function loadEvent(slug: string) {
  const data = await getEventWithGames(slug);
  if (!data) return null;
  const { event, games } = data;
  // Uploaded tournaments have no "finished" flag: their standings are never called final.
  return { event, games, a: analyseEvent(games, event.type, { ongoing: isUploaded(event.id), name: event.name }) };
}

export type EventListRow = Pick<EventRow, 'id' | 'name' | 'site' | 'slug' | 'start_date' | 'end_date' | 'games'>;

/**
 * The /events/ listing in one statement: a page of events, newest first, optionally those whose name
 * holds every word of `q` (trigram index events_name) and/or that started in `year` (index
 * events_start), plus the years there are events of. One row more than a page tells whether there's
 * another.
 */
export async function listEvents(p: { q: string | null; year: number | null; page: number }) {
  const params: (string | number)[] = [];
  const where: string[] = [];
  const $ = (v: string | number) => `$${params.push(v)}`;
  for (const word of (p.q ?? '').split(' ').filter(Boolean).slice(0, 6)) where.push(`lower(name) LIKE ${$(contains(word))}`);
  if (p.year) where.push(`start_date >= ${$(String(p.year))} AND start_date < ${$(String(p.year + 1))}`);
  const [row] = await query<{ events: EventListRow[] | null; years: string[] | null }>(
    `SELECT (SELECT json_agg(x) FROM (
         SELECT id, name, site, slug, start_date, end_date, games FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY start_date DESC NULLS LAST, id DESC LIMIT ${$(EVENTS_PAGE_SIZE + 1)} OFFSET ${$((p.page - 1) * EVENTS_PAGE_SIZE)}) x) AS events,
       (SELECT json_agg(y ORDER BY y DESC) FROM (SELECT DISTINCT left(start_date, 4) AS y FROM events WHERE start_date ~ '^[0-9]{4}') t) AS years`,
    params,
  );
  const events = row?.events ?? [];
  return { events: events.slice(0, EVENTS_PAGE_SIZE), more: events.length > EVENTS_PAGE_SIZE, years: (row?.years ?? []).map(Number) };
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
