import { Chess } from 'chess.js';
import { classify, fmtEval as fmt, LABEL, type Ev } from '../lib/chess/classify';
import { mountGameAnnotation } from './game-annotation';

// Engine analysis panel on game pages: shows a stored Stockfish analysis (eval graph, mistakes,
// best moves) or a button to queue one, then polls until the engine is done. Talks to
// /games/analysis/<id>.json (src/pages/games/analysis/[id].json.ts) and to the game viewer
// (cm:ply / cm:goto events, src/scripts/game-viewer.ts).

interface State {
  status: 'none' | 'queued' | 'running' | 'done' | 'failed' | 'unavailable';
  done?: number;
  total?: number;
  depth?: number;
  evals?: { e: Ev[]; b: (string | null)[] };
  error?: string;
}

export function mountGameAnalysis(panel: HTMLElement, viewer: HTMLElement) {
  const id = panel.dataset.analysis!;
  const result = panel.dataset.result ?? '*';
  const sans = (viewer.dataset.moves ?? '').split(' ').filter(Boolean);
  const chess = new Chess();
  const fens = [chess.fen()];
  const ucis: string[] = [];
  for (const san of sans) {
    const m = chess.move(san);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
    fens.push(chess.fen());
  }
  const parts = {
    none: panel.querySelector<HTMLElement>('[data-part=none]')!,
    pending: panel.querySelector<HTMLElement>('[data-part=pending]')!,
    done: panel.querySelector<HTMLElement>('[data-part=done]')!,
    error: panel.querySelector<HTMLElement>('[data-part=error]')!,
  };
  const showPart = (name: keyof typeof parts | null) => {
    panel.hidden = name === null;
    for (const [k, el] of Object.entries(parts)) el.hidden = k !== name;
  };
  let timer = 0;
  let current = sans.length;

  async function load(method: 'GET' | 'POST' = 'GET') {
    clearTimeout(timer);
    let state: State;
    try {
      const res = await fetch(`/games/analysis/${id}.json`, { method, headers: { Accept: 'application/json' } });
      state = await res.json();
      if (!res.ok && 'error' in state) return fail(String(state.error));
    } catch {
      return fail('Could not reach the engine. Please try again.');
    }
    if (state.status === 'unavailable') return showPart(null);
    if (state.status === 'none') return showPart('none');
    if (state.status === 'failed') return fail(`The analysis failed (${state.error}).`, true);
    if (state.status === 'done' && state.evals) return render(state.evals, state.depth ?? 0);
    const bar = parts.pending.querySelector<HTMLElement>('.bar span')!;
    const text = parts.pending.querySelector<HTMLElement>('[data-progress]')!;
    const pct = state.total ? Math.round(((state.done ?? 0) / state.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    text.textContent = state.status === 'running' && state.total ? `Analysing… ${state.done} of ${state.total} positions` : 'Queued, waiting for the engine…';
    showPart('pending');
    timer = window.setTimeout(() => load(), 2500);
  }

  function fail(message: string, retry = false) {
    parts.error.querySelector('[data-message]')!.textContent = message;
    parts.error.querySelector<HTMLElement>('[data-retry]')!.hidden = !retry;
    showPart('error');
  }

  panel.querySelector('[data-queue]')?.addEventListener('click', () => load('POST'));
  panel.querySelector('[data-retry]')?.addEventListener('click', () => load('POST'));

  function render(evals: { e: Ev[]; b: (string | null)[] }, depth: number) {
    // Classify each move by the drop in winning chances for the side that moved (Lichess thresholds).
    const { kinds, stats, wc } = classify(evals.e, evals.b, ucis, result);

    // Annotate the move list.
    for (const el of viewer.querySelectorAll<HTMLElement>('[data-ply]')) {
      const k = kinds[Number(el.dataset.ply)];
      el.querySelector('.ann')?.remove();
      if (!k) continue;
      el.classList.add(`ann-${k}`);
      const a = document.createElement('span');
      a.className = 'ann';
      a.textContent = LABEL[k];
      a.title = k;
      el.append(a);
    }

    // Graph: White's winning chances; light area = White better, dark = Black better.
    const W = 600, H = 120, n = Math.max(1, wc.length - 1);
    const x = (i: number) => (i / n) * W;
    const y = (v: number) => H / 2 - (v * H) / 2;
    const line = wc.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const svg = parts.done.querySelector<SVGSVGElement>('svg')!;
    svg.innerHTML =
      `<rect width="${W}" height="${H}" class="g-black"/>` +
      `<path class="g-white" d="${line}L${W},${H}L0,${H}Z"/>` +
      `<line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>` +
      `<path class="g-line" d="${line}"/>` +
      // Dots as zero-length round-capped strokes in screen pixels, so they stay round although the graph stretches.
      kinds
        .map((k, i) => {
          if (!k) return '';
          const pt = `x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(wc[i]).toFixed(1)}" y2="${y(wc[i]).toFixed(1)}"`;
          return `<g class="g-dot g-${k}"><title>${Math.ceil(i / 2)}${i % 2 ? '.' : '…'} ${sans[i - 1]} ${LABEL[k]}</title><line class="g-ring" ${pt}/><line class="g-fill" ${pt}/></g>`;
        })
        .join('') +
      `<line class="g-cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
    const cursor = svg.querySelector<SVGLineElement>('.g-cursor')!;
    const plyAt = (ev: MouseEvent) => {
      const r = svg.getBoundingClientRect();
      return Math.max(0, Math.min(sans.length, Math.round(((ev.clientX - r.left) / r.width) * n)));
    };
    svg.onclick = (ev) => viewer.dispatchEvent(new CustomEvent('cm:goto', { detail: { ply: plyAt(ev) } }));

    // Summary per side.
    const tbody = parts.done.querySelector('tbody')!;
    tbody.innerHTML = (['w', 'b'] as const)
      .map((c) => {
        const s = stats[c];
        return `<tr><th scope="row">${c === 'w' ? 'White' : 'Black'}</th><td class="num">${s.n ? Math.round(s.loss / s.n) : 0}</td><td class="num g-t-inaccuracy">${s.inaccuracy}</td><td class="num g-t-mistake">${s.mistake}</td><td class="num g-t-blunder">${s.blunder}</td></tr>`;
      })
      .join('');
    parts.done.querySelector('[data-depth]')!.textContent = String(depth);

    // Current position: eval and the engine's preferred move.
    const now = parts.done.querySelector<HTMLElement>('[data-now]')!;
    const update = (ply: number) => {
      current = ply;
      cursor.setAttribute('x1', String(x(ply)));
      cursor.setAttribute('x2', String(x(ply)));
      const k = kinds[ply];
      let text = `Eval ${fmt(evals.e[ply])}`;
      const best = evals.b[ply - 1];
      if (ply > 0 && k && best) {
        try {
          const c = new Chess(fens[ply - 1]);
          const m = c.move({ from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4] });
          text += ` · ${sans[ply - 1]} was ${k === 'inaccuracy' ? 'an inaccuracy' : `a ${k}`}; best was ${m.san} (${fmt(evals.e[ply - 1])})`;
        } catch {
          /* ignore malformed engine moves */
        }
      }
      now.textContent = text;
    };
    viewer.addEventListener('cm:ply', (e) => update((e as CustomEvent<{ ply: number }>).detail.ply));
    update(current);
    showPart('done');
    mountGameAnnotation(panel, viewer);
  }

  viewer.addEventListener('cm:ply', (e) => (current = (e as CustomEvent<{ ply: number }>).detail.ply));
  load();
}
