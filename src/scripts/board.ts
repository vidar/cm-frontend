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

/**
 * Minimal click-to-move chess board rendered as a CSS grid. With `onSquareClick` the squares are buttons with a
 * single tab stop (arrow keys move between squares); without it the board is read-only and takes no focus.
 */
export class Board {
  readonly el: HTMLElement;
  private squares = new Map<string, HTMLElement>();
  /** Squares in DOM (screen) order, row by row from the top left. */
  private order: string[] = [];
  private pieces = new Map<string, string>();
  private orientation: 'w' | 'b';
  private coords: boolean;
  private interactive: boolean;
  /** The square holding the board's one tab stop. */
  private focusSq = '';
  private overlay: SVGSVGElement;
  private arrows: Arrow[] = [];
  private suppressClick = false;

  constructor(container: HTMLElement, opts: BoardOptions = {}) {
    this.orientation = opts.orientation ?? 'w';
    this.coords = opts.coords ?? true;
    this.interactive = !!opts.onSquareClick;
    this.el = document.createElement('div');
    this.el.className = this.interactive ? 'cm-board' : 'cm-board readonly';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Chess board');
    container.replaceChildren(this.el);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('viewBox', '0 0 8 8');
    this.overlay.setAttribute('class', 'cm-arrows');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.el.addEventListener('click', (e) => {
      if (this.suppressClick) return void (this.suppressClick = false);
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-square]');
      if (btn) opts.onSquareClick?.(btn.dataset.square!);
    });
    if (this.interactive) {
      this.el.addEventListener('focusin', (e) => {
        const sq = (e.target as HTMLElement).closest<HTMLElement>('[data-square]')?.dataset.square;
        if (sq) this.setTabStop(sq);
      });
      this.el.addEventListener('keydown', (e) => this.onKey(e));
    }
    if (opts.canDrag && opts.onDrop) this.enableDrag(opts.canDrag, opts.onDrop);
    this.build();
  }

  /** Arrow keys move the focus between squares (in screen directions); the page's own shortcuts don't see them. */
  private onKey(e: KeyboardEvent) {
    const d = ({ ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] } as Record<string, [number, number]>)[e.key];
    const sq = (e.target as HTMLElement).closest<HTMLElement>('[data-square]')?.dataset.square;
    if (!d || !sq || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const i = this.order.indexOf(sq);
    const row = Math.max(0, Math.min(7, (i >> 3) + d[0]));
    const col = Math.max(0, Math.min(7, (i & 7) + d[1]));
    this.squares.get(this.order[row * 8 + col])?.focus();
  }

  private setTabStop(sq: string) {
    if (sq === this.focusSq || !this.squares.has(sq)) return;
    this.squares.get(this.focusSq)?.setAttribute('tabindex', '-1');
    this.squares.get(sq)!.setAttribute('tabindex', '0');
    this.focusSq = sq;
  }

  private enableDrag(canDrag: (sq: string) => boolean, onDrop: (from: string, to: string) => void) {
    this.el.classList.add('draggable');
    let from: string | null = null;
    let ghost: HTMLElement | null = null;
    let startX = 0, startY = 0, moved = false;
    const squareAt = (x: number, y: number) =>
      (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-square]')?.dataset.square;

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
      const sq = (e.target as HTMLElement).closest<HTMLElement>('[data-square]')?.dataset.square;
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
    // Flipping rebuilds the squares: keep the keyboard focus on the same square.
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.square : undefined;
    const old = new Map([...this.squares].map(([sq, el]) => [sq, el.className]));
    this.el.replaceChildren();
    this.squares.clear();
    this.order = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = this.orientation === 'w' ? col : 7 - col;
        const rank = this.orientation === 'w' ? 8 - row : row + 1;
        const sq = `${FILES[file]}${rank}`;
        let btn: HTMLElement;
        if (this.interactive) {
          btn = document.createElement('button');
          (btn as HTMLButtonElement).type = 'button';
          btn.tabIndex = -1;
          btn.setAttribute('aria-pressed', 'false');
        } else {
          btn = document.createElement('div');
          btn.setAttribute('role', 'img');
        }
        btn.dataset.square = sq;
        btn.className = old.get(sq) ?? `sq ${(file + rank) % 2 === 1 ? 'dark' : 'light'}`;
        if (this.coords && col === 0) btn.dataset.rank = String(rank);
        if (this.coords && row === 7) btn.dataset.file = FILES[file];
        this.el.append(btn);
        this.squares.set(sq, btn);
        this.order.push(sq);
      }
    }
    if (this.interactive) {
      const stop = this.focusSq || this.order[56]; // bottom left until a square gets focus
      this.focusSq = '';
      this.setTabStop(stop);
    }
    for (const [sq, p] of this.pieces) this.squares.get(sq)!.innerHTML = pieceSvg(p);
    this.label();
    this.el.append(this.overlay);
    this.drawArrows();
    if (focused) this.squares.get(focused)?.focus();
  }

  /** Square names for screen readers: "e4 white pawn, last move", and whether a square is selected. */
  private label() {
    for (const [sq, btn] of this.squares) {
      const p = this.pieces.get(sq);
      const notes = [btn.classList.contains('target') && 'legal move', btn.classList.contains('last') && 'last move'].filter(Boolean);
      btn.setAttribute('aria-label', [`${sq}${p ? ` ${pieceName(p)}` : ''}`, ...notes].join(', '));
      if (this.interactive) btn.setAttribute('aria-pressed', String(btn.classList.contains('selected')));
    }
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
    this.pieces.clear();
    for (const [sq, btn] of this.squares) {
      const piece = board[8 - Number(sq[1])][FILES.indexOf(sq[0])];
      if (piece) this.pieces.set(sq, piece);
      btn.innerHTML = piece ? pieceSvg(piece) : '';
    }
    this.label();
  }

  /** Replaces the set of squares carrying CSS class `cls`. */
  mark(cls: string, squares: Iterable<string> = []) {
    for (const btn of this.squares.values()) btn.classList.remove(cls);
    for (const sq of squares) this.squares.get(sq)?.classList.add(cls);
    this.label();
  }

  square(sq: string) {
    return this.squares.get(sq);
  }
}

const pieceSvg = (p: string) => `<svg viewBox="0 0 45 45" aria-hidden="true">${PIECES[p]}</svg>`;

/**
 * Scrolls `el` into view inside the scrolling box `list` only, like scrollIntoView({ block: 'nearest' }) but never
 * the page: on phones the move list sits below the board, and scrolling the page would hide the title and board.
 */
export function scrollWithin(list: HTMLElement, el: Element) {
  const box = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = box.top + list.clientTop;
  const bottom = top + list.clientHeight;
  if (r.top < top) list.scrollTop -= top - r.top + 4;
  else if (r.bottom > bottom) list.scrollTop += r.bottom - bottom + 4;
}

function pieceName(p: string) {
  const color = p[0] === 'w' ? 'white' : 'black';
  const name = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' }[p[1]];
  return `${color} ${name}`;
}
