import { PIECES } from './pieces';

export const LIGHT = '#f0d9b5';
export const DARK = '#b58863';
const HIGHLIGHT = 'rgba(226, 168, 48, 0.42)';

const FILES = 'abcdefgh';

export interface BoardSvgOptions {
  /** FEN string; only the piece-placement field is required. */
  fen: string;
  /** View from Black's side. */
  flip?: boolean;
  /** Output width/height in px (the SVG still scales freely). */
  size?: number;
  /** Draw file/rank labels on the edge squares. */
  coords?: boolean;
  /** Colours from the page's board style (CSS variables, see Layout.astro); only for inline SVG. */
  themable?: boolean;
  /** Squares to highlight, e.g. ["e2", "e4"] for the last move. */
  highlight?: string[];
  /** Accessible title. */
  title?: string;
}

/** Parses the piece-placement field of a FEN into an 8x8 array (rank 8 first). */
export function parsePlacement(fen: string): (string | null)[][] {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error('FEN must have 8 ranks');
  return ranks.map((rank) => {
    const row: (string | null)[] = [];
    for (const ch of rank) {
      if (/[1-8]/.test(ch)) row.push(...Array<null>(Number(ch)).fill(null));
      else if (/[prnbqkPRNBQK]/.test(ch)) row.push(ch === ch.toUpperCase() ? `w${ch}` : `b${ch.toUpperCase()}`);
      else throw new Error(`Invalid FEN character "${ch}"`);
    }
    if (row.length !== 8) throw new Error('Each FEN rank must have 8 squares');
    return row;
  });
}

export function isValidSquare(sq: string): boolean {
  return /^[a-h][1-8]$/.test(sq);
}

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Renders a chess position as a standalone SVG string (8 units per square = 45px piece art). */
export function renderBoardSvg({ fen, flip = false, size = 400, coords = true, highlight = [], title, themable = false }: BoardSvgOptions): string {
  // Fill as an attribute (works everywhere, e.g. in <img> and resvg) or as a themable style.
  const fill = (v: string, fallback: string) => (themable ? `style="fill:var(${v}, ${fallback})"` : `fill="${fallback}"`);
  const board = parsePlacement(fen);
  const S = 45;
  const parts: string[] = [];
  const used = new Set<string>();
  const hl = new Set(highlight.filter(isValidSquare));

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flip ? 7 - col : col;
      const rank = flip ? row + 1 : 8 - row; // 1..8
      const sq = `${FILES[file]}${rank}`;
      const x = col * S;
      const y = row * S;
      const dark = (file + rank) % 2 === 1; // a1 (file 0, rank 1) is dark
      parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" ${dark ? fill('--sq-dark', DARK) : fill('--sq-light', LIGHT)}/>`);
      if (hl.has(sq)) parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" ${fill('--sq-last', HIGHLIGHT)}/>`);
      const piece = board[8 - rank][file];
      if (piece) {
        used.add(piece);
        parts.push(`<use href="#${piece}" xlink:href="#${piece}" x="${x}" y="${y}"/>`);
      }
      if (coords) {
        const color = dark ? fill('--sq-light', LIGHT) : fill('--sq-dark', DARK);
        if (col === 0)
          parts.push(`<text x="${x + 1.5}" y="${y + 10}" font-size="9" font-family="sans-serif" font-weight="600" ${color}>${rank}</text>`);
        if (row === 7)
          parts.push(`<text x="${x + S - 1.5}" y="${y + S - 2}" font-size="9" font-family="sans-serif" font-weight="600" text-anchor="end" ${color}>${FILES[file]}</text>`);
      }
    }
  }

  const label = title ?? `Chess position ${fen.split(/\s+/)[0]}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 360 360" width="${size}" height="${size}" role="img" aria-label="${escapeXml(label)}">` +
    `<title>${escapeXml(label)}</title><defs>${[...used].map((p) => `<g id="${p}">${PIECES[p]}</g>`).join('')}</defs>${parts.join('')}</svg>`
  );
}
