// Social preview card description and its /og.png URL (kept apart from the renderer in og.ts so
// pages can build URLs without bundling resvg).
export interface OgCard {
  fen: string;
  lastMove?: string[];
  flip?: boolean;
  kicker?: string;
  title: string;
  subtitle?: string;
  footer?: string;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Longest texts a card carries (characters); longer ones are cut, here and in /og.png alike. */
export const OG_LIMITS = { title: 90, kicker: 40, subtitle: 160, footer: 60 } as const;

/** Collapses whitespace and cuts to `n` characters (code points), so cutting again changes nothing. */
export const clipText = (s: string | null | undefined, n: number) => [...(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, n).join('').trim();

const PLACEMENT = /^([1-8pnbrqkPNBRQK]{1,8}\/){7}[1-8pnbrqkPNBRQK]{1,8}$/;

/** Path of the preview card for a page (rendered and cached on demand). */
export function ogUrl(card: OgCard) {
  const p = new URLSearchParams({ fen: card.fen.split(' ')[0], t: clipText(card.title, OG_LIMITS.title) });
  if (card.lastMove?.length === 2) p.set('lm', card.lastMove.join(''));
  if (card.flip) p.set('flip', '1');
  const k = clipText(card.kicker, OG_LIMITS.kicker);
  const s = clipText(card.subtitle, OG_LIMITS.subtitle);
  const f = clipText(card.footer, OG_LIMITS.footer);
  if (k) p.set('k', k);
  if (s) p.set('s', s);
  if (f) p.set('f', f);
  return `/og.png?${p}`;
}

/**
 * Reads an /og.png query: the card (fen = board placement only), or null without a valid board or a
 * title. `canonical` is the URL ogUrl() gives for that card: /og.png renders only that one, so other
 * parameters and spellings (tracking tags, cache busters) can't each cost a render.
 */
export function parseOgQuery(q: URLSearchParams): { card: OgCard; canonical: string } | null {
  const fen = q.get('fen') ?? '';
  const title = clipText(q.get('t'), OG_LIMITS.title);
  if (!PLACEMENT.test(fen) || !title) return null;
  const lm = q.get('lm') ?? '';
  const card: OgCard = {
    fen,
    lastMove: /^[a-h][1-8][a-h][1-8]$/.test(lm) ? [lm.slice(0, 2), lm.slice(2)] : [],
    flip: q.get('flip') === '1',
    kicker: clipText(q.get('k'), OG_LIMITS.kicker) || undefined,
    title,
    subtitle: clipText(q.get('s'), OG_LIMITS.subtitle) || undefined,
    footer: clipText(q.get('f'), OG_LIMITS.footer) || undefined,
  };
  return { card, canonical: ogUrl(card) };
}
