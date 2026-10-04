import { PIECES } from '../lib/chess/pieces';
import { parsePlacement } from '../lib/chess/board-svg';

const FILES = 'abcdefgh';

export interface BoardOptions {
  orientation?: 'w' | 'b';
  coords?: boolean;
  onSquareClick?: (square: string) => void;
  /** Enables drag and drop for pieces on squares where this returns true. */
  canDrag?: (square: string) => boolean;
  /** Called when a piece is dropped on another square. */
  onDrop?: (from: string, to: string) => void;
}

export interface Arrow {
  from: string;
  to: string;
  color?: string;
  opacity?: number;
}

/** Minimal click-to-move chess board rendered as a CSS grid of buttons. */
export class Board {
  readonly el: HTMLElement;
  private squares = new Map<string, HTMLButtonElement>();
  private orientation: 'w' | 'b';
  private coords: boolean;
  private overlay: SVGSVGElement;
  private arrows: Arrow[] = [];
  private suppressClick = false;

  constructor(container: HTMLElement, opts: BoardOptions = {}) {
    this.orientation = opts.orientation ?? 'w';
    this.coords = opts.coords ?? true;
    this.el = document.createElement('div');
    this.el.className = 'cm-board';
    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('aria-label', 'Chess board');
    container.replaceChildren(this.el);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('viewBox', '0 0 8 8');
    this.overlay.setAttribute('class', 'cm-arrows');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.el.addEventListener('click', (e) => {
      if (this.suppressClick) return void (this.suppressClick = false);
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-square]');
      if (btn) opts.onSquareClick?.(btn.dataset.square!);
    });
    if (opts.canDrag && opts.onDrop) this.enableDrag(opts.canDrag, opts.onDrop);
    this.build();
  }

  private enableDrag(canDrag: (sq: string) => boolean, onDrop: (from: string, to: string) => void) {
    this.el.classList.add('draggable');
    let from: string | null = null;
    let ghost: HTMLElement | null = null;
    let startX = 0, startY = 0, moved = false;
    const squareAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('button[data-square]')?.dataset.square;

    // Window-level listeners (no pointer capture), so a plain click still reaches the square button.
    const onMove = (e: PointerEvent) => {
      if (!from) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      if (!moved) {
        moved = true;
        const src = this.squares.get(from)!;
        const size = src.getBoundingClientRect().width;
        ghost = document.createElement('div');
        ghost.className = 'cm-ghost';
        ghost.style.width = ghost.style.height = `${size}px`;
        ghost.innerHTML = src.innerHTML;
        document.body.append(ghost);
        src.classList.add('dragging');
      }
      const size = ghost!.offsetWidth;
      ghost!.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!from) return;
      const f = from;
      from = null;
      if (!moved) return; // a plain click: handled by the click listener
      ghost?.remove();
      ghost = null;
      this.squares.get(f)?.classList.remove('dragging');
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
      const to = e.type === 'pointerup' ? squareAt(e.clientX, e.clientY) : undefined;
      if (to && to !== f) onDrop(f, to);
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sq = (e.target as HTMLElement).closest<HTMLElement>('button[data-square]')?.dataset.square;
      if (!sq || !canDrag(sq) || !this.squares.get(sq)?.querySelector('svg')) return;
      from = sq;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  private build() {
    this.el.replaceChildren();
    this.squares.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = this.orientation === 'w' ? col : 7 - col;
        const rank = this.orientation === 'w' ? 8 - row : row + 1;
        const sq = `${FILES[file]}${rank}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.square = sq;
        btn.className = `sq ${(file + rank) % 2 === 1 ? 'dark' : 'light'}`;
        btn.setAttribute('aria-label', sq);
        if (this.coords && col === 0) btn.dataset.rank = String(rank);
        if (this.coords && row === 7) btn.dataset.file = FILES[file];
        this.el.append(btn);
        this.squares.set(sq, btn);
      }
    }
    this.el.append(this.overlay);
    this.drawArrows();
  }

  /** Draws arrows over the board (e.g. engine suggestions). */
  setArrows(arrows: Arrow[]) {
    this.arrows = arrows;
    this.drawArrows();
  }

  private drawArrows() {
    const pos = (sq: string) => {
      const f = FILES.indexOf(sq[0]);
      const r = Number(sq[1]);
      return this.orientation === 'w' ? [f + 0.5, 8 - r + 0.5] : [7 - f + 0.5, r - 0.5];
    };
    this.overlay.innerHTML = this.arrows
      .map(({ from, to, color = '#15781b', opacity = 0.8 }, i) => {
        const [x1, y1] = pos(from);
        const [x2, y2] = pos(to);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        const ex = x2 - ux * 0.3, ey = y2 - uy * 0.3; // stop the shaft short of the head
        const id = `cm-head-${i}`;
        return (
          `<defs><marker id="${id}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto" markerUnits="strokeWidth">` +
          `<path d="M0,0 L4,2 L0,4 z" fill="${color}"/></marker></defs>` +
          `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="0.17" stroke-linecap="round" opacity="${opacity}" marker-end="url(#${id})"/>`
        );
      })
      .join('');
  }

  setOrientation(o: 'w' | 'b') {
    if (o === this.orientation) return;
    this.orientation = o;
    this.build();
  }

  /** Draws pieces from a FEN (piece placement only is fine); pass "8/8/8/8/8/8/8/8" for empty. */
  setPosition(fen: string) {
    const board = parsePlacement(fen);
    for (const [sq, btn] of this.squares) {
      const piece = board[8 - Number(sq[1])][FILES.indexOf(sq[0])];
      btn.innerHTML = piece ? `<svg viewBox="0 0 45 45" aria-hidden="true">${PIECES[piece]}</svg>` : '';
      btn.setAttribute('aria-label', piece ? `${sq} ${pieceName(piece)}` : sq);
    }
  }

  /** Replaces the set of squares carrying CSS class `cls`. */
  mark(cls: string, squares: Iterable<string> = []) {
    for (const btn of this.squares.values()) btn.classList.remove(cls);
    for (const sq of squares) this.squares.get(sq)?.classList.add(cls);
  }

  square(sq: string) {
    return this.squares.get(sq);
  }
}

function pieceName(p: string) {
  const color = p[0] === 'w' ? 'white' : 'black';
  const name = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' }[p[1]];
  return `${color} ${name}`;
}
