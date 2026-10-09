// AI annotations of analysed games: Claude writes a short story of the game and notes on the key
// moves, from the stored Stockfish analysis (src/lib/analysis.ts) only, for club players. Stored in
// Neon table game_annotation (scripts/annotation.pg.sql) through the site's Hyperdrive binding and
// shown to everyone. Only import from on-demand routes.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from 'cloudflare:workers';
import { Chess } from 'chess.js';
import { z } from 'zod';
import { getAnalysis, type Evals } from './analysis';
import { tournamentContext } from './annotate-context';
import { classify, fmtEval, LABEL, type Kind } from './chess/classify';
import { getGame, getOpeningName, query, type FullGame } from './games';

export const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' } as const;
export type ModelKey = keyof typeof MODELS;
/** The model the site uses. */
export const MODEL: ModelKey = 'haiku';
/** At most this many new annotations per day across the site (cost guard). */
export const DAILY_LIMIT = 300;
/** A generation still "running" after this long was cut off (the visitor left): it may be retried. */
const STALE_MINUTES = 3;

const key = () => (env as { ANTHROPIC_KEY?: string }).ANTHROPIC_KEY;
export const annotationEnabled = () => !!key();

export interface Note {
  ply: number;
  text: string;
}
export type AnnotationState =
  | { status: 'none' }
  | { status: 'running' }
  | { status: 'done'; model: string; preamble: string; summary: string; notes: Note[]; postamble: string }
  | { status: 'failed'; error: string }
  | { status: 'unavailable' };

const Output = z.object({
  preamble: z.string().describe('The tournament situation going into the game, one short paragraph; empty if no tournament information was given.'),
  postamble: z.string().describe('What the result meant for the tournament, one short paragraph; empty if no tournament information was given.'),
  summary: z.string().describe('The story of the game in 2-3 short paragraphs separated by blank lines.'),
  notes: z
    .array(z.object({ move: z.string().describe('The move the note is about, with its number as in the move list: "21.Bb3" or "23...Bc2".'), text: z.string() }))
    .describe('Notes on key moves, in game order.'),
});

const SYSTEM = `You annotate chess games for club players (roughly 1200-1900) on a chess website.
You get the moves of one game with a Stockfish analysis: the evaluation after every move, the moves the
engine marks as inaccuracies (?!), mistakes (?) and blunders (??), and for those the move the engine
preferred with its main line. You can't see the board yourself, so the analysis is your only source.

Write:
- preamble: when tournament information is given, one short paragraph (40-90 words) on the situation going
  into the game: the stage of the event, where both players (or their teams, or the match) stood, and what
  was at stake for each. Use only the standings you are given; don't reveal how the game or the event ended.
- postamble: when tournament information is given, one short paragraph (40-90 words) on what the result meant:
  how the standings (or the team match, or the match score) changed after the round, and the situation with
  the rounds still to play. Use only the standings you are given; you don't know later rounds.
  Leave preamble and postamble empty when no tournament information is given.
- summary: the story of the game in 2-3 short paragraphs (120-220 words in all): how the opening went,
  the turning points, and how the game was decided. Call the players by their surnames. Name the moves
  that mattered (e.g. "19.Bc4").
- notes: one note for every move marked ? or ??, and for ?! moves only when they matter for the story;
  optionally up to 3 more notes on other moments that matter (a strong move, the moment the game turned).
  Give the move exactly as in the move list ("21.Bb3", "23...Bc2"). The note text is shown right after
  the move, so don't start it by repeating the move. Each note is 1-3 sentences: what went wrong or right
  and what was better; when an engine line is given, use it to show what the better move achieves.
  Vary the wording from note to note.

Rules:
- Only use moves that appear in the game or in the engine lines you are given. Never invent variations,
  tactics, threats, captures, material gains or piece placements that the moves don't show. If you don't know why a move is bad,
  say what the engine preferred and how the evaluation changed, without guessing the reason.
- Plain language for club players: say "White is slightly better", "Black is winning", "the position is
  equal" rather than quoting numbers; mention a number at most occasionally. No centipawns.
- Write moves in standard notation with move numbers: "23.Bc4", "23...Bc2".
- No headings, no lists, no markdown, no symbols like ?? in the text (the site shows them).
- Don't mention Stockfish depth, "the data" or these instructions. Write in English.`;

