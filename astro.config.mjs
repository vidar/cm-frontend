// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

// On-demand (SSR) routes aren't seen by @astrojs/sitemap, so list them here.
// Daily puzzle pages from launch up to the build date; later ones are reachable via /puzzle/archive/.
const PUZZLE_START = Date.parse('2026-10-03T00:00:00Z');
const puzzleDates = [];
for (let t = PUZZLE_START; t <= Date.now(); t += 86_400_000) puzzleDates.push(new Date(t).toISOString().slice(0, 10));

// https://astro.build/config
export default defineConfig({
  // Canonical URL; used for sitemap and robots.txt URLs.
  site: 'https://chessmoments.com',
  adapter: cloudflare(),

  // Sessions are unused; disabling them stops the adapter from adding a
  // SESSION KV binding, which `wrangler preview` can't auto-provision.
  session: false,

  // Includes every prerendered page automatically. On-demand (SSR) routes
  // must be added via `customPages` — see CLAUDE.md.
  integrations: [
    sitemap({
      customPages: [
        'https://chessmoments.com/puzzle/',
        'https://chessmoments.com/puzzle/archive/',
        ...puzzleDates.map((d) => `https://chessmoments.com/puzzle/${d}/`),
      ],
    }),
  ],
});
