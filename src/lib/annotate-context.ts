// Tournament situation around a game, for the AI notes' preamble and postamble (src/lib/annotate.ts):
// standings going into the game's round and after it, the players' scores so far, the team match or
// knockout match score. Only what was known at the time: no final standings. Only import from
// on-demand routes.
import { FORMAT_LABEL, parseRound, pts, whiteScore, type EventAnalysis, type EventGame, type Line, type TeamLine } from './event';
import { loadEvent } from './event-page';
import type { FullGame } from './games';

const TOP = 8;

/** Ranked lines as text: the top of the table plus the given players' lines. */
function table<T>(lines: T[], label: (l: T) => string, keep: (l: T) => boolean) {
  const shown = lines.filter((l, i) => i < TOP || keep(l));
  return shown.map((l, i) => (i > 0 && lines.indexOf(l) !== lines.indexOf(shown[i - 1]) + 1 ? `  …\n${label(l)}` : label(l))).join('\n');
}

const lineText = (l: Line) => `  ${l.rank}. ${l.player.name} ${pts(l.points)}/${l.games}`;
const teamText = (l: TeamLine) => `  ${l.rank}. ${l.team} ${l.mp} match points, ${pts(l.gp)} game points (${l.played} matches)`;

/** A player's score in the event from the rounds before `n`. */
function scoreBefore(a: EventAnalysis, id: number, n: number) {
  let points = 0;
  let games = 0;
  for (const r of a.rounds) {
    if (r.n >= n) continue;
    for (const g of r.games) {
      if (g.white_id === id) points += whiteScore(g.result);
      else if (g.black_id === id) points += 1 - whiteScore(g.result);
      else continue;
      games++;
    }
  }
  return { points, games };
}

/** The tournament context as prompt text, or null when there's none worth giving (no rounds, too few games). */
export async function tournamentContext(game: FullGame): Promise<string | null> {
  const n = parseRound(game.round).n;
  if (!n) return null;
  const data = await loadEvent(game.event_slug);
  if (!data) return null;
  const { a } = data;
  const eg: EventGame | undefined = a.rounds.find((r) => r.n === n)?.games.find((g) => g.id === game.id);
  if (!eg || a.format === 'games') return null;
  const total = a.rounds.length ? a.rounds[a.rounds.length - 1].n : n;
  const prev = a.rounds.filter((r) => r.n < n).at(-1);
  const W = game.white_id;
  const B = game.black_id;
  const out: string[] = [`Tournament: ${game.event_name}, ${FORMAT_LABEL[a.format].toLowerCase()}, ${total} rounds${a.format !== 'team' ? `, ${a.players.size} players` : ''}.`];
  out.push(n === total ? `This game was played in round ${n}, the last round.` : `This game was played in round ${n} of ${total}.`);
  if (!a.complete && a.format !== 'knockout' && a.format !== 'match') out.push('Not every game of the event is in the database, so the standings below may be incomplete; treat them as approximate.');

  if (a.format === 'match' || a.format === 'knockout') {
    const ko = a.knockout?.flatMap((r) => r.matches.map((m) => ({ r, m }))).find(({ m }) => m.games.some((g) => g.id === game.id));
    if (ko) {
      const { r, m } = ko;
      const before = m.games.filter((g) => g.id < game.id);
      const score = (games: EventGame[], id: number) => games.reduce((s, g) => s + (g.white_id === id ? whiteScore(g.result) : g.black_id === id ? 1 - whiteScore(g.result) : 0), 0);
      const sA = m.a.name;
      const sB = m.b.name;
      const upto = [...before, eg];
      out.push(
        `${a.format === 'match' ? 'Match' : `Knockout stage: ${r.name}`} between ${m.a.name} and ${m.b.name}, ${m.games.length} games in all.`,
        `This was game ${before.length + 1} of the match. Score before it: ${sA} ${pts(score(before, m.a.id))}, ${sB} ${pts(score(before, m.b.id))}.`,
        `Score after it: ${sA} ${pts(score(upto, m.a.id))}, ${sB} ${pts(score(upto, m.b.id))}.`,
        upto.length === m.games.length ? `This was the last game of the match.` : `${m.games.length - upto.length} more game(s) followed in the match.`,
      );
    }
    return out.join('\n');
  }

  if (a.format === 'team' && a.teams) {
    const t = a.teams;
    const wt = eg.white_team;
    const bt = eg.black_team;
    const match = t.matches.find((m) => m.round === n && m.games.some((g) => g.id === game.id));
    if (match) {
      const board = match.games.findIndex((g) => g.id === game.id) + 1;
      out.push(
        `Team match in round ${n}: ${match.home} vs ${match.away}, ${match.games.length} boards; this game was board ${board}. ${game.white_name} played for ${wt}, ${game.black_name} for ${bt}.`,
        `Final score of the team match (known only after the round; for the postamble): ${match.home} ${pts(match.homePts)}, ${match.away} ${pts(match.awayPts)}.`,
      );
    }
    const keep = (l: TeamLine) => l.team === wt || l.team === bt;
    if (prev) out.push(`Team standings going into round ${n}:`, table(t.standingsAfter(prev.n), teamText, keep));
    out.push(`Team standings after round ${n}:`, table(t.standingsAfter(n), teamText, keep));
    for (const [id, name] of [
      [W, game.white_name],
      [B, game.black_name],
    ] as const) {
      const s = scoreBefore(a, id, n);
      if (s.games) out.push(`${name} had scored ${pts(s.points)}/${s.games} in the event before this game.`);
    }
    return out.join('\n');
  }

  // Individual round robin or Swiss.
  const keep = (l: Line) => l.player.id === W || l.player.id === B;
  if (prev) {
    const before = a.standingsAfter(prev.n);
    out.push(`Standings going into round ${n} (rank, player, points/games):`, table(before, lineText, keep));
  } else out.push('This was the first round.');
  out.push(`Standings after round ${n}:`, table(a.standingsAfter(n), lineText, keep));
  return out.join('\n');
}