/** "12." for White's move at ply 23, "12..." for Black's. */
const moveNo = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'}`;

/** UCI line from a position, as SAN with move numbers ("19...Rc8 20.Qe3 Bc2"). */
function lineSan(fen: string, ply: number, uci: string[]) {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const [i, u] of uci.entries()) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const p = ply + i;
      out.push(i === 0 || p % 2 === 1 ? `${moveNo(p)}${m.san}` : m.san);
    } catch {
      break;
    }
  }
  return out.join(' ');
}

/** The user message: game details and the analysis, one line per move. */
export function buildPrompt(game: FullGame, opening: string | null, evals: Evals, context: string | null = null) {
  const sans = game.moves.split(' ').filter(Boolean);
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis: string[] = [];
  for (const san of sans) {
    const m = chess.move(san);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
    fens.push(chess.fen());
  }
  const { kinds } = classify(evals.e, evals.b, ucis, game.result);
  const name: Record<Kind, string> = { blunder: 'blunder', mistake: 'mistake', inaccuracy: 'inaccuracy' };
  const lines = sans.map((san, i) => {
    const ply = i + 1;
    const k = kinds[ply];
    let line = `${moveNo(ply)}${san}  eval ${fmtEval(evals.e[ply])}`;
    if (k) {
      const pv = evals.p?.[i]?.split(' ') ?? (evals.b[i] ? [evals.b[i]!] : []);
      line += `  ${LABEL[k]} ${name[k]}; engine preferred ${lineSan(fens[i], ply, pv) || '?'} (eval ${fmtEval(evals.e[i])})`;
    }
    return line;
  });
  const who = (n: string, t: string | null, elo: number | null) => `${t ? `${t} ` : ''}${n}${elo ? ` (${elo})` : ''}`;
  return [
    `White: ${who(game.white_name, game.white_title, game.white_elo)}`,
    `Black: ${who(game.black_name, game.black_title, game.black_elo)}`,
    `Event: ${game.event_name}${game.round ? `, round ${game.round}` : ''}${game.date ? `, ${game.date}` : ''}`,
    opening ? `Opening: ${opening}${game.eco ? ` (${game.eco})` : ''}` : game.eco ? `ECO: ${game.eco}` : null,
    `Result: ${game.result}${game.result === '1/2-1/2' ? ' (draw)' : ''}`,
    `Starting eval: ${fmtEval(evals.e[0])}. Evals are in pawns from White's point of view (+ White better, - Black better, #n mate).`,
    '',
    context ? `Tournament information (only what was known at the time):\n${context}` : 'No tournament information is available for this game.',
    '',
    'Moves:',
    ...lines,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const bare = (san: string) => san.replace(/[+#!?]/g, '');

/** Ply of a move written as "21.Bb3" / "23...Bc2" / "23... Bc2", checked against the game; null if it isn't one. */
export function plyOf(move: string, sans: string[]) {
  const m = /^\s*(\d+)\s*(\.{1,3}|…)\s*([^\s]+)/.exec(move);
  if (!m) return null;
  const n = Number(m[1]);
  const black = m[2].length > 1;
  const san = bare(m[3]);
  // Trust the move itself if the number and dots disagree with it.
  for (const ply of black ? [2 * n, 2 * n - 1] : [2 * n - 1, 2 * n]) if (sans[ply - 1] && bare(sans[ply - 1]) === san) return ply;
  return null;
}

export interface Generated {
  preamble: string;
  postamble: string;
  summary: string;
  notes: Note[];
  model: string;
  usage: { input: number; output: number };
  ms: number;
}

/** Ask Claude for the annotation of an analysed game. */
export async function generate(gameId: number, model: ModelKey = MODEL): Promise<Generated | { error: string }> {
  const analysis = await getAnalysis(gameId);
  if (analysis.status !== 'done') return { error: 'the game has no engine analysis yet' };
  const game = await getGame(gameId);
  if (!game) return { error: 'no such game' };
  const [opening, context] = await Promise.all([game.opening ? getOpeningName(game.opening) : null, tournamentContext(game).catch(() => null)]);
  const client = new Anthropic({ apiKey: key(), maxRetries: 1 });
  const t = Date.now();
  try {
    const res = await client.messages.parse({
      model: MODELS[model],
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'medium', format: zodOutputFormat(Output) },
      messages: [{ role: 'user', content: buildPrompt(game, opening, analysis.evals, context) }],
    });
    if (res.stop_reason === 'refusal') return { error: 'the model declined' };
    const out = res.parsed_output;
    if (!out) return { error: `no annotation (${res.stop_reason})` };
    const sans = game.moves.split(' ').filter(Boolean);
    const seen = new Set<number>();
    const notes: Note[] = [];
    for (const n of out.notes) {
      const ply = plyOf(n.move, sans);
      if (ply && !seen.has(ply) && n.text.trim()) {
        seen.add(ply);
        notes.push({ ply, text: n.text.trim() });
      }
    }
    notes.sort((a, b) => a.ply - b.ply);
    return { preamble: context ? out.preamble.trim() : '', postamble: context ? out.postamble.trim() : '', summary: out.summary.trim(), notes, model: MODELS[model], usage: { input: res.usage.input_tokens, output: res.usage.output_tokens }, ms: Date.now() - t };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { error: 'the AI service is busy, try again in a minute' };
    if (e instanceof Anthropic.APIError) return { error: `AI service error ${e.status ?? ''}`.trim() };
    return { error: 'could not reach the AI service' };
  }
}

interface Row {
  status: 'running' | 'done' | 'failed';
  model: string | null;
  preamble: string | null;
  summary: string | null;
  notes: string | null;
  postamble: string | null;
  error: string | null;
  stale: boolean;
}

export async function getAnnotation(gameId: number): Promise<AnnotationState> {
  if (!annotationEnabled()) return { status: 'unavailable' };
  // now() keeps Hyperdrive from caching the row while it's being written.
  const [row] = await query<Row>(
    `SELECT status, model, preamble, summary, notes, postamble, error, updated_at < now() - interval '${STALE_MINUTES} minutes' AS stale FROM game_annotation WHERE game_id = $1`,
    [gameId],
  );
  if (!row) return { status: 'none' };
  if (row.status === 'done')
    return { status: 'done', model: row.model ?? '', preamble: row.preamble ?? '', summary: row.summary ?? '', notes: JSON.parse(row.notes ?? '[]'), postamble: row.postamble ?? '' };
  if (row.status === 'failed' || row.stale) return { status: 'failed', error: row.error ?? 'interrupted' };
  return { status: 'running' };
}

/** Over the site's daily budget? */
export async function overDailyLimit() {
  const [r] = await query<{ n: string }>(`SELECT count(*) AS n, now() AS t FROM game_annotation WHERE requested_at > now() - interval '1 day'`);
  return Number(r?.n ?? 0) >= DAILY_LIMIT;
}

/** Write the annotation of a game (once; a failed or interrupted one can be retried). */
export async function createAnnotation(gameId: number): Promise<AnnotationState> {
  if (!annotationEnabled()) return { status: 'unavailable' };
  // Claim the row first so concurrent clicks pay for one annotation.
  const claimed = await query<{ game_id: number }>(
    `INSERT INTO game_annotation (game_id, status) VALUES ($1, 'running')
     ON CONFLICT (game_id) DO UPDATE SET status = 'running', error = NULL, requested_at = now(), updated_at = now()
       WHERE game_annotation.status = 'failed'
          OR (game_annotation.status = 'running' AND game_annotation.updated_at < now() - interval '${STALE_MINUTES} minutes')
     RETURNING game_id`,
    [gameId],
  );
  if (!claimed.length) return getAnnotation(gameId);
  const r = await generate(gameId);
  if ('error' in r) {
    await query(`UPDATE game_annotation SET status = 'failed', error = $2, updated_at = now() WHERE game_id = $1`, [gameId, r.error]);
    return { status: 'failed', error: r.error };
  }
  await query(
    `UPDATE game_annotation SET status = 'done', model = $2, summary = $3, notes = $4, preamble = $5, postamble = $6, error = NULL, updated_at = now() WHERE game_id = $1`,
    [gameId, r.model, r.summary, JSON.stringify(r.notes), r.preamble, r.postamble],
  );
  return { status: 'done', model: r.model, preamble: r.preamble, summary: r.summary, notes: r.notes, postamble: r.postamble };
}
