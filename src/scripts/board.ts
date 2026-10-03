import { PIECES } from '../lib/chess/pieces';
import { parsePlacement } from '../lib/chess/board-svg';

const FILES = 'abcdefgh';

export interface BoardOptions {
  orientation?: 'w' | 'b';
  coords?: boolean;
  onSquareClick?: (square: string) => void;
}

/** Minimal click-to-move chess board rendered as a CSS grid of buttons. */
export class Board {
  readonly el: HTMLElement;
  private squares = new Map<string, HTMLButtonElement>();
  private orientation: 'w' | 'b';
  private coords: boolean;

  constructor(container: HTMLElement, opts: BoardOptions = {}) {
    this.orientation = opts.orientation ?? 'w';
    this.coords = opts.coords ?? true;
    this.el = document.createElement('div');
    this.el.className = 'cm-board';
    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('aria-label', 'Chess board');
    container.replaceChildren(this.el);
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-square]');
      if (btn) opts.onSquareClick?.(btn.dataset.square!);
    });
    this.build();
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
