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

/** White's score; null for a game without a result ('*': uploaded tournaments can have them). */
export const whiteScore = (r: string) => (r === '1-0' ? 1 : r === '0-1' ? 0 : r === '1/2-1/2' ? 0.5 : null);
const decisive = (r: string) => r === '1-0' || r === '0-1';

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
  // p rounded to whole percent (half up), then looked up: 42.5% -> 43% -> -50.
  const pr = Math.round((score * 100) / oppElos.length);
  const dp = DP[Math.min(Math.abs(pr - 50), 50)] * (pr >= 50 ? 1 : -1);
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
  /** Every board is in the database with a result. */
  complete: boolean;
  /** The result is known: complete, or the missing boards couldn't change who won. */
  decided: boolean;
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
  /** Individual events: are (nearly) all games of every round in the database? Team events: is every match complete? */
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

  // Team tags alone don't make a team event: in individual opens the Team tag often holds the player's
  // country or club. Team matches have a shape: in a round a team meets one other team (share of
  // (round, team) keys with a single opponent; leagues that file two rounds under one tag still reach
  // 40%), on several boards; one board per pairing only when it's always the same opponent (just the
  // top boards in the database).
  const opponents = new Map<string, Set<string>>();
  const boardsPerPairing = new Map<string, number>();
  for (const g of teamGames) {
    const n = parsed.get(g.id)!.n;
    if (!n) continue;
    for (const [t, o] of [
      [g.white_team!, g.black_team!],
      [g.black_team!, g.white_team!],
    ]) {
      const k = `${n}:${t}`;
      (opponents.get(k) ?? opponents.set(k, new Set()).get(k)!).add(o);
    }
    const k = `${n}:${pairKey(g.white_team!, g.black_team!)}`;
    boardsPerPairing.set(k, (boardsPerPairing.get(k) ?? 0) + 1);
  }
  const oneOpponent = opponents.size ? [...opponents.values()].filter((s) => s.size === 1).length / opponents.size : 0;
  const pairingSizes = [...boardsPerPairing.values()].sort((x, y) => x - y);
  const boardsMedian = pairingSizes[Math.floor(pairingSizes.length / 2)] ?? 0;
  const teamShaped = boardsMedian >= 2 ? oneOpponent >= 0.4 : oneOpponent >= 0.95;
  // Two players: a match (playoffs and tiebreaks are often typed 'swiss' or 'tourn'), unless it's a single game.
  const isMatch = players.size === 2 && (type.includes('match') || games.length >= 2);

  let format: Format;
  if (games.length === 0 || roundless > games.length / 2) format = isMatch ? 'match' : 'games';
  else if (teamGames.length >= games.length * 0.6 && teamShaped) format = 'team';
  else if (isMatch) format = 'match';
  else if (players.size === 2) format = 'games';
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
        if (ws === null) continue; // not finished: counts for nobody yet
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
  if (format === 'team') {
    analysis.teams = analyseTeams(rounds, players);
    // Boards missing from the database (forfeits, unpublished games): the standings are approximate.
    analysis.complete = analysis.teams.matches.every((m) => m.complete);
  }
  if (format === 'knockout') analysis.knockout = analyseKnockout(rounds, players, parsed);
  if (format === 'match') analysis.knockout = [{ n: 1, name: 'Match', matches: [koMatch(1, [...games].sort((a, b) => a.id - b.id), players)] }];
  return analysis;
}

function stats(games: EventGame[]): EventAnalysis['stats'] {
  const white = games.filter((g) => g.result === '1-0').length;
  const black = games.filter((g) => g.result === '0-1').length;
  const draws = games.filter((g) => g.result === '1/2-1/2').length;
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
    draws,
    avgMoves: games.length ? Math.round(games.reduce((a, g) => a + g.plies, 0) / games.length / 2) : 0,
    topOpening: topOpening && topOpening.count > 1 ? topOpening : null,
  };
}

