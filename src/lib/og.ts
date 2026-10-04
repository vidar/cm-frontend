// Social preview cards (1200×630 PNG): a board on the left, kicker, title, subtitle and footer
// on the right, in the site's warm palette. Rendered by /og.png with resvg (WebAssembly); fonts are
// static instances of the site fonts in public/og-fonts/ (resvg needs plain TrueType files).
import { initWasm, Resvg } from '@resvg/resvg-wasm';
// @ts-expect-error — the Cloudflare Vite plugin turns .wasm imports into a WebAssembly.Module
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { renderBoardSvg } from './chess/board-svg';

export type { OgCard } from './og-url';
import type { OgCard } from './og-url';


const W = 1200;
const H = 630;
const C = { bg: '#fbfaf7', fg: '#1c1917', muted: '#6f6a64', accent: '#b45309', border: '#e7e1d6' };
const FONT_FILES = ['/og-fonts/fraunces-semibold.ttf', '/og-fonts/inter-regular.ttf', '/og-fonts/inter-semibold.ttf'];

let ready: Promise<Uint8Array[]> | null = null;
/** Load the wasm module and fonts once per isolate. `load` fetches a static asset. */
function init(load: (path: string) => Promise<ArrayBuffer>) {
  ready ??= Promise.all([initWasm(resvgWasm), ...FONT_FILES.map(load)]).then(([, ...fonts]) => fonts.map((f) => new Uint8Array(f as ArrayBuffer)));
  return ready;
}

/** The fonts cover Latin-1 and a little more: fold other accented letters, drop the rest. */
export function fold(s: string) {
  const map: Record<string, string> = { ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ğ: 'g', Ğ: 'G', ş: 's', Ş: 'S', ț: 't', ș: 's' };
  return [...s]
    .map((ch) => {
      if (ch.charCodeAt(0) < 0x180 && !/[Ā-ſ]/.test(ch)) return ch;
      if ('½–—·…’‘“”€'.includes(ch)) return ch;
      if (map[ch]) return map[ch];
      return ch.normalize('NFKD').replace(/[^\u0000-ÿ]/g, '');
    })
    .join('');
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

// Rough advance widths (em) for wrapping; good enough for two fonts at display sizes.
function textWidth(s: string, size: number) {
  let w = 0;
  for (const ch of s) {
    if (' ilj.,:;!|\'’()'.includes(ch)) w += 0.28;
    else if ('ftr-'.includes(ch)) w += 0.38;
    else if ('mwMW'.includes(ch)) w += 0.86;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else if (/[0-9½]/.test(ch)) w += 0.6;
    else w += 0.53;
  }
  return w * size;
}

function wrap(text: string, size: number, width: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && textWidth(`${last}…`, size) > width) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

export function cardSvg(card: OgCard) {
  const board = renderBoardSvg({ fen: card.fen, flip: card.flip, coords: false, highlight: card.lastMove ?? [], size: 540 })
    .replace(/<svg /, '<svg x="48" y="45" ')
    .replace(/ width="\d+" height="\d+"/, ' width="540" height="540"');
  const x = 642;
  const width = W - x - 56;
  const title = fold(card.title);
  const titleSize = textWidth(title, 56) <= width * 2 ? 56 : 46;
  const titleLines = wrap(title, titleSize, width, 3);
  const subLines = card.subtitle ? wrap(fold(card.subtitle), 27, width, 3) : [];
  let y = 196;
  const parts: string[] = [];
  if (card.kicker) parts.push(`<text x="${x}" y="${y - 52}" font-family="Inter" font-weight="600" font-size="22" letter-spacing="2" fill="${C.accent}">${esc(fold(card.kicker).toUpperCase())}</text>`);
  for (const l of titleLines) {
    parts.push(`<text x="${x}" y="${y}" font-family="Fraunces" font-weight="600" font-size="${titleSize}" fill="${C.fg}">${esc(l)}</text>`);
    y += titleSize * 1.12;
  }
  y += 18;
  for (const l of subLines) {
    parts.push(`<text x="${x}" y="${y}" font-family="Inter" font-size="27" fill="${C.muted}">${esc(l)}</text>`);
    y += 38;
  }
  // Footer shares the bottom line with the wordmark (right-aligned, ~210px).
  if (card.footer) parts.push(`<text x="${x}" y="${H - 66}" font-family="Inter" font-weight="600" font-size="26" fill="${C.fg}">${esc(wrap(fold(card.footer), 26, width - 230, 1)[0] ?? '')}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="0" y="${H - 10}" width="${W}" height="10" fill="${C.accent}"/>
<defs><clipPath id="b"><rect x="48" y="45" width="540" height="540" rx="12"/></clipPath></defs>
<rect x="44" y="41" width="548" height="548" rx="15" fill="${C.border}"/>
<g clip-path="url(#b)">${board}</g>
<text x="${W - 56}" y="${H - 66}" text-anchor="end" font-family="Fraunces" font-weight="600" font-size="28" fill="${C.fg}"><tspan fill="${C.accent}">c</tspan>hessmoments</text>
${parts.join('\n')}
</svg>`;
}

export async function renderCard(card: OgCard, load: (path: string) => Promise<ArrayBuffer>) {
  const fonts = await init(load);
  const resvg = new Resvg(cardSvg(card), {
    fitTo: { mode: 'width', value: W },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter', serifFamily: 'Fraunces' },
  });
  const png = resvg.render().asPng();
  resvg.free();
  return png;
}
