import { Chess, type Square } from 'chess.js';
import { Board } from './board';

const STORAGE_KEY = 'cm-puzzle-results';

interface Result {
  solved: boolean; // solved without revealing the solution
  marks: string; // one emoji per attempt, e.g. "❌✅✅"
}

function loadResults(): Record<string, Result> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveResult(date: string, r: Result) {
  try {
    const all = loadResults();
    all[date] = r;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: results just aren't remembered */
  }
}

/** Consecutive solved days ending at `date` (or the day before, if `date` isn't solved yet). */
function streak(date: string, results = loadResults()): number {
  const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  let d = results[date]?.solved ? date : day(date, -1);
  let n = 0;
  while (results[d]?.solved) {
    n++;
    d = day(d, -1);
  }
  return n;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mountPuzzle(root: HTMLElement) {
  const { number, date, rating, rawFen, moves, orientation } = root.dataset as Record<string, string>;
  const uci = moves.split(' ');
  const status = root.querySelector<HTMLElement>('#puzzle-status')!;
  const controls = root.querySelector<HTMLElement>('#puzzle-controls')!;
  const streakEl = root.querySelector<HTMLElement>('#puzzle-streak')!;
  const shareBtn = root.querySelector<HTMLButtonElement>('#share')!;
  const side = orientation === 'w' ? 'White' : 'Black';

  const chess = new Chess(rawFen);
  let step = 1; // index into uci of the next solver move
  let selected: Square | null = null;
  let marks = '';
  let finished = false;
  let busy = true;

  const board = new Board(root.querySelector<HTMLElement>('#puzzle-board')!, {
    orientation: orientation as 'w' | 'b',
    onSquareClick: (sq) => void onClick(sq as Square),
  });
  board.setPosition(chess.fen());
  controls.hidden = false;

  const setStatus = (html: string) => (status.innerHTML = html);
  const showStreak = () => {
    const n = streak(date);
    streakEl.textContent = n > 0 ? `🔥 ${n}-day streak` : '';
  };

  function play(move: string) {
    const m = chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    board.setPosition(chess.fen());
    board.mark('last', [m.from, m.to]);
    return m;
  }

  function select(sq: Square | null) {
    selected = sq;
    board.mark('selected', sq ? [sq] : []);
    board.mark('target', sq ? chess.moves({ square: sq, verbose: true }).map((m) => m.to) : []);
  }

  function finish(solved: boolean) {
    finished = true;
    select(null);
    const prev = loadResults()[date];
    // Keep the first result for the day; replaying doesn't overwrite it.
    if (!prev) saveResult(date, { solved, marks });
    const result = prev ?? { solved, marks };
    setStatus(
      result.solved
        ? `<strong>Solved!</strong> ${result.marks}`
        : `<strong>Solution shown.</strong> Come back tomorrow for a new puzzle.`,
    );
    root.querySelector<HTMLButtonElement>('#hint')!.hidden = true;
    root.querySelector<HTMLButtonElement>('#reveal')!.hidden = true;
    shareBtn.hidden = false;
    showStreak();
  }

  async function opponentReply() {
    busy = true;
    await wait(450);
    play(uci[step]);
    step++;
    busy = false;
  }

  async function attempt(from: Square, to: Square) {
    const expected = uci[step];
    const legal = chess.moves({ square: from, verbose: true }).find((m) => m.to === to);
    if (!legal) return;
    const promotion = legal.promotion ? (expected.slice(0, 4) === from + to ? expected[4] : 'q') : undefined;
    const isExpected = from + to === expected.slice(0, 4) && (!promotion || promotion === expected[4]);
    // Like Lichess, any move that delivers mate is also accepted.
    const probe = new Chess(chess.fen());
    probe.move({ from, to, promotion });
    if (!isExpected && !probe.isCheckmate()) {
      marks += '❌';
      board.mark('wrong', [to]);
      setStatus(`<strong>Not the move.</strong> Try again — ${side} to move.`);
      setTimeout(() => board.mark('wrong'), 600);
      select(null);
      return;
    }
    marks += '✅';
    select(null);
    play(isExpected ? expected : from + to + (promotion ?? ''));
    step++;
    if (step >= uci.length || probe.isCheckmate()) return finish(true);
    setStatus('<strong>Correct!</strong> Keep going…');
    await opponentReply();
    setStatus(`<strong>${side} to move.</strong> Find the next move.`);
  }

  async function onClick(sq: Square) {
    if (busy || finished) return;
    const piece = chess.get(sq);
    if (selected && sq !== selected && !(piece && piece.color === chess.turn())) {
      await attempt(selected, sq);
    } else if (piece && piece.color === chess.turn()) {
      select(sq === selected ? null : sq);
    } else {
      select(null);
    }
  }

  root.querySelector('#hint')!.addEventListener('click', () => {
    if (busy || finished) return;
    marks += '💡';
    select(uci[step].slice(0, 2) as Square);
    setStatus(`<strong>Hint:</strong> move the highlighted piece.`);
  });

  root.querySelector('#reveal')!.addEventListener('click', async () => {
    if (busy || finished) return;
    busy = true;
    select(null);
    while (step < uci.length) {
      play(uci[step]);
      step++;
      await wait(600);
    }
    busy = false;
    finish(false);
  });

  shareBtn.addEventListener('click', async () => {
    const r = loadResults()[date] ?? { solved: false, marks };
    const n = streak(date);
    const url = `${location.origin}/puzzle/${date}/`;
    const text = [
      `chessmoments daily puzzle #${number} (${rating})`,
      r.solved ? `${r.marks} solved` : `${r.marks || '—'} not solved`,
      n > 1 ? `🔥 ${n}-day streak` : '',
      url,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        shareBtn.textContent = 'Copied!';
        setTimeout(() => (shareBtn.textContent = 'Share result'), 1500);
      }
    } catch {
      /* share cancelled */
    }
  });

  showStreak();
  const done = loadResults()[date];
  // Play the opponent's setup move so the solver sees what just happened.
  void (async () => {
    await wait(600);
    play(uci[0]);
    busy = false;
    if (done) {
      setStatus(
        done.solved
          ? `<strong>Already solved</strong> ${done.marks} — replay it, or share your result.`
          : `<strong>${side} to move.</strong> You've seen the solution already; give it another go.`,
      );
      shareBtn.hidden = false;
    }
  })();
}
