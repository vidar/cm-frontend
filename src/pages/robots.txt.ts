import type { APIRoute } from 'astro';

// AI policy: search and assistant agents (which fetch pages to answer people and cite them) may
// read everything. AI training crawlers may read the tools, openings and puzzles, but not the TWIC
// games database: The Week in Chess games are shown here with Mark Crowther's permission, which
// doesn't extend to AI training. Cloudflare's "Block AI bots" is off so this file decides.
const TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'Bytespider', 'Amazonbot', 'cohere-training-data-crawler'];
const TWIC_PATHS = ['/games/', '/players/', '/events/', '/sitemaps/'];

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('sitemap-index.xml', site);
  // Database pages (games, players, events) have their own sitemap index.
  const games = new URL('sitemaps/index.xml', site);
  const training = TRAINING_BOTS.map((b) => `User-agent: ${b}`).join('\n');
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    '',
    '# AI training crawlers: not the TWIC games database (used with permission for display only).',
    training,
    'Disallow: /admin/',
    ...TWIC_PATHS.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${sitemap.href}`,
    `Sitemap: ${games.href}`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
