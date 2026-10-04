// Tournament analysis for event pages: works out the format (round robin, Swiss, knockout, match,
// team event) from an event's games and computes standings, crosstables, team matches, knockout
// brackets and highlights. Pure functions over the rows from `eventGamesAll()` (src/lib/games.ts).
//
// TWIC's Round tag: '5' or '5.3' = round 5 (board 3) in individual events, round 5 match 3 in team
// events (boards in file order, i.e. id order), '5.3.2' = knockout round 5, match 3, game 2.

export interface EventGame {
  id: number;
  white_id: number;
  black_id: number;
  white_elo: number | null;
  black_elo: number | null;
  white_title: string | null;
  black_title: string | null;
  result: string;
  date: string | null;
  round: string | null;
  plies: number;
  eco: string | null;
  opening: string | null;
  opening_name: string | null;
  white_team: string | null;
  black_team: string | null;
  white_name: string;
  white_slug: string;
  white_fed: string | null;
  black_name: string;
  black_slug: string;
  black_fed: string | null;
  event_name: string;
  event_slug: string;
}

export type Format = 'round-robin' | 'swiss' | 'knockout' | 'match' | 'team' | 'games';

export interface Player {
  id: number;
  name: string;
  slug: string;
  title: string | null;
  fed: string | null;
  elo: number | null;
  team: string | null;
}

export interface RoundInfo {
  n: number;
  /** Games in board order. */
  games: EventGame[];
  first: string | null;
  last: string | null;
}

export interface PlayerResult {
  round: number;
  opp: number;
  color: 'w' | 'b';
  score: number;
  game: EventGame;
}

