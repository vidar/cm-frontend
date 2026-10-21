// Worker entry (wrangler.jsonc "main"): the Astro app, behind a maintenance switch for the games
// database. With the var MAINTENANCE = "1" the database routes (games, players, events, sitemaps,
// uploads) answer 503 with the page below and nothing reaches the database; the rest of the site
// (puzzles, openings, tools, the homepage, robots.txt) keeps working, which is what search engines
// want to see during an outage (a 503 on robots.txt stops crawling; a 503 on a URL for more than
// two days drops it). Set it to "0" to reopen the database.
import { handle } from '@astrojs/cloudflare/handler';
import { isDbRoute, maintenance } from './lib/maintenance';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>chessmoments · games database back soon</title>
<style>
  :root { --bg: #faf8f4; --fg: #1f1a14; --muted: #6f6556; --accent: #b45309; --surface: #fff; --border: #e7e0d4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #181512; --fg: #ece6dc; --muted: #a59a8a; --accent: #f59e0b; --surface: #211d19; --border: #3a332b; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; background: var(--bg); color: var(--fg);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; text-align: center; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem 1.75rem; }
  .logo { font: 700 1.5rem Georgia, "Times New Roman", serif; margin: 0 0 1.25rem; }
  .logo span, a { color: var(--accent); }
  .board { width: 4rem; height: 4rem; margin: 0 auto 1.25rem; border-radius: 6px; overflow: hidden;
    background: conic-gradient(#b58863 0 25%, #f0d9b5 0 50%, #b58863 0 75%, #f0d9b5 0) 0 0 / 50% 50%; }
  h1 { font: 600 1.6rem Georgia, "Times New Roman", serif; margin: 0 0 0.5rem; }
  p { margin: 0.4rem 0; color: var(--muted); }
</style>
</head>
<body>
<main>
  <p class="logo"><a href="/"><span>c</span>hessmoments</a></p>
  <div class="board" aria-hidden="true"></div>
  <h1>Games database back soon</h1>
  <p>The games, players and events pages are offline for maintenance.</p>
  <p>The <a href="/puzzle/">daily puzzle</a>, the <a href="/openings/">openings</a> and the <a href="/analysis/">analysis board</a> are working.</p>
</main>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    if (maintenance(env) && isDbRoute(request.url)) {
      return new Response(request.method === 'HEAD' ? null : PAGE, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3600' },
      });
    }
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