/** Biggest upset, longest game, quickest win (finished games only). */
export function highlights(all: EventGame[]): Highlight[] {
  const out: Highlight[] = [];
  const games = all.filter((g) => whiteScore(g.result) !== null);
  const won = games.filter((g) => decisive(g.result));
  let upset: { g: EventGame; diff: number } | null = null;
  for (const g of won) {
    if (!g.white_elo || !g.black_elo) continue;
    const diff = g.result === '1-0' ? g.black_elo - g.white_elo : g.white_elo - g.black_elo;
    if (diff >= 100 && (!upset || diff > upset.diff)) upset = { g, diff };
  }
  if (upset) out.push({ label: 'Biggest upset', game: upset.g, note: `won against a player rated ${upset.diff} points higher` });
  const longest = games.reduce<EventGame | null>((a, g) => (!a || g.plies > a.plies ? g : a), null);
  if (longest && longest.plies >= 120) out.push({ label: 'Longest game', game: longest, note: `${Math.ceil(longest.plies / 2)} moves` });
  const quickest = won.filter((g) => g.plies >= 10).reduce<EventGame | null>((a, g) => (!a || g.plies < a.plies ? g : a), null);
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
      let ap = 0;
      for (const g of list) {
        const ws = whiteScore(g.result);
        if (ws === null) continue;
        hp += g.white_team === home ? ws : 1 - ws;
        ap += g.white_team === home ? 1 - ws : ws;
      }
      matches.push({ round: r.n, home, away, homePts: hp, awayPts: ap, games: list, complete: true, decided: true });
    }
  }
  const boards = mode(matches.map((m) => m.games.length)) ?? 4;
  // A missing board (in TWIC usually a forfeit) or an unfinished game: the match is scored from the
  // games there are; it is undecided when the open boards could still change who won.
  for (const m of matches) {
    const open = Math.max(0, boards - m.games.length) + m.games.filter((g) => whiteScore(g.result) === null).length;
    m.complete = open === 0;
    m.decided = open === 0 || Math.abs(m.homePts - m.awayPts) > open;
  }
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
        // A match the missing boards could still turn gets no match points (W–D–L then add up to less than played).
        if (m.decided) {
          if (my > their) (l.mp += 2), l.w++;
          else if (my === their) (l.mp += 1), l.d++;
          else l.l++;
        }
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
      if (ws === null) return;
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
  // Level on points: the player seen in a later round went through; otherwise an odd number of games
  // (three or more) ending in a draw ends with an armageddon game, which Black wins on a draw.
  out.forEach((r, i) => {
    const ahead = new Set(out.slice(i + 1).flatMap((x) => x.matches.flatMap((m) => [m.a.id, m.b.id])));
    for (const m of r.matches) {
      if (m.winner !== null || m.aPts !== m.bPts) continue;
      const [inA, inB] = [ahead.has(m.a.id), ahead.has(m.b.id)];
      const last = m.games.at(-1)!;
      if (inA !== inB) m.winner = inA ? m.a.id : m.b.id;
      else if (m.games.length >= 3 && m.games.length % 2 === 1 && last.result === '1/2-1/2') m.winner = last.black_id;
    }
  });
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
  let bp = 0;
  for (const g of list) {
    const ws = whiteScore(g.result);
    if (ws === null) continue;
    ap += g.white_id === a.id ? ws : 1 - ws;
    bp += g.white_id === a.id ? 1 - ws : ws;
  }
  return { round, a, b, aPts: ap, bPts: bp, games: list, winner: ap > bp ? a.id : bp > ap ? b.id : null };
}

/**
 * The final of a knockout (or the match itself), when the database has it: a last round with one
 * match, or the final of "Final and third place". A last round of several matches is not a final
 * (the bracket isn't finished, or only early rounds are in the database).
 */
export function finalMatch(a: EventAnalysis): KoMatch | null {
  const last = a.knockout?.at(-1);
  return last && (last.matches.length === 1 || last.name.startsWith('Final')) ? last.matches[0] : null;
}

