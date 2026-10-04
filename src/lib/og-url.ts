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

/** Path of the preview card for a page (rendered and cached on demand). */
export function ogUrl(card: OgCard) {
  const p = new URLSearchParams({ fen: card.fen.split(' ')[0], t: card.title });
  if (card.lastMove?.length === 2) p.set('lm', card.lastMove.join(''));
  if (card.flip) p.set('flip', '1');
  if (card.kicker) p.set('k', card.kicker);
  if (card.subtitle) p.set('s', card.subtitle);
  if (card.footer) p.set('f', card.footer);
  return `/og.png?${p}`;
}
