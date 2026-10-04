import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('sitemap-index.xml', site);
  // Database pages (games, players, events) have their own sitemap index.
  const games = new URL('sitemaps/index.xml', site);
  return new Response(`User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${sitemap.href}\nSitemap: ${games.href}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
