// Thin UCI wrapper around Stockfish running in a Web Worker (public/engine/, GPL-3).

export interface EngineLine {
  multipv: number;
  depth: number;
  /** Score from White's point of view. */
  cp: number | null;
  mate: number | null;
  /** Principal variation in UCI. */
  pv: string[];
}

export class Engine {
  private worker: Worker;
  private ready: Promise<void>;
  private searching = false;
  private stopping = false;
  private pending: { fen: string; depth: number } | null = null;
  private current: { fen: string; whiteToMove: boolean } | null = null;
  private lines = new Map<number, EngineLine>();
  onUpdate: (lines: EngineLine[]) => void = () => {};

  constructor(url = '/engine/stockfish.js', private multiPv = 3) {
    this.worker = new Worker(url);
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    this.worker.onmessage = (e: MessageEvent<string>) => {
      const line = String(e.data);
      if (line === 'readyok') resolveReady();
      else if (line.startsWith('bestmove')) this.onBestMove();
      else if (line.startsWith('info ') && line.includes(' pv ')) this.onInfo(line);
    };
    this.send('uci');
    this.send(`setoption name MultiPV value ${multiPv}`);
    this.send('isready');
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  /** Analyses a position, replacing any running search. */
  async analyse(fen: string, depth = 22) {
    await this.ready;
    this.pending = { fen, depth };
    if (this.searching) {
      // Wait for the old search's "bestmove" so its output can't be mistaken for the new one's.
      if (!this.stopping) {
        this.stopping = true;
        this.send('stop');
      }
      return;
    }
    this.start();
  }

  stop() {
    this.pending = null;
    if (this.searching && !this.stopping) {
      this.stopping = true;
      this.send('stop');
    }
  }

  destroy() {
    this.worker.terminate();
  }

  private start() {
    const job = this.pending;
    this.pending = null;
    if (!job) return;
    this.current = { fen: job.fen, whiteToMove: job.fen.split(' ')[1] !== 'b' };
    this.lines.clear();
    this.searching = true;
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${job.depth}`);
  }

  private onBestMove() {
    this.searching = false;
    this.stopping = false;
    if (this.pending) this.start();
  }

  private onInfo(line: string) {
    if (this.stopping || !this.current) return;
    const t = line.split(' ');
    const num = (key: string) => {
      const i = t.indexOf(key);
      return i >= 0 ? Number(t[i + 1]) : undefined;
    };
    const si = t.indexOf('score');
    if (si < 0 || t.includes('lowerbound') || t.includes('upperbound')) return;
    const sign = this.current.whiteToMove ? 1 : -1; // UCI scores are from the side to move
    const kind = t[si + 1];
    const value = Number(t[si + 2]) * sign;
    const entry: EngineLine = {
      multipv: num('multipv') ?? 1,
      depth: num('depth') ?? 0,
      cp: kind === 'cp' ? value : null,
      mate: kind === 'mate' ? value : null,
      pv: t.slice(t.indexOf('pv') + 1),
    };
    this.lines.set(entry.multipv, entry);
    this.onUpdate([...this.lines.values()].sort((a, b) => a.multipv - b.multipv).slice(0, this.multiPv));
  }
}

/** Win-chance style bar position (0–100, White's share), as used by Lichess. */
export function evalBarPercent(l: Pick<EngineLine, 'cp' | 'mate'>): number {
  if (l.mate !== null) return l.mate > 0 ? 100 : l.mate < 0 ? 0 : 50;
  const cp = Math.max(-1000, Math.min(1000, l.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