export interface Line {
  player: Player;
  rank: number;
  points: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Sonneborn-Berger and Buchholz (opponents' points). */
  sb: number;
  buchholz: number;
  perf: number | null;
  results: PlayerResult[];
}

// ---- small helpers ---------------------------------------------------------------------------

export const whiteScore = (r: string) => (r === '1-0' ? 1 : r === '0-1' ? 0 : 0.5);

/** 6.5 -> '6½', 0.5 -> '½'. */
export function pts(x: number) {
  const whole = Math.floor(x + 1e-9);
  const half = x - whole > 0.25;
  return half ? (whole ? `${whole}½` : '½') : String(whole);
}

export function parseRound(r: string | null): { n: number | null; sub: number[] } {
  const m = /^\s*(\d+)((?:\.\d+)*)/.exec(r ?? '');
  if (!m) return { n: null, sub: [] };
  const n = Number(m[1]);
  return { n: n > 0 && n <= 60 ? n : null, sub: m[2] ? m[2].slice(1).split('.').map(Number) : [] };
}

const pairKey = (a: number | string, b: number | string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// FIDE rating difference by percentage score (0.50 .. 1.00).
const DP = [0, 7, 14, 21, 29, 36, 43, 50, 57, 65, 72, 80, 87, 95, 102, 110, 117, 125, 133, 141, 149, 158, 166, 175, 184, 193, 202, 211, 220, 230, 240, 251, 262, 273, 284, 296, 309, 322, 336, 351, 366, 383, 401, 422, 444, 470, 501, 538, 589, 677, 800];

/** FIDE performance rating from opponents' ratings and the score against them. */
export function performance(oppElos: number[], score: number) {
  if (oppElos.length < 3) return null;
  const p = score / oppElos.length;
  const i = Math.round(Math.abs(p - 0.5) * 100);
  const dp = DP[Math.min(i, 50)] * (p >= 0.5 ? 1 : -1);
  return Math.round(oppElos.reduce((a, b) => a + b, 0) / oppElos.length + dp);
}

function mode<T>(xs: T[]): T | null {
  const c = new Map<T, number>();
  let best: T | null = null;
  let bestN = 0;
  for (const x of xs) {
    const n = (c.get(x) ?? 0) + 1;
    c.set(x, n);
    if (n > bestN) [best, bestN] = [x, n];
  }
  return best;
}

// ---- analysis --------------------------------------------------------------------------------

export interface TeamMatch {
  round: number;
  home: string;
  away: string;
  homePts: number;
  awayPts: number;
  /** Board order; board 1 first. */
  games: EventGame[];
  complete: boolean;
}

export interface TeamLine {
  team: string;
  rank: number;
  mp: number;
  gp: number;
  played: number;
  w: number;
  d: number;
  l: number;
  matches: { round: number; opp: string; my: number; their: number; match: TeamMatch }[];
}

export interface RosterLine {
  player: Player;
  board: number;
  games: number;
  points: number;
  perf: number | null;
}

export interface KoMatch {
  round: number;
  a: Player;
  b: Player;
  aPts: number;
  bPts: number;
  games: EventGame[];
  winner: number | null;
}

export interface KoRound {
  n: number;
  name: string;
  matches: KoMatch[];
}

export interface Highlight {
  label: string;
  game: EventGame;
  note: string;
}

export interface EventAnalysis {
  format: Format;
  players: Map<number, Player>;
  rounds: RoundInfo[];
  /** Individual events: are (nearly) all games of every round in the database? */
  complete: boolean;
  coverage: number;
  /** Round robin: number of cycles (1 = single, 2 = double round robin). */
  cycles: number;
  avgElo: number | null;
  category: number | null;
  standingsAfter: (round: number) => Line[];
  teams?: {
    boards: number;
    matches: TeamMatch[];
    standingsAfter: (round: number) => TeamLine[];
    rosters: Map<string, RosterLine[]>;
    roundRobin: boolean;
  };
  knockout?: KoRound[];
  stats: { games: number; white: number; draws: number; black: number; avgMoves: number; topOpening: { slug: string; name: string; count: number } | null };
  highlights: Highlight[];
}

export function analyseEvent(games: EventGame[], eventType: string | null): EventAnalysis {
  const type = (eventType ?? '').toLowerCase();
  const players = new Map<number, Player>();
  const elos = new Map<number, number[]>();
  const teamsOf = new Map<number, string[]>();
  for (const g of games) {
    for (const side of ['white', 'black'] as const) {
      const id = g[`${side}_id`];
      if (!players.has(id))
        players.set(id, { id, name: g[`${side}_name`], slug: g[`${side}_slug`], title: g[`${side}_title`], fed: g[`${side}_fed`], elo: null, team: null });
      const elo = g[`${side}_elo`];
      if (elo) (elos.get(id) ?? elos.set(id, []).get(id)!).push(elo);
      const team = g[`${side}_team`];
      if (team) (teamsOf.get(id) ?? teamsOf.set(id, []).get(id)!).push(team);
      if (g[`${side}_title`]) players.get(id)!.title = g[`${side}_title`];
    }
  }
  for (const [id, p] of players) {
    p.elo = mode(elos.get(id) ?? []);
    p.team = mode(teamsOf.get(id) ?? []);
  }

  // Rounds, games in board order.
  const parsed = new Map(games.map((g) => [g.id, parseRound(g.round)]));
  const byRound = new Map<number, EventGame[]>();
  for (const g of games) {
    const n = parsed.get(g.id)!.n;
    if (n) (byRound.get(n) ?? byRound.set(n, []).get(n)!).push(g);
  }
  const roundless = games.length - [...byRound.values()].reduce((a, r) => a + r.length, 0);

  // Format.
  const teamGames = games.filter((g) => g.white_team && g.black_team && g.white_team !== g.black_team);
  const roundPair = new Map<string, number>();
  for (const g of games) {
    const n = parsed.get(g.id)!.n;
    if (n) roundPair.set(`${n}:${pairKey(g.white_id, g.black_id)}`, (roundPair.get(`${n}:${pairKey(g.white_id, g.black_id)}`) ?? 0) + 1);
  }
  const repeatedInRound = games.filter((g) => {
    const n = parsed.get(g.id)!.n;
    return n && (roundPair.get(`${n}:${pairKey(g.white_id, g.black_id)}`) ?? 0) > 1;
  }).length;
  const threePart = games.filter((g) => parsed.get(g.id)!.sub.length >= 2).length;

  let format: Format;
  if (games.length === 0 || roundless > games.length / 2) format = players.size === 2 ? 'match' : 'games';
  else if (teamGames.length >= games.length * 0.6) format = 'team';
  else if (players.size === 2) format = 'match';
  else if (type.includes('k.o') || threePart > games.length * 0.5 || repeatedInRound > games.length * 0.6) format = 'knockout';
  else format = 'swiss';

  const sortBoards = (list: EventGame[]) =>
    list.sort((a, b) => {
      const sa = parsed.get(a.id)!.sub;
      const sb = parsed.get(b.id)!.sub;
      return format !== 'team' && format !== 'knockout' && sa[0] !== undefined && sb[0] !== undefined && sa[0] !== sb[0] ? sa[0] - sb[0] : a.id - b.id;
    });
  const rounds: RoundInfo[] = [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const list = sortBoards(byRound.get(n)!);
      const dates = list.map((g) => g.date).filter((d): d is string => !!d).sort();
      return { n, games: list, first: dates[0] ?? null, last: dates.at(-1) ?? null };
    });
  const lastRound = rounds.at(-1)?.n ?? 0;

  // Round robin: few players and (nearly) every pair met.
  const pairs = new Map<string, number>();
  for (const g of games) pairs.set(pairKey(g.white_id, g.black_id), (pairs.get(pairKey(g.white_id, g.black_id)) ?? 0) + 1);
  const n = players.size;
  const cycles = Math.max(1, Math.round(games.length / Math.max(1, pairs.size)));
  if (format === 'swiss' && n >= 3 && n <= 30 && pairs.size >= ((n * (n - 1)) / 2) * 0.85) format = 'round-robin';

  // Coverage. Round robin: games against the full schedule. Swiss: in a complete event most players
  // play (nearly) every round; when only the top boards were published, most play just a few.
  const perPlayer = new Map<number, number>();
  for (const g of games) {
    perPlayer.set(g.white_id, (perPlayer.get(g.white_id) ?? 0) + 1);
    perPlayer.set(g.black_id, (perPlayer.get(g.black_id) ?? 0) + 1);
  }
  const counts = [...perPlayer.values()].sort((x, y) => x - y);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const coverage =
    format === 'round-robin' ? Math.min(1, games.length / (((n * (n - 1)) / 2) * cycles)) : rounds.length ? Math.min(1, median / rounds.length) : 0;
  // Big opens are often covered only on the top boards: then the "standings" would be wrong.
  const complete = format === 'round-robin' ? coverage >= 0.85 : format === 'swiss' ? coverage >= 0.75 : true;

  // Individual standings after a round (memoised).
  const memo = new Map<number, Line[]>();
  const standingsAfter = (upto: number): Line[] => {
    const key = Math.min(upto, lastRound);
    if (memo.has(key)) return memo.get(key)!;
    const lines = new Map<number, Line>();
    const line = (id: number) =>
      lines.get(id) ??
      lines.set(id, { player: players.get(id)!, rank: 0, points: 0, games: 0, wins: 0, draws: 0, losses: 0, sb: 0, buchholz: 0, perf: null, results: [] }).get(id)!;
    for (const id of players.keys()) line(id);
    for (const r of rounds) {
      if (r.n > key) break;
      for (const g of r.games) {
        const ws = whiteScore(g.result);
        for (const [id, opp, color, s] of [
          [g.white_id, g.black_id, 'w', ws],
          [g.black_id, g.white_id, 'b', 1 - ws],
        ] as const) {
          const l = line(id);
          l.points += s;
          l.games++;
          if (s === 1) l.wins++;
          else if (s === 0) l.losses++;
          else l.draws++;
          l.results.push({ round: r.n, opp, color, score: s, game: g });
        }
      }
    }
    for (const l of lines.values()) {
      for (const res of l.results) {
        const opp = lines.get(res.opp)!;
        l.buchholz += opp.points;
        l.sb += res.score * opp.points;
      }
      const oppElos = l.results.map((r) => players.get(r.opp)!.elo).filter((e): e is number => !!e);
      const rated = l.results.filter((r) => players.get(r.opp)!.elo);
      l.perf = performance(oppElos, rated.reduce((a, r) => a + r.score, 0));
    }
    const sorted = [...lines.values()]
      .filter((l) => l.games > 0 || key === 0)
      .sort((a, b) =>
        format === 'round-robin'
          ? b.points - a.points || b.sb - a.sb || b.wins - a.wins || (b.player.elo ?? 0) - (a.player.elo ?? 0)
          : b.points - a.points || b.buchholz - a.buchholz || b.sb - a.sb || (b.player.elo ?? 0) - (a.player.elo ?? 0),
      );
    sorted.forEach((l, i) => (l.rank = i + 1));
    memo.set(key, sorted);
    return sorted;
  };

  // Average rating / FIDE category (round robins).
  const ratings = [...players.values()].map((p) => p.elo).filter((e): e is number => !!e);
  const avgElo = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  const category = format === 'round-robin' && avgElo && avgElo >= 2251 && ratings.length === n ? Math.floor((avgElo - 2251) / 25) + 1 : null;

  const analysis: EventAnalysis = {
    format,
    players,
    rounds,
    complete,
    coverage,
    cycles,
    avgElo,
    category,
    standingsAfter,
    stats: stats(games),
    highlights: highlights(games),
  };
  if (format === 'team') analysis.teams = analyseTeams(rounds, players);
  if (format === 'knockout') analysis.knockout = analyseKnockout(rounds, players, parsed);
  if (format === 'match') analysis.knockout = [{ n: 1, name: 'Match', matches: [koMatch(1, [...games].sort((a, b) => a.id - b.id), players)] }];
  return analysis;
}

function stats(games: EventGame[]): EventAnalysis['stats'] {
  const white = games.filter((g) => g.result === '1-0').length;
  const black = games.filter((g) => g.result === '0-1').length;
  const openings = new Map<string, { slug: string; name: string; count: number }>();
  for (const g of games) {
    if (!g.opening || !g.opening_name) continue;
    // Group by the family name ("Sicilian Defense: Najdorf" -> "Sicilian Defense").
    const family = g.opening_name.split(':')[0];
    const o = openings.get(family) ?? openings.set(family, { slug: g.opening, name: family, count: 0 }).get(family)!;
    if (g.opening_name === family) o.slug = g.opening;
    o.count++;
  }
  const topOpening = [...openings.values()].sort((a, b) => b.count - a.count)[0] ?? null;
  return {
    games: games.length,
    white,
    black,
    draws: games.length - white - black,
    avgMoves: games.length ? Math.round(games.reduce((a, g) => a + g.plies, 0) / games.length / 2) : 0,
    topOpening: topOpening && topOpening.count > 1 ? topOpening : null,
  };
}

/** Biggest upset, longest game, quickest win. */
export function highlights(games: EventGame[]): Highlight[] {
  const out: Highlight[] = [];
  const decisive = games.filter((g) => g.result !== '1/2-1/2');
  let upset: { g: EventGame; diff: number } | null = null;
  for (const g of decisive) {
    if (!g.white_elo || !g.black_elo) continue;
    const diff = g.result === '1-0' ? g.black_elo - g.white_elo : g.white_elo - g.black_elo;
    if (diff >= 100 && (!upset || diff > upset.diff)) upset = { g, diff };
  }
  if (upset) out.push({ label: 'Biggest upset', game: upset.g, note: `won against a player rated ${upset.diff} points higher` });
  const longest = games.reduce<EventGame | null>((a, g) => (!a || g.plies > a.plies ? g : a), null);
  if (longest && longest.plies >= 120) out.push({ label: 'Longest game', game: longest, note: `${Math.ceil(longest.plies / 2)} moves` });
  const quickest = decisive.filter((g) => g.plies >= 10).reduce<EventGame | null>((a, g) => (!a || g.plies < a.plies ? g : a), null);
  if (quickest && quickest.plies <= 60) out.push({ label: 'Quickest win', game: quickest, note: `${Math.ceil(quickest.plies / 2)} moves` });
  return out;
}

function analyseTeams(rounds: RoundInfo[], players: Map<number, Player>): NonNullable<EventAnalysis['teams']> {
  const matches: TeamMatch[] = [];
  for (const r of rounds) {
    const byPair = new Map<string, EventGame[]>();
    for (const g of r.games) {
      if (!g.white_team || !g.black_team || g.white_team === g.black_team) continue;
      const k = pairKey(g.white_team, g.black_team);
      (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(g);
    }
    for (const list of byPair.values()) {
      list.sort((a, b) => a.id - b.id);
      const home = list[0].white_team!;
      const away = list[0].black_team!;
      let hp = 0;
      for (const g of list) hp += g.white_team === home ? whiteScore(g.result) : 1 - whiteScore(g.result);
      matches.push({ round: r.n, home, away, homePts: hp, awayPts: list.length - hp, games: list, complete: true });
    }
  }
  const boards = mode(matches.map((m) => m.games.length)) ?? 4;
  for (const m of matches) m.complete = m.games.length >= boards;
  // Order matches in a round by table: strongest pairing first (as in TWIC's files).
  matches.sort((a, b) => a.round - b.round || a.games[0].id - b.games[0].id);

  const teams = new Set(matches.flatMap((m) => [m.home, m.away]));
  const memo = new Map<number, TeamLine[]>();
  const standingsAfter = (upto: number) => {
    if (memo.has(upto)) return memo.get(upto)!;
    const lines = new Map<string, TeamLine>([...teams].map((t) => [t, { team: t, rank: 0, mp: 0, gp: 0, played: 0, w: 0, d: 0, l: 0, matches: [] }]));
    for (const m of matches) {
      if (m.round > upto) continue;
      for (const [t, o, my, their] of [
        [m.home, m.away, m.homePts, m.awayPts],
        [m.away, m.home, m.awayPts, m.homePts],
      ] as const) {
        const l = lines.get(t)!;
        l.played++;
        l.gp += my;
        if (my > their) (l.mp += 2), l.w++;
        else if (my === their) (l.mp += 1), l.d++;
        else l.l++;
        l.matches.push({ round: m.round, opp: o, my, their, match: m });
      }
    }
    const sorted = [...lines.values()].filter((l) => l.played).sort((a, b) => b.mp - a.mp || b.gp - a.gp || a.team.localeCompare(b.team));
    sorted.forEach((l, i) => (l.rank = i + 1));
    memo.set(upto, sorted);
    return sorted;
  };

  // Rosters: each player's usual board, score and performance.
  const rosterData = new Map<number, { team: string; boards: number[]; points: number; opps: number[]; ratedPts: number; games: number }>();
  for (const m of matches) {
    m.games.forEach((g, i) => {
      const ws = whiteScore(g.result);
      for (const [id, team, s, opp] of [
        [g.white_id, g.white_team!, ws, g.black_id],
        [g.black_id, g.black_team!, 1 - ws, g.white_id],
      ] as const) {
        const d = rosterData.get(id) ?? rosterData.set(id, { team, boards: [], points: 0, opps: [], ratedPts: 0, games: 0 }).get(id)!;
        d.boards.push(i + 1);
        d.points += s;
        d.games++;
        const oe = players.get(opp)?.elo;
        if (oe) d.opps.push(oe), (d.ratedPts += s);
      }
    });
  }
  const rosters = new Map<string, RosterLine[]>();
  for (const [id, d] of rosterData) {
    const list = rosters.get(d.team) ?? rosters.set(d.team, []).get(d.team)!;
    list.push({ player: players.get(id)!, board: mode(d.boards) ?? 0, games: d.games, points: d.points, perf: performance(d.opps, d.ratedPts) });
  }
  for (const list of rosters.values()) list.sort((a, b) => a.board - b.board || b.games - a.games);

  const pairsMet = new Set(matches.map((m) => pairKey(m.home, m.away)));
  const t = teams.size;
  return { boards, matches, standingsAfter, rosters, roundRobin: t >= 3 && t <= 20 && pairsMet.size >= ((t * (t - 1)) / 2) * 0.85 };
}

function analyseKnockout(rounds: RoundInfo[], players: Map<number, Player>, parsed: Map<number, { n: number | null; sub: number[] }>): KoRound[] {
  const out: KoRound[] = [];
  for (const r of rounds) {
    const byPair = new Map<string, EventGame[]>();
    for (const g of r.games) {
      const k = pairKey(g.white_id, g.black_id);
      (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(g);
    }
    // Games of a match in played order (ids follow date and file order).
    const matches = [...byPair.values()].map((list) => koMatch(r.n, list.sort((x, y) => x.id - y.id), players));
    matches.sort((x, y) => (parsed.get(x.games[0].id)!.sub[0] ?? 0) - (parsed.get(y.games[0].id)!.sub[0] ?? 0) || x.games[0].id - y.games[0].id);
    out.push({ n: r.n, name: `Round ${r.n}`, matches });
  }
  // Name the last rounds by size; in a final round with two matches, the final is the one between
  // the previous round's winners (the other is the third-place match).
  const last = out.at(-1);
  if (last && out.length > 1) {
    const prevWinners = new Set(out.at(-2)!.matches.map((m) => m.winner));
    if (last.matches.length === 1) last.name = 'Final';
    else if (last.matches.length === 2 && out.at(-2)!.matches.length === 2) {
      last.name = 'Final and third place';
      const isFinal = (m: KoMatch) => (prevWinners.has(m.a.id) && prevWinners.has(m.b.id) ? 0 : 1);
      last.matches.sort((x, y) => isFinal(x) - isFinal(y));
    }
    const names = ['Semi-finals', 'Quarter-finals'];
    for (let i = out.length - 2, k = 0; i >= 0 && k < names.length; i--, k++) {
      const want = 2 ** (k + 1);
      if (out[i].matches.length === want) out[i].name = names[k];
      else break;
    }
  }
  return out;
}

function koMatch(round: number, list: EventGame[], players: Map<number, Player>): KoMatch {
  const a = players.get(list[0].white_id)!;
  const b = players.get(list[0].black_id)!;
  let ap = 0;
  for (const g of list) ap += g.white_id === a.id ? whiteScore(g.result) : 1 - whiteScore(g.result);
  const bp = list.length - ap;
  return { round, a, b, aPts: ap, bPts: bp, games: list, winner: ap > bp ? a.id : bp > ap ? b.id : null };
}

/** The winner(s): top of the final standings, the knockout final's winner, or the top team. */
export function winners(a: EventAnalysis): string[] {
  if (a.format === 'team' && a.teams) {
    const s = a.teams.standingsAfter(Infinity);
    return s.filter((l) => l.mp === s[0]?.mp && l.gp === s[0]?.gp).map((l) => l.team);
  }
  if ((a.format === 'knockout' || a.format === 'match') && a.knockout?.length) {
    const final = a.knockout.at(-1)!.matches[0];
    return final.winner ? [players(a, final.winner)] : [];
  }
  if (!a.complete) return [];
  const s = a.standingsAfter(Infinity);
  return s.filter((l) => l.points === s[0]?.points).map((l) => l.player.name);
}
const players = (a: EventAnalysis, id: number) => a.players.get(id)?.name ?? '';

export const FORMAT_LABEL: Record<Format, string> = {
  'round-robin': 'Round robin',
  swiss: 'Swiss',
  knockout: 'Knockout',
  match: 'Match',
  team: 'Team event',
  games: 'Games',
};

// ---- round stories ---------------------------------------------------------------------------

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A few sentences on what happened in a round, from the results and the standings. */
export function roundStory(a: EventAnalysis, n: number): string[] {
  const r = a.rounds.find((x) => x.n === n);
  if (!r) return [];
  const out: string[] = [];
  const isLast = n === a.rounds.at(-1)?.n;

  if (a.format === 'team' && a.teams) {
    const ms = a.teams.matches.filter((m) => m.round === n);
    const after0 = a.teams.standingsAfter(n)[0]?.team;
    // Leagues play all matches in parallel: follow the leaders. Team Swiss: table 1.
    const top = (a.teams.roundRobin && ms.find((m) => m.home === after0 || m.away === after0)) || ms[0];
    if (top) {
      const [w, l, ws, ls] = top.homePts >= top.awayPts ? [top.home, top.away, top.homePts, top.awayPts] : [top.away, top.home, top.awayPts, top.homePts];
      const where = a.teams.roundRobin ? '' : 'On the top table, ';
      out.push(ws === ls ? `${where}${top.home} and ${top.away} drew ${pts(ws)}–${pts(ls)}.` : `${where}${w} beat ${l} ${pts(ws)}–${pts(ls)}.`);
    }
    const after = a.teams.standingsAfter(n);
    const lead = after.filter((t) => t.mp === after[0]?.mp);
    if (lead.length && isLast) out.push(lead.length === 1 ? `${lead[0].team} finish first with ${lead[0].mp} match points.` : `${list(lead.map((t) => t.team))} finish level on ${lead[0].mp} match points.`);
    else if (lead.length === 1) out.push(`${lead[0].team} lead with ${lead[0].mp} match points.`);
    else if (lead.length <= 4) out.push(`${list(lead.map((t) => t.team))} share the lead on ${lead[0].mp} match points.`);
    else out.push(`${lead.length} teams share the lead on ${lead[0].mp} match points.`);
    return out;
  }

  if (a.knockout) {
    const round = a.knockout.find((k) => k.n === n);
    if (!round) return out;
    const typical = mode(round.matches.map((m) => m.games.length)) ?? 0;
    const name = (id: number) => a.players.get(id)!.name;
    if (round.matches.length === 1 || round.name.startsWith('Final')) {
      const m = round.matches[0];
      if (m.winner) out.push(`${name(m.winner)} beat ${name(m.winner === m.a.id ? m.b.id : m.a.id)} ${pts(Math.max(m.aPts, m.bPts))}–${pts(Math.min(m.aPts, m.bPts))}${a.format === 'match' ? '.' : ` in the ${round.name === 'Final and third place' ? 'final' : round.name.toLowerCase()}.`}`);
      else out.push(`${m.a.name} and ${m.b.name} are level ${pts(m.aPts)}–${pts(m.bPts)} in the games in the database.`);
    } else {
      const tiebreaks = round.matches.filter((m) => m.games.length > Math.min(typical, 2)).length;
      out.push(`${round.matches.length} matches${tiebreaks ? `, ${tiebreaks} of them decided after more than two games` : ''}.`);
      const upsets = round.matches.filter((m) => m.winner && m.a.elo && m.b.elo && (m.winner === m.a.id ? m.b.elo - m.a.elo : m.a.elo - m.b.elo) >= 100);
      if (upsets.length) out.push(`Upsets: ${list(upsets.slice(0, 3).map((m) => `${name(m.winner!)} knocked out ${name(m.winner === m.a.id ? m.b.id : m.a.id)}`))}.`);
    }
    return out;
  }

  const decisive = r.games.filter((g) => g.result !== '1/2-1/2').length;
  const b1 = r.games[0];
  if (b1) {
    const res = b1.result === '1-0' ? `${b1.white_name} beat ${b1.black_name}` : b1.result === '0-1' ? `${b1.black_name} beat ${b1.white_name}` : `${b1.white_name} and ${b1.black_name} drew`;
    out.push(`${a.complete ? 'On board 1' : 'On the top board'}, ${res}${b1.result !== '1/2-1/2' ? ` with the ${b1.result === '1-0' ? 'white' : 'black'} pieces` : ''}.`);
  }
  if (r.games.length > 1)
    out.push(
      decisive === 0
        ? `All ${r.games.length} games were drawn.`
        : decisive === r.games.length
          ? `All ${r.games.length} games were decisive.`
          : `${decisive} of ${r.games.length} games ${decisive === 1 ? 'was' : 'were'} decisive.`,
    );
  if (!a.complete) return out;
  const after = a.standingsAfter(n);
  const before = n > (a.rounds[0]?.n ?? 1) ? a.standingsAfter(n - 1) : [];
  const lead = after.filter((l) => l.points === after[0]?.points);
  const leadBefore = before.filter((l) => l.points === before[0]?.points).map((l) => l.player.id);
  const score = `${pts(lead[0]?.points ?? 0)}/${lead[0]?.games ?? 0}`;
  if (isLast) {
    out.push(lead.length === 1 ? `${lead[0].player.name} wins the tournament with ${score}.` : `${list(lead.map((l) => l.player.name))} finish level on ${score}.`);
  } else if (lead.length === 1) {
    const same = leadBefore.length === 1 && leadBefore[0] === lead[0].player.id;
    out.push(`${lead[0].player.name} ${same ? 'keeps the sole lead' : leadBefore.includes(lead[0].player.id) ? 'takes the sole lead' : 'moves into the sole lead'} with ${score}.`);
  } else if (lead.length === after.length) {
    out.push(`Everyone is level on ${score}.`);
  } else if (lead.length <= 4) {
    out.push(`${list(lead.map((l) => l.player.name))} share the lead on ${score}.`);
  } else {
    out.push(`${lead.length} players share the lead on ${score}.`);
  }
  return out;
}
