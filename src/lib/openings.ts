import { Chess } from 'chess.js';

// lichess-org/chess-openings (CC0), see src/data/README.md.
const files = import.meta.glob('../data/openings/*.tsv', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

export interface Opening {
  slug: string;
  eco: string;
  name: string;
  /** Family name: the part before ":" (e.g. "Sicilian Defense"). */
  family: string;
  /** Variation part after ":" (may be empty). */
  variation: string;
  pgn: string;
  /** SAN moves without move numbers. */
  moves: string[];
  /** FEN after the last move. */
  fen: string;
  /** Last move squares, for highlighting. */
  lastMove: [string, string];
}

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

let cache: Opening[] | undefined;

export function getOpenings(): Opening[] {
  if (cache) return cache;
  const rows: { eco: string; name: string; pgn: string }[] = [];
  for (const text of Object.values(files)) {
    for (const line of text.trim().split('\n').slice(1)) {
      const [eco, name, pgn] = line.split('\t');
      if (eco && name && pgn) rows.push({ eco, name, pgn });
    }
  }

  // Some names cover several move orders; give each a unique slug.
  const nameCounts = new Map<string, number>();
  for (const r of rows) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  const used = new Map<string, number>();

  cache = rows.map(({ eco, name, pgn }) => {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    const last = history[history.length - 1];
    let slug = slugify(name);
    if ((nameCounts.get(name) ?? 0) > 1) {
      const n = (used.get(name) ?? 0) + 1;
      used.set(name, n);
      if (n > 1) slug = `${slug}-${n}`;
    }
    const [family, ...rest] = name.split(':');
    return {
      slug,
      eco,
      name,
      family: family.trim(),
      variation: rest.join(':').trim(),
      pgn,
      moves: history.map((m) => m.san),
      fen: chess.fen(),
      lastMove: [last.from, last.to] as [string, string],
    };
  });
  return cache;
}

export { formatMoves } from './chess/notation';

let byMoves: Map<string, Opening> | undefined;
/** First named line with exactly these SAN moves (joined with spaces). */
export function getByMoves(key: string): Opening | undefined {
  byMoves ??= new Map(getOpenings().map((o) => [o.moves.join(' '), o]).reverse() as [string, Opening][]);
  return byMoves.get(key);
}

let links: { parent: Map<Opening, Opening>; children: Map<Opening, Opening[]> } | undefined;

/** Parent = longest named line that this opening extends; computed once via a prefix index. */
function getLinks() {
  if (links) return links;
  const all = getOpenings();
  const byMoves = new Map<string, Opening>();
  for (const o of all) if (!byMoves.has(o.moves.join(' '))) byMoves.set(o.moves.join(' '), o);
  const parent = new Map<Opening, Opening>();
  const children = new Map<Opening, Opening[]>();
  for (const o of all) {
    for (let n = o.moves.length - 1; n > 0; n--) {
      const p = byMoves.get(o.moves.slice(0, n).join(' '));
      if (p && p !== o) {
        parent.set(o, p);
        children.set(p, [...(children.get(p) ?? []), o]);
        break;
      }
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.moves.length - b.moves.length || a.name.localeCompare(b.name));
  return (links = { parent, children });
}

/** The longest named opening that `o` continues from, if any. */
export const parentLine = (o: Opening) => getLinks().parent.get(o);

/** Named lines that directly continue from `o`. */
export const continuations = (o: Opening) => getLinks().children.get(o) ?? [];

export function familySlug(family: string) {
  return slugify(family);
}

/** Openings grouped by family, largest family first. */
export function getFamilies(): { name: string; slug: string; lines: Opening[] }[] {
  const map = new Map<string, Opening[]>();
  for (const o of getOpenings()) map.set(o.family, [...(map.get(o.family) ?? []), o]);
  return [...map.entries()]
    .map(([name, lines]) => ({ name, slug: familySlug(name), lines: lines.sort((a, b) => a.moves.length - b.moves.length || a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name));
}
