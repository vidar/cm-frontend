import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameTree, START_FEN, importPgn, positionError } from '../src/scripts/tree';
import { Engine } from '../src/scripts/engine';
import { replaySans } from '../src/scripts/game-viewer';

describe('positionError', () => {
  it('accepts legal positions', () => {
    expect(positionError(START_FEN)).toBeNull();
    expect(positionError('4k3/8/8/8/8/8/4R3/4K3 b - - 0 1')).toBeNull(); // Black in check, Black to move
  });
  it('refuses a position whose side not to move is in check', () => {
    expect(positionError('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1')).toMatch(/Black is in check with White to move/);
  });
  it("gives chess.js's reason without the jargon prefix", () => {
    expect(positionError('8/8/8/8/8/8/8/4K3 w - - 0 1')).toBe('missing black king');
  });
});

describe('importPgn', () => {
  it('keeps variations, nested ones too', () => {
    const { tree, notes } = importPgn('1. e4 (1. d4 d5 (1... Nf6 2. c4) 2. c4) e5 2. Nf3 *');
    expect(notes).toEqual([]);
    expect(tree.root.children.map((n) => n.san)).toEqual(['e4', 'd4']);
    const d4 = tree.root.children[1];
    expect(d4.children.map((n) => n.san)).toEqual(['d5', 'Nf6']);
    expect(d4.children[0].children[0].san).toBe('c4');
    expect(d4.children[1].children[0].san).toBe('c4');
    expect(tree.path(tree.end(tree.root)).map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3']);
  });

  it("round-trips the board's own PGN export", () => {
    const { tree } = importPgn('1. e4 (1. d4 d5 2. c4) 1... e5 (1... c5 2. Nf3 d6) 2. Nf3 Nc6 *');
    const pgn = tree.toPgn();
    expect(importPgn(pgn).tree.toPgn()).toBe(pgn);
    expect(pgn).toContain('1. e4 (1. d4 d5 2. c4) 1... e5 (1... c5 2. Nf3 d6) 2. Nf3 Nc6 *');
  });

  it('says that comments and marks were left out', () => {
    const { tree, notes } = importPgn('1. e4! {best by test} e5?! $6 ; a line comment\n2. Nf3 *');
    expect(tree.path(tree.end(tree.root)).map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(notes.join(' ')).toMatch(/Comments and move marks/);
  });

  it('reads move numbers glued to moves, castling with zeros and results', () => {
    const { tree } = importPgn('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.0-0 Nf6 5.d3 1-0');
    expect(tree.path(tree.end(tree.root)).map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3']);
  });

  it('loads the first of several games and says so', () => {
    const { tree, notes } = importPgn('[Event "A"]\n\n1. e4 e5 1-0\n\n[Event "B"]\n\n1. d4 d5 0-1\n');
    expect(tree.path(tree.end(tree.root)).map((n) => n.san)).toEqual(['e4', 'e5']);
    expect(notes[0]).toMatch(/2 games; only the first/);
  });

  it('starts from the FEN tag and refuses an impossible one', () => {
    const fen = '4k3/8/8/8/8/8/4R3/4K3 b - - 0 1';
    const { tree } = importPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n1... Kf7 *`);
    expect(tree.startFen).toBe(fen);
    expect(tree.root.children[0].san).toBe('Kf7');
    expect(() => importPgn('[FEN "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1"]\n\n*')).toThrow(/FEN tag/);
  });

  it('gives plain messages for illegal moves and broken variations', () => {
    expect(() => importPgn('1. e4 e5 2. Ke3')).toThrow('"Ke3" is not a legal move after 1... e5');
    expect(() => importPgn('hello')).toThrow('"hello" is not a legal move in the starting position');
    expect(() => importPgn('(1. d4) 1. e4')).toThrow(/variation starts before any move/);
    expect(() => importPgn('1. e4 ) e5')).toThrow(/never opened/);
  });
});

describe('replaySans', () => {
  it('gives every position and the UCI moves with promotions', () => {
    const r = replaySans(['e4', 'e5']);
    expect(r.fens).toEqual([START_FEN, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2']);
    expect(r.ucis).toEqual(['e2e4', 'e7e5']);
    const promo = replaySans(['h4', 'g5', 'hxg5', 'h6', 'gxh6', 'Nf6', 'h7', 'Ng8', 'hxg8=Q']);
    expect(promo.ucis.at(-1)).toBe('h7g8q');
  });
});

// A stand-in for the Stockfish worker: answers "isready" only when told to, and records the commands.
class FakeWorker {
  static last: FakeWorker;
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(cmd: string) {
    this.sent.push(cmd);
  }
  emit(line: string) {
    this.onmessage?.({ data: line });
  }
  terminate() {}
}

describe('Engine', () => {
  const saved = (globalThis as { Worker?: unknown }).Worker;
  beforeEach(() => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  });
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = saved;
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const searches = (w: FakeWorker) => w.sent.filter((c) => c.startsWith('position'));

  it('a stop() while the engine loads wins over the earlier analyse()', async () => {
    const e = new Engine();
    const w = FakeWorker.last;
    void e.analyse(START_FEN);
    e.stop();
    w.emit('readyok');
    await tick();
    expect(searches(w)).toEqual([]);
  });

  it('only the newest position is searched once the engine has loaded', async () => {
    const e = new Engine();
    const w = FakeWorker.last;
    void e.analyse(START_FEN);
    void e.analyse('4k3/8/8/8/8/8/4R3/4K3 b - - 0 1');
    w.emit('readyok');
    await tick();
    expect(searches(w)).toEqual(['position fen 4k3/8/8/8/8/8/4R3/4K3 b - - 0 1']);
  });

  it('waits for the running search to stop before starting the next', async () => {
    const e = new Engine();
    const w = FakeWorker.last;
    w.emit('readyok');
    await e.analyse(START_FEN);
    await e.analyse('4k3/8/8/8/8/8/4R3/4K3 b - - 0 1');
    expect(w.sent.at(-1)).toBe('stop');
    expect(searches(w)).toHaveLength(1);
    w.emit('bestmove e2e4');
    expect(searches(w)).toHaveLength(2);
  });

  it('reports a worker error', () => {
    const e = new Engine();
    let failed = false;
    e.onError = () => (failed = true);
    FakeWorker.last.onerror?.({ preventDefault() {} } as Event);
    expect(failed).toBe(true);
  });
});
