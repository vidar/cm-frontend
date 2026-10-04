import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Social preview card: /og.png?fen=<placement>&t=<title>[&k=<kicker>&s=<subtitle>&f=<footer>&lm=e2e4&flip=1]
// Pages link to it from og:image (src/lib/og-url.ts). Texts are length-limited; responses are
// immutable for a URL, so the edge cache (src/middleware.ts) keeps them.
export const prerender = false;

const PLACEMENT = /^([1-8pnbrqkPNBRQK]{1,8}\/){7}[1-8pnbrqkPNBRQK]{1,8}$/;
const clip = (s: string | null, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams;
  const fen = q.get('fen') ?? '';
  const title = clip(q.get('t'), 90);
  if (!PLACEMENT.test(fen) || !title) return new Response('Bad request', { status: 400 });
  const lm = /^[a-h][1-8][a-h][1-8]$/.test(q.get('lm') ?? '') ? [q.get('lm')!.slice(0, 2), q.get('lm')!.slice(2)] : [];

  const { renderCard } = await import('../lib/og');
  const assets = (env as { ASSETS?: { fetch(r: Request | string): Promise<Response> } }).ASSETS;
  const load = async (path: string) => {
    const res = assets ? await assets.fetch(new URL(path, url)) : await fetch(new URL(path, url));
    if (!res.ok) throw new Error(`font ${path}: ${res.status}`);
    return res.arrayBuffer();
  };
  const png = await renderCard(
    {
      fen: `${fen} w - - 0 1`,
      lastMove: lm,
      flip: q.get('flip') === '1',
      kicker: clip(q.get('k'), 40) || undefined,
      title,
      subtitle: clip(q.get('s'), 160) || undefined,
      footer: clip(q.get('f'), 60) || undefined,
    },
    load,
  );
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800, s-maxage=31536000, immutable' },
  });
};
