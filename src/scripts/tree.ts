import { Chess } from 'chess.js';

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
