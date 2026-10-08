// AI notes on game pages, once the engine analysis is shown: a button to have Claude write them
// (POST /games/annotation/<id>.json, src/pages/games/annotation/[id].json.ts), then the summary in the
// analysis panel, notes under their moves in the move list, and the current move's note under the eval.

interface Note {
  ply: number;
  text: string;
}
interface State {
  status: 'none' | 'running' | 'done' | 'failed' | 'unavailable';
  model?: string;
  summary?: string;
  notes?: Note[];
  error?: string;
}

const MODEL_NAMES: Record<string, string> = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' };
const moveNo = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'}`;

export function mountGameAnnotation(panel: HTMLElement, viewer: HTMLElement) {
  const box = panel.querySelector<HTMLElement>('[data-ai]');
  if (!box || box.dataset.mounted) return;
  box.dataset.mounted = '1';
  const id = panel.dataset.analysis!;
  const sans = (viewer.dataset.moves ?? '').split(' ').filter(Boolean);
  const part = (name: string) => box.querySelector<HTMLElement>(`[data-ai-part=${name}]`)!;
  const parts = ['none', 'running', 'done', 'error'];
  const show = (name: string | null) => {
    box.hidden = name === null;
    for (const p of parts) part(p).hidden = p !== name;
  };
  const nowNote = panel.querySelector<HTMLElement>('[data-now-note]')!;
  let byPly = new Map<number, string>();
  let timer = 0;

  async function load(method: 'GET' | 'POST' = 'GET') {
    clearTimeout(timer);
    if (method === 'POST') show('running');
    let state: State;
    try {
      const res = await fetch(`/games/annotation/${id}.json`, { method, headers: { Accept: 'application/json' } });
      state = await res.json();
      if (!res.ok && state.error) return fail(state.error);
    } catch {
      return fail('Could not reach the AI service. Please try again.');
    }
    if (state.status === 'unavailable') return show(null);
    if (state.status === 'none') return show('none');
    if (state.status === 'failed') return fail(`Writing the notes failed (${state.error}).`);
    if (state.status === 'running') {
      show('running');
      timer = window.setTimeout(() => load(), 4000);
      return;
    }
    render(state);
  }

  function fail(message: string) {
    box.querySelector('[data-ai-message]')!.textContent = message;
    show('error');
  }

  function render(state: State) {
    const summary = box.querySelector<HTMLElement>('[data-ai-summary]')!;
    summary.replaceChildren(
      ...(state.summary ?? '')
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p) => Object.assign(document.createElement('p'), { textContent: p.trim() })),
    );
    box.querySelector('[data-ai-model]')!.textContent = MODEL_NAMES[state.model ?? ''] ?? 'Claude';
    byPly = new Map((state.notes ?? []).map((n) => [n.ply, n.text]));

    // Notes under their moves in the move list (after the move's row), clickable.
    for (const el of viewer.querySelectorAll('.note')) el.remove();
    for (const [ply, text] of byPly) {
      const row = viewer.querySelector(`[data-ply="${ply}"]`)?.closest('.row');
      if (!row) continue;
      const note = document.createElement('div');
      note.className = 'note';
      note.dataset.notePly = String(ply);
      const b = document.createElement('b');
      b.textContent = `${moveNo(ply)}${sans[ply - 1] ?? ''} `;
      note.append(b, text);
      note.addEventListener('click', () => viewer.dispatchEvent(new CustomEvent('cm:goto', { detail: { ply } })));
      // Several notes on one row (White's and Black's move) stay in move order.
      let after: Element = row;
      while (after.nextElementSibling?.classList.contains('note')) after = after.nextElementSibling;
      after.after(note);
    }
    show('done');
    showNow(Number(viewer.querySelector<HTMLElement>('[data-ply].current')?.dataset.ply ?? sans.length));
  }

  function showNow(ply: number) {
    const text = byPly.get(ply);
    nowNote.hidden = !text;
    nowNote.textContent = text ?? '';
    for (const el of viewer.querySelectorAll<HTMLElement>('.note')) el.classList.toggle('current', Number(el.dataset.notePly) === ply);
  }

  box.querySelector('[data-ai-write]')?.addEventListener('click', () => load('POST'));
  box.querySelector('[data-ai-retry]')?.addEventListener('click', () => load('POST'));
  viewer.addEventListener('cm:ply', (e) => showNow((e as CustomEvent<{ ply: number }>).detail.ply));
  load();
}
