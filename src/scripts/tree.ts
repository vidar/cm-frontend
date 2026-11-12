import { Chess, validateFen } from 'chess.js';
import { splitPgn } from '../lib/pgn';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface TreeNode {
  id: number;
  /** Half-move counter of this position (0 = before White's first move from the standard start). */
  ply: number;
  fen: string;
  san?: string;
  uci?: string;
  parent?: TreeNode;
  /** First child is the main continuation; the rest are variations. */
  children: TreeNode[];
}

/** A game with variations. Moves are validated with chess.js. */
export class GameTree {
  readonly root: TreeNode;
  private nextId = 1;
  private byId = new Map<number, TreeNode>();

  constructor(readonly startFen = START_FEN) {
    const [, side, , , , full] = startFen.split(' ');
    const ply = (Number(full) || 1) * 2 - 2 + (side === 'b' ? 1 : 0);
    this.root = { id: 0, ply, fen: startFen, children: [] };
    this.byId.set(0, this.root);
  }

  get(id: number) {
    return this.byId.get(id);
  }

  /** Plays a move (SAN or {from,to,promotion}) after `node`; reuses an existing child if it matches. */
  play(node: TreeNode, move: string | { from: string; to: string; promotion?: string }): TreeNode | null {
    const chess = new Chess(node.fen);
    let m;
    try {
      m = chess.move(move);
    } catch {
      return null;
    }
    const uci = m.from + m.to + (m.promotion ?? '');
    const existing = node.children.find((c) => c.uci === uci);
    if (existing) return existing;
    const child: TreeNode = { id: this.nextId++, ply: node.ply + 1, fen: chess.fen(), san: m.san, uci, parent: node, children: [] };
    node.children.push(child);
    this.byId.set(child.id, child);
    return child;
  }

  /** Nodes from the root to `node`, excluding the root. */
  path(node: TreeNode): TreeNode[] {
    const out: TreeNode[] = [];
    for (let n: TreeNode | undefined = node; n && n.parent; n = n.parent) out.unshift(n);
    return out;
  }

  /** Last node of the main continuation from `node`. */
  end(node: TreeNode): TreeNode {
    let n = node;
    while (n.children.length) n = n.children[0];
    return n;
  }

  /** Removes `node` and everything after it; returns its parent. */
  remove(node: TreeNode): TreeNode {
    const parent = node.parent!;
    parent.children = parent.children.filter((c) => c !== node);
    const drop = (n: TreeNode) => {
      this.byId.delete(n.id);
      n.children.forEach(drop);
    };
    drop(node);
    return parent;
  }

  /** Makes `node`'s line the main line at every branch point above it. */
  promote(node: TreeNode) {
    for (let n = node; n.parent; n = n.parent) {
      const siblings = n.parent.children;
      siblings.splice(siblings.indexOf(n), 1);
      siblings.unshift(n);
    }
  }

  /** PGN with variations. */
  toPgn(headers: Record<string, string> = {}): string {
    const h = { Event: 'Analysis', Site: 'https://chessmoments.com/analysis/', ...headers };
    if (this.startFen !== START_FEN) Object.assign(h, { SetUp: '1', FEN: this.startFen });
    const tags = Object.entries(h).map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`);
    const moves = renderLine(this.root, true).join(' ');
    return `${tags.join('\n')}\n\n${moves ? `${moves} ` : ''}*\n`;
  }
}

/** Move number prefix for a move played from `parent` ("12." for White, "12..." for Black when forced). */
export function moveLabel(node: TreeNode, force: boolean): string {
  const parentPly = node.ply - 1;
  const no = Math.floor(parentPly / 2) + 1;
  if (parentPly % 2 === 0) return `${no}. ${node.san}`;
  return force ? `${no}... ${node.san}` : node.san!;
}

function renderLine(from: TreeNode, forceNumber: boolean): string[] {
  const out: string[] = [];
  let p = from;
  let force = forceNumber;
  while (p.children.length) {
    const [main, ...variations] = p.children;
    out.push(moveLabel(main, force));
    force = false;
    for (const v of variations) {
      out.push(`(${[moveLabel(v, true), ...renderLine(v, false)].join(' ')})`);
      force = true;
    }
    p = main;
  }
  return out;
}

/**
 * Why a position can't be analysed, or null. chess.js accepts a FEN whose side not to move is in check (its king
 * could be captured): Stockfish crashes on those, and the board would let a move take the king.
 */
export function positionError(fen: string): string | null {
  const v = validateFen(fen);
  if (!v.ok) return (v.error ?? 'invalid FEN').replace(/^Invalid FEN: /, '');
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  if (new Chess(parts.join(' ')).isCheck()) {
    const [other, mover] = parts[1] === 'w' ? ['White', 'Black'] : ['Black', 'White'];
    return `${other} is in check with ${mover} to move, which can't happen in a game`;
  }
  return null;
}

