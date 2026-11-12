import { Chess } from 'chess.js';
import { Board, scrollWithin } from './board';

export interface Replay {
  sans: string[];
  /** Position before each half-move and after the last one (fens.length = sans.length + 1). */
  fens: string[];
  /** Each half-move in UCI, with the promotion piece ("e7e8q"). */
  ucis: string[];
}

/** Replays SAN moves from the start with chess.js. */
export function replaySans(sans: string[]): Replay {
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis: string[] = [];
  for (const san of sans) {
    const m = chess.move(san);
    fens.push(m.after);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
  }
  return { sans, fens, ucis };
}

const replays = new WeakMap<HTMLElement, Replay>();

/**
 * The game of a viewer element (its data-moves), replayed once per page: chess.js takes ~130 µs a move, so every
 * widget on a game page that needs positions or UCI moves should call this instead of replaying again.
 */
export function replayGame(viewer: HTMLElement): Replay {
  let r = replays.get(viewer);
  if (!r) replays.set(viewer, (r = replaySans((viewer.dataset.moves ?? '').split(' ').filter(Boolean))));
  return r;
}

/** "12. Nf3" / "12... Nf6" for half-move `ply` (1-based). */
const moveName = (sans: string[], ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${sans[ply - 1]}`;

/** Replays a game: board, move list, buttons and arrow keys. */
export function mountGameViewer(root: HTMLElement) {
  const { sans, fens, ucis } = replayGame(root);
  let ply = Number(new URLSearchParams(location.search).get('ply') ?? sans.length);
  if (!(ply >= 0 && ply <= sans.length)) ply = sans.length;

  const board = new Board(root.querySelector<HTMLElement>('[data-board]')!, { orientation: root.dataset.flip === '1' ? 'b' : 'w' });
  const moveEls = [...root.querySelectorAll<HTMLElement>('[data-ply]')];
  const list = moveEls[0]?.closest<HTMLElement>('.moves') ?? null;
  const analyse = root.querySelector<HTMLAnchorElement>('[data-analyse]');
  // The moves are one tab stop (the current move); Enter or Space picks a move, the arrow keys step.
  for (const el of moveEls) {
    el.setAttribute('role', 'button');
    el.tabIndex = -1;
  }
  const live = document.createElement('p');
  live.className = 'cm-sr-only';
  live.setAttribute('aria-live', 'polite');
  root.append(live);

  function show(p: number, announce = true) {
    ply = Math.max(0, Math.min(sans.length, p));
    board.setPosition(fens[ply]);
    board.mark('last', ply ? [ucis[ply - 1].slice(0, 2), ucis[ply - 1].slice(2, 4)] : []);
    const hadFocus = !!list?.contains(document.activeElement);
    let cur: HTMLElement | undefined;
    for (const el of moveEls) {
      const on = Number(el.dataset.ply) === ply;
      el.classList.toggle('current', on);
      if (on) {
        el.setAttribute('aria-current', 'true');
        cur = el;
      } else el.removeAttribute('aria-current');
      el.tabIndex = -1;
    }
    const stop = cur ?? moveEls[0];
    if (stop) stop.tabIndex = 0;
    // Scroll the move list only, never the page: on phones the list is below the board.
    if (cur && list) scrollWithin(list, cur);
    if (hadFocus) stop?.focus({ preventScroll: true });
    if (announce) live.textContent = ply ? moveName(sans, ply) : 'Starting position';
    root.dispatchEvent(new CustomEvent('cm:ply', { detail: { ply } }));
    if (analyse) {
      const u = new URL(analyse.href);
      u.searchParams.set('pgn', sans.slice(0, ply).join(' '));
      analyse.href = u.pathname + u.search;
    }
  }

  root.querySelector('[data-nav=start]')?.addEventListener('click', () => show(0));
  root.querySelector('[data-nav=prev]')?.addEventListener('click', () => show(ply - 1));
  root.querySelector('[data-nav=next]')?.addEventListener('click', () => show(ply + 1));
  root.querySelector('[data-nav=end]')?.addEventListener('click', () => show(sans.length));
  root.querySelector('[data-nav=flip]')?.addEventListener('click', () => {
    board.setOrientation(root.dataset.flip === '1' ? 'w' : 'b');
    root.dataset.flip = root.dataset.flip === '1' ? '0' : '1';
    show(ply, false);
  });
  for (const el of moveEls) {
    el.addEventListener('click', () => show(Number(el.dataset.ply)));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      show(Number(el.dataset.ply));
    });
  }
  // Other widgets (the engine analysis) can jump to a move.
  root.addEventListener('cm:goto', (e) => show((e as CustomEvent<{ ply: number }>).detail.ply));
  // ← → step through the game anywhere on the page. ↑ ↓ Home End only while the focus is in the viewer (board,
  // buttons, move list): elsewhere they scroll the page as usual, which also holds the analysis and the PGN.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const keys: Record<string, () => void> = { ArrowLeft: () => show(ply - 1), ArrowRight: () => show(ply + 1) };
    if (root.contains(t)) Object.assign(keys, { ArrowUp: () => show(0), ArrowDown: () => show(sans.length), Home: () => show(0), End: () => show(sans.length) });
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
  show(ply, false);
}