/** The winner(s): top of the final standings, the knockout final's winner, or the top team. */
export function winners(a: EventAnalysis): string[] {
  if (a.format === 'team' && a.teams) {
    const s = a.teams.standingsAfter(Infinity);
    return s.filter((l) => l.mp === s[0]?.mp && l.gp === s[0]?.gp).map((l) => l.team);
  }
  if (a.format === 'knockout' || a.format === 'match') {
    const final = finalMatch(a);
    return final?.winner ? [players(a, final.winner)] : [];
  }
  if (a.format === 'games' || !a.complete || !a.rounds.length) return []; // loose games, or a few games of two players: no standings
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
    if (!lead.length) return out; // no match between two teams yet (e.g. only intra-club games in round 1)
    if (isLast) out.push(lead.length === 1 ? `${lead[0].team} finish first with ${lead[0].mp} match points.` : `${list(lead.map((t) => t.team))} finish level on ${lead[0].mp} match points.`);
    else if (lead.length === 1) out.push(`${lead[0].team} lead with ${lead[0].mp} match points.`);
    else if (lead.length <= 4) out.push(`${list(lead.map((t) => t.team))} share the lead on ${lead[0].mp} match points.`);
    else out.push(`${lead.length} teams share the lead on ${lead[0].mp} match points.`);
    return out;
  }

  if (a.format === 'match' && a.knockout?.[0]?.matches[0]) {
    // A round is a game of the match (or a few, in tiebreaks): what happened, then the running score.
    const m = a.knockout[0].matches[0];
    const score = (from: number, to: number) => {
      let [x, y] = [0, 0];
      for (const rr of a.rounds)
        if (rr.n >= from && rr.n <= to)
          for (const g of rr.games) {
            const ws = whiteScore(g.result);
            if (ws === null) continue;
            x += g.white_id === m.a.id ? ws : 1 - ws;
            y += g.white_id === m.a.id ? 1 - ws : ws;
          }
      return [x, y];
    };
    if (r.games.length === 1) {
      const g = r.games[0];
      out.push(
        g.result === '1-0' ? `${g.white_name} won game ${n} with White.` : g.result === '0-1' ? `${g.black_name} won game ${n} with Black.` : g.result === '1/2-1/2' ? `Game ${n} was drawn.` : `Game ${n} has no result yet.`,
      );
    } else {
      const [x, y] = score(n, n);
      out.push(`${m.a.name} and ${m.b.name} played ${r.games.length} games in round ${n}: ${pts(x)}–${pts(y)}.`);
    }
    const [x, y] = score(-Infinity, n);
    const [hi, lo, leader] = x >= y ? [x, y, m.a.name] : [y, x, m.b.name];
    if (isLast) out.push(m.winner ? `${a.players.get(m.winner)!.name} wins the match ${pts(hi)}–${pts(lo)}.` : `The match ends level, ${pts(x)}–${pts(y)}.`);
    else out.push(x === y ? `The score is level, ${pts(x)}–${pts(y)}.` : `${leader} leads ${pts(hi)}–${pts(lo)}.`);
    return out;
  }

  if (a.knockout) {
    const round = a.knockout.find((k) => k.n === n);
    if (!round) return out;
    const typical = mode(round.matches.map((m) => m.games.length)) ?? 0;
    const name = (id: number) => a.players.get(id)!.name;
    if (round.matches.length === 1 || round.name.startsWith('Final')) {
      const m = round.matches[0];
      if (m.winner) {
        const score = `${pts(Math.max(m.aPts, m.bPts))}–${pts(Math.min(m.aPts, m.bPts))}`;
        const where = ` in the ${round.name === 'Final and third place' ? 'final' : round.name.toLowerCase()}`;
        const loser = name(m.winner === m.a.id ? m.b.id : m.a.id);
        // Level on points: decided by an armageddon game or a tiebreak not in the database.
        out.push(m.aPts === m.bPts ? `${name(m.winner)} beat ${loser}${where} on tiebreak after ${score}.` : `${name(m.winner)} beat ${loser} ${score}${where}.`);
      }
      else out.push(`${m.a.name} and ${m.b.name} are level ${pts(m.aPts)}–${pts(m.bPts)} in the games in the database.`);
    } else {
      const tiebreaks = round.matches.filter((m) => m.games.length > Math.min(typical, 2)).length;
      out.push(`${round.matches.length} matches${tiebreaks ? `, ${tiebreaks} of them decided after more than two games` : ''}.`);
      const upsets = round.matches.filter((m) => m.winner && m.a.elo && m.b.elo && (m.winner === m.a.id ? m.b.elo - m.a.elo : m.a.elo - m.b.elo) >= 100);
      if (upsets.length) out.push(`Upsets: ${list(upsets.slice(0, 3).map((m) => `${name(m.winner!)} knocked out ${name(m.winner === m.a.id ? m.b.id : m.a.id)}`))}.`);
    }
    return out;
  }

  // Unfinished games ('*') count as neither drawn nor decisive.
  const finished = r.games.filter((g) => whiteScore(g.result) !== null);
  const won = finished.filter((g) => decisive(g.result)).length;
  const b1 = r.games[0];
  if (b1) {
    const res =
      b1.result === '1-0'
        ? `${b1.white_name} beat ${b1.black_name} with the white pieces`
        : b1.result === '0-1'
          ? `${b1.black_name} beat ${b1.white_name} with the black pieces`
          : b1.result === '1/2-1/2'
            ? `${b1.white_name} and ${b1.black_name} drew`
            : `the game between ${b1.white_name} and ${b1.black_name} has no result yet`;
    out.push(`${a.complete ? 'On board 1' : 'On the top board'}, ${res}.`);
  }
  if (finished.length > 1)
    out.push(
      won === 0
        ? `All ${finished.length} games were drawn.`
        : won === finished.length
          ? `All ${finished.length} games were decisive.`
          : `${won} of ${finished.length} games ${won === 1 ? 'was' : 'were'} decisive.`,
    );
  if (!a.complete) return out;
  const after = a.standingsAfter(n);
  const before = n > (a.rounds[0]?.n ?? 1) ? a.standingsAfter(n - 1) : [];
  const lead = after.filter((l) => l.points === after[0]?.points);
  if (!lead.length) return out; // no finished game yet
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