/** Most moves (main line and variations together) an import replays; each costs CPU in the browser. */
export const MAX_IMPORT_MOVES = 5000;

/**
 * Reads PGN with its variations (chess.js keeps only the main line). Only the first game of the text is read.
 * Throws an Error with a short plain message; `notes` says what was left out.
 */
export function importPgn(text: string): { tree: GameTree; notes: string[] } {
  const games = splitPgn(text);
  const notes: string[] = [];
  if (games.length > 1) notes.push(`The text holds ${games.length} games; only the first was loaded.`);
  const tags: Record<string, string> = {};
  const body: string[] = [];
  for (const line of (games[0] ?? '').split('\n')) {
    const m = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(line);
    if (m) tags[m[1]] = m[2].replace(/\\(.)/g, '$1');
    else if (!line.startsWith('%')) body.push(line);
  }
  if (tags.Variant && !/^(standard|from position)$/i.test(tags.Variant)) throw new Error(`only standard chess is supported, not "${tags.Variant}"`);
  let start = START_FEN;
  if (tags.FEN) {
    const err = positionError(tags.FEN.trim());
    if (err) throw new Error(`the FEN tag is not a valid position: ${err}`);
    start = tags.FEN.trim();
  }
  const tree = new GameTree(start);
  let dropped = false;
  const movetext = body.join('\n').replace(/\{[^}]*\}?|;[^\n]*/g, () => ((dropped = true), ' '));
  let cur = tree.root; // position after the last move
  let prev: TreeNode | null = null; // position before it: where a variation branches off
  const stack: { cur: TreeNode; prev: TreeNode | null }[] = [];
  let count = 0;
  for (const tok of movetext.match(/[()]|[^\s()]+/g) ?? []) {
    if (tok === '(') {
      if (!prev) throw new Error('a variation starts before any move it could replace');
      stack.push({ cur, prev });
      cur = prev;
      prev = null;
    } else if (tok === ')') {
      const s = stack.pop();
      if (!s) throw new Error('a variation is closed with ")" that was never opened');
      ({ cur, prev } = s);
    } else if (/^\$\d+$/.test(tok) || /^[!?]+$/.test(tok)) {
      dropped = true;
    } else if (!/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) {
      // Move numbers may be glued to the move ("12.Nf3", "12...Nf6", "12…Nf6").
      const raw = tok.replace(/^\d+(\.+|…)/, '');
      if (!raw || /^[.…]+$/.test(raw)) continue;
      const san = raw.replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
      if (/[!?]$/.test(raw)) dropped = true;
      if (++count > MAX_IMPORT_MOVES) throw new Error(`more than ${MAX_IMPORT_MOVES} moves`);
      const next = tree.play(cur, san);
      if (!next) throw new Error(`"${raw}" is not a legal move ${cur.san ? `after ${moveLabel(cur, true)}` : 'in the starting position'}`);
      prev = cur;
      cur = next;
    }
  }
  if (dropped) notes.push('Comments and move marks (!, ?, $1) were left out: the board keeps the moves and variations.');
  return { tree, notes };
}
