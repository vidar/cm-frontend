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

/** Place with ties by score: "3rd", "shared 2nd-4th". */
function place<T>(lines: T[], line: T, score: (l: T) => number) {
  const v = score(line);
  const first = lines.findIndex((l) => score(l) === v) + 1;
  const count = lines.filter((l) => score(l) === v).length;
  const ord = (k: number) => `${k}${k % 10 === 1 && k % 100 !== 11 ? 'st' : k % 10 === 2 && k % 100 !== 12 ? 'nd' : k % 10 === 3 && k % 100 !== 13 ? 'rd' : 'th'}`;
  return count > 1 ? `shared ${ord(first)}-${ord(first + count - 1)}` : ord(first);
}

/** Key facts worked out for the model: leaders, and each side's place and score before and after. */
function facts<T>(
  before: T[] | null,
  after: T[],
  score: (l: T) => number,
  name: (l: T) => string,
  fmt: (l: T) => string,
  sides: { label: string; is: (l: T) => boolean }[],
) {
  const leaders = (lines: T[]) => {
    const top = lines.filter((l) => score(l) === score(lines[0]));
    return `${top.map(name).join(', ')} (${fmt(top[0])}${top.length > 1 ? ', shared lead' : ''})`;
  };
  const out = ['Key facts (copy these numbers and places exactly; do not work them out from the tables):'];
  if (before?.length) out.push(`- Leader(s) going into the round: ${leaders(before)}.`);
  if (after.length) out.push(`- Leader(s) after the round: ${leaders(after)}.`);
  for (const side of sides) {
    const b = before?.find(side.is);
    const a = after.find(side.is);
    if (!a) continue;
    out.push(`- ${side.label}: ${b ? `${place(before!, b, score)} with ${fmt(b)} going into the round` : 'no games before this round'}; ${place(after, a, score)} with ${fmt(a)} after it.`);
  }
  return out.join('\n');
}

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
    const before = prev ? t.standingsAfter(prev.n) : null;
    const after = t.standingsAfter(n);
    if (before) out.push(`Team standings going into round ${n}:`, table(before, teamText, keep));
    out.push(`Team standings after round ${n}:`, table(after, teamText, keep));
    out.push(
      facts(before, after, (l) => l.mp, (l) => l.team, (l) => `${l.mp} match points`, [
        { label: `${wt} (${game.white_name}'s team)`, is: (l) => l.team === wt },
        { label: `${bt} (${game.black_name}'s team)`, is: (l) => l.team === bt },
      ]),
    );
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
  const before = prev ? a.standingsAfter(prev.n) : null;
  const after = a.standingsAfter(n);
  if (before) out.push(`Standings going into round ${n} (rank, player, points/games):`, table(before, lineText, keep));
  else out.push('This was the first round.');
  out.push(`Standings after round ${n}:`, table(after, lineText, keep));
  out.push(
    facts(before, after, (l) => l.points, (l) => l.player.name, (l) => `${pts(l.points)}/${l.games}`, [
      { label: game.white_name, is: (l) => l.player.id === W },
      { label: game.black_name, is: (l) => l.player.id === B },
    ]),
  );
  return out.join('\n');
}
