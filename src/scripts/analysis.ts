import { Chess, type Square } from 'chess.js';
import { Board, scrollWithin } from './board';
import { Engine, evalBarPercent, type EngineLine } from './engine';
import { GameTree, START_FEN, importPgn, moveLabel, positionError, type TreeNode } from './tree';
import { formatEval, formatMovesFrom } from '../lib/chess/notation';

const FEN_RE = /^[prnbqkPRNBQK1-8]+(\/[prnbqkPRNBQK1-8]+){7}(\s|$)/;
/** Looks like a FEN's piece placement, but with the wrong number of ranks. */
const FENISH_RE = /^[prnbqkPRNBQK1-8]*\/[prnbqkPRNBQK1-8/]*(\s|$)/;

/** Fills in missing FEN fields so "placement w" style input works too. */
function normalizeFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  const defaults = ['', 'w', '-', '-', '0', '1'];
  return defaults.map((d, i) => parts[i] ?? d).join(' ');
}

export function mountAnalysis(root: HTMLElement) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const movesEl = $('moves');
  const linesEl = $('engine-lines');
  const statusEl = $('engine-status');
  const engineToggle = $<HTMLInputElement>('engine-on');
  const evalbar = $('evalbar');
  const evalFill = $('evalbar-fill');
  const announce = $('move-announce');

  let tree = new GameTree();
  let current: TreeNode = tree.root;
  let orientation: 'w' | 'b' = 'w';
  let selected: Square | null = null;
  let engine: Engine | null = null;
  let engineLoaded = false;
  let openingIndex: Record<string, [string, string, string]> | null = null;
  let openingRequested = false;
  let mounted = false; // the first render doesn't announce a move

  const board = new Board($('board'), {
    onSquareClick: (sq) => onSquareClick(sq as Square),
    canDrag: (sq) => new Chess(current.fen).get(sq as Square)?.color === turn(),
    onDrop: (from, to) => void tryMove(from as Square, to as Square),
  });

  const turn = () => (current.fen.split(' ')[1] as 'w' | 'b');

  // ---------- loading ----------
  /** Loads a FEN or PGN; returns an error message, or the notes on what was left out. */
  function load(text: string): { error: string } | { notes: string[] } {
    const t = text.trim();
    let notes: string[] = [];
    try {
      if (!t) {
        tree = new GameTree();
      } else if (FEN_RE.test(t)) {
        const fen = normalizeFen(t);
        const err = positionError(fen);
        if (err) return { error: err };
        tree = new GameTree(fen);
      } else if (FENISH_RE.test(t)) {
        return { error: 'a FEN needs 8 ranks separated by "/"' };
      } else {
        ({ tree, notes } = importPgn(t));
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
    current = tree.end(tree.root);
    return { notes };
  }

  function showImportResult(r: ReturnType<typeof load>, prefix: string) {
    const err = 'error' in r ? r.error : '';
    $('import-error').hidden = !err;
    $('import-error').textContent = err ? `${prefix}: ${err}` : '';
    const notes = 'notes' in r ? r.notes : [];
    $('import-note').hidden = !notes.length;
    $('import-note').textContent = notes.join(' ');
  }

  // ---------- moves ----------
  function select(sq: Square | null) {
    selected = sq;
    board.mark('selected', sq ? [sq] : []);
    board.mark('target', sq ? new Chess(current.fen).moves({ square: sq, verbose: true }).map((m) => m.to) : []);
  }

  function onSquareClick(sq: Square) {
    const piece = new Chess(current.fen).get(sq);
    if (selected && sq !== selected && !(piece && piece.color === turn())) {
      void tryMove(selected, sq);
    } else if (piece && piece.color === turn()) {
      select(sq === selected ? null : sq);
    } else {
      select(null);
    }
  }

  async function tryMove(from: Square, to: Square) {
    const legal = new Chess(current.fen).moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!legal.length) return select(null);
    let promotion: string | undefined;
    if (legal[0].promotion) {
      promotion = await askPromotion();
      if (!promotion) return select(null);
    }
    const next = tree.play(current, { from, to, promotion });
    select(null);
    if (next) goTo(next);
  }

  function askPromotion(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dlg = document.createElement('div');
      dlg.className = 'promo';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-label', 'Promote to');
      dlg.innerHTML = ['q', 'r', 'b', 'n']
        .map((p) => `<button type="button" data-p="${p}">${{ q: '♕ Queen', r: '♖ Rook', b: '♗ Bishop', n: '♘ Knight' }[p]}</button>`)
        .join('') + '<button type="button" data-p="">Cancel</button>';
      dlg.addEventListener('click', (e) => {
        const p = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.p;
        if (p === undefined) return;
        dlg.remove();
        resolve(p || undefined);
      });
      $('board').append(dlg);
      dlg.querySelector('button')?.focus();
    });
  }

  function goTo(node: TreeNode | undefined) {
    if (!node) return;
    current = node;
    render();
  }

  // ---------- rendering ----------
  function renderMoves() {
    const html: string[] = [];
    const mv = (n: TreeNode, force: boolean) => {
      const label = moveLabel(n, force);
      const sp = label.lastIndexOf(' ');
      const num = sp > 0 ? `<span class="num">${label.slice(0, sp)}</span> ` : '';
      return `${num}<button type="button" class="mv${n === current ? ' current" aria-current="true' : ''}" data-id="${n.id}">${n.san}</button>`;
    };
    const line = (from: TreeNode, force: boolean): string => {
      const out: string[] = [];
      let p = from;
      let f = force;
      while (p.children.length) {
        const [main, ...vars] = p.children;
        out.push(mv(main, f));
        f = false;
        for (const v of vars) {
          out.push(`<span class="var">(${[mv(v, true), line(v, false)].filter(Boolean).join(' ')})</span>`);
          f = true;
        }
        p = main;
      }
      return out.join(' ');
    };
    html.push(line(tree.root, true));
    // Re-rendering replaces the buttons: keep the keyboard focus in the move list, on the current move.
    const hadFocus = movesEl.contains(document.activeElement);
    movesEl.innerHTML = html.join('') || '<span class="muted">Play a move on the board, or import a game below.</span>';
    const cur = movesEl.querySelector<HTMLElement>('.current');
    if (cur) scrollWithin(movesEl, cur);
    if (hadFocus) (cur ?? movesEl.querySelector<HTMLElement>('.mv'))?.focus({ preventScroll: true });
  }

  function renderOpening() {
    const el = $('opening');
    if (tree.startFen !== START_FEN) return void (el.textContent = '');
    if (!openingIndex) {
      if (!openingRequested) {
        openingRequested = true;
        fetch('/openings-index.json')
          .then((r) => r.json())
          .then((idx) => {
            openingIndex = idx;
            renderOpening();
          })
          .catch(() => {});
      }
      return;
    }
    const sans = tree.path(current).map((n) => n.san!);
    for (let k = sans.length; k > 0; k--) {
      const hit = openingIndex[sans.slice(0, k).join(' ')];
      if (hit) {
        el.innerHTML = `Opening: <a href="/openings/${hit[0]}/">${hit[1]}</a> <span class="muted">${hit[2]}</span>`;
        return;
      }
    }
    el.textContent = '';
  }

  function renderExport() {
    const sans = tree.path(current).map((n) => n.san!).join(' ');
    const params = new URLSearchParams();
    if (tree.startFen !== START_FEN) params.set('fen', tree.startFen.replace(/ /g, '_'));
    if (sans) params.set('pgn', sans);
    if (orientation === 'b') params.set('flip', '1');
    const qs = params.toString().replace(/%2F/g, '/').replace(/\+/g, '%20');
    $<HTMLInputElement>('fen-out').value = current.fen;
    $<HTMLInputElement>('link-out').value = `${location.origin}/analysis/${qs ? `?${qs}` : ''}`;
    $<HTMLTextAreaElement>('pgn-out').value = tree.toPgn();
    const img = new URLSearchParams({ fen: current.fen.replace(/ /g, '_') });
    if (current.uci) img.set('lastmove', current.uci.slice(0, 4));
    if (orientation === 'b') img.set('flip', '1');
    $<HTMLAnchorElement>('image-link').href = `/board.svg?${img.toString().replace(/%2F/g, '/')}`;
  }

  function render() {
    if (mounted) announce.textContent = current.san ? moveLabel(current, true) : 'Starting position';
    board.setPosition(current.fen);
    board.mark('last', current.uci ? [current.uci.slice(0, 2), current.uci.slice(2, 4)] : []);
    select(null);
    board.setArrows([]);
    renderMoves();
    renderOpening();
    renderExport();
    $<HTMLButtonElement>('promote').disabled = !tree.path(current).some((n) => n.parent && n.parent.children[0] !== n);
    $<HTMLButtonElement>('delete').disabled = current === tree.root;
    analyse();
  }

  // ---------- engine ----------
  function setBar(l: Pick<EngineLine, 'cp' | 'mate'> | null) {
    evalFill.style.height = `${l ? evalBarPercent(l) : 50}%`;
  }

  function analyse() {
    linesEl.innerHTML = '';
    const chess = new Chess(current.fen);
    if (chess.isGameOver()) {
      engine?.stop();
      board.setArrows([]);
      const result = chess.isCheckmate() ? `Checkmate — ${turn() === 'w' ? 'Black' : 'White'} wins` : 'Draw';
      statusEl.textContent = result;
      setBar(chess.isCheckmate() ? { cp: null, mate: turn() === 'w' ? -1 : 1 } : { cp: 0, mate: null });
      return;
    }
    if (!engineToggle.checked) {
      engine?.stop();
      board.setArrows([]);
      statusEl.textContent = 'off';
      setBar(null);
      return;
    }
    if (!engine) {
      const e = (engine = new Engine());
      e.onUpdate = showLines;
      // The engine files didn't load or Stockfish crashed: say so; the next position tries a new worker.
      e.onError = () => {
        e.destroy();
        if (engine !== e) return;
        engine = null;
        engineLoaded = false;
        statusEl.textContent = 'engine unavailable';
        linesEl.innerHTML = '';
        board.setArrows([]);
      };
      void e.ready.then(() => (engineLoaded = engine === e));
      // A failed download of the engine files doesn't always raise an error in the worker: don't say "loading" forever.
      setTimeout(() => {
        if (engine === e && !engineLoaded && statusEl.textContent === 'loading engine…') statusEl.textContent = "engine unavailable: it didn't load";
      }, 30_000);
    }
    statusEl.textContent = engineLoaded ? 'thinking…' : 'loading engine…';
    void engine.analyse(current.fen);
  }

  function showLines(lines: EngineLine[]) {
    if (!lines.length) return;
    const fen = current.fen;
    statusEl.textContent = `depth ${lines[0].depth}`;
    setBar(lines[0]);
    const best = lines[0].pv[0];
    board.setArrows(best ? [{ from: best.slice(0, 2), to: best.slice(2, 4) }] : []);
    // The lines are redrawn on every engine update: keep the keyboard focus on the same line.
    const focused = [...linesEl.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement);
    linesEl.innerHTML = lines
      .map((l) => {
        const chess = new Chess(fen);
        const san: string[] = [];
        for (const uci of l.pv.slice(0, 10)) {
          try {
            san.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
          } catch {
            break;
          }
        }
        return `<li><button type="button" class="line" data-uci="${l.pv[0] ?? ''}"><span class="score">${formatEval(l)}</span> ${formatMovesFrom(san, current.ply)}</button></li>`;
      })
      .join('');
    if (focused >= 0) linesEl.querySelectorAll('button')[focused]?.focus({ preventScroll: true });
  }

  linesEl.addEventListener('click', (e) => {
    const uci = (e.target as HTMLElement).closest<HTMLElement>('[data-uci]')?.dataset.uci;
    if (!uci) return;
    const next = tree.play(current, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (!next) return;
    // The lines are cleared for the new position: a keyboard user continues from the move just played.
    const hadFocus = linesEl.contains(document.activeElement);
    goTo(next);
    if (hadFocus) movesEl.querySelector<HTMLElement>('.current')?.focus({ preventScroll: true });
  });
  engineToggle.addEventListener('change', analyse);

  // ---------- navigation and actions ----------
  const nav = {
    start: () => goTo(tree.root),
    prev: () => goTo(current.parent),
    next: () => goTo(current.children[0]),
    end: () => goTo(tree.end(current)),
  };
  root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) =>
    b.addEventListener('click', () => nav[b.dataset.nav as keyof typeof nav]()),
  );
  const flip = () => {
    orientation = orientation === 'w' ? 'b' : 'w';
    board.setOrientation(orientation);
    evalbar.classList.toggle('flipped', orientation === 'b');
    render();
  };
  $('flip').addEventListener('click', flip);
  movesEl.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.mv')?.dataset.id;
    if (id) goTo(tree.get(Number(id)));
  });
  $('promote').addEventListener('click', () => {
    tree.promote(current);
    render();
  });
  $('delete').addEventListener('click', () => {
    if (current !== tree.root) goTo(tree.remove(current));
  });
  $('import').addEventListener('click', () => {
    const r = load($<HTMLTextAreaElement>('import-text').value);
    showImportResult(r, "Couldn't read that as FEN or PGN");
    if (!('error' in r)) render();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const el = $<HTMLInputElement>(btn.dataset.copy!);
      await navigator.clipboard.writeText(el.value);
      const text = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = text), 1200);
    }),
  );
  // ← → step through the moves anywhere on the page. ↑ ↓ Home End and f only while the focus is in the board,
  // the moves or the controls, so they still scroll the page elsewhere and "f" isn't a page-wide shortcut.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const inside = root.contains(t);
    const map: Record<string, () => void> = inside
      ? { ArrowLeft: nav.prev, ArrowRight: nav.next, ArrowUp: nav.start, ArrowDown: nav.end, Home: nav.start, End: nav.end, f: flip }
      : { ArrowLeft: nav.prev, ArrowRight: nav.next };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });

  // ---------- initial state from the URL ----------
  const q = new URLSearchParams(location.search);
  const fenParam = q.get('fen')?.replace(/_/g, ' ');
  const pgnParam = q.get('pgn');
  const initial = pgnParam ? (fenParam ? `[SetUp "1"]\n[FEN "${normalizeFen(fenParam)}"]\n\n${pgnParam}` : pgnParam) : (fenParam ?? '');
  const r = load(initial);
  showImportResult(r, "Couldn't load the position from the link");
  if ('error' in r) load('');
  if (q.get('flip') === '1' || q.get('orientation') === 'black') {
    orientation = 'b';
    board.setOrientation('b');
    evalbar.classList.add('flipped');
  }
  render();
  mounted = true;
}
