import { Chess } from 'chess.js';
import { Board } from './board';

/** Replays a game: board, clickable move list, buttons and arrow keys. */
export function mountGameViewer(root: HTMLElement) {
  const sans = (root.dataset.moves ?? '').split(' ').filter(Boolean);
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis: string[] = [];
  for (const san of sans) {
    const m = chess.move(san);
    fens.push(chess.fen());
    ucis.push(m.from + m.to);
  }
  let ply = Number(new URLSearchParams(location.search).get('ply') ?? sans.length);
  if (!(ply >= 0 && ply <= sans.length)) ply = sans.length;

  const board = new Board(root.querySelector<HTMLElement>('[data-board]')!, { orientation: root.dataset.flip === '1' ? 'b' : 'w' });
  const moveEls = [...root.querySelectorAll<HTMLElement>('[data-ply]')];
  const analyse = root.querySelector<HTMLAnchorElement>('[data-analyse]');

  function show(p: number) {
    ply = Math.max(0, Math.min(sans.length, p));
    board.setPosition(fens[ply]);
    board.mark('last', ply ? [ucis[ply - 1].slice(0, 2), ucis[ply - 1].slice(2, 4)] : []);
    for (const el of moveEls) el.classList.toggle('current', Number(el.dataset.ply) === ply);
    root.querySelector('[data-ply].current')?.scrollIntoView({ block: 'nearest' });
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
    show(ply);
  });
  for (const el of moveEls) el.addEventListener('click', () => show(Number(el.dataset.ply)));
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const fn = { ArrowLeft: () => show(ply - 1), ArrowRight: () => show(ply + 1), ArrowUp: () => show(0), ArrowDown: () => show(sans.length), Home: () => show(0), End: () => show(sans.length) }[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
  show(ply);
}
