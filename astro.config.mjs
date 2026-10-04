// @ts-check
import { defineConfig, fontProviders } from 'astro/config';

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

  // Build ID: part of the edge-cache key (src/middleware.ts), so each deploy starts with a fresh cache.
  vite: { define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) } },

  // Self-hosted at build time (downloaded from Fontsource, served from /_astro/fonts/).
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Fraunces',
      cssVariable: '--font-display',
      weights: ['400 700'],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['Georgia', 'serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Inter',
      cssVariable: '--font-text',
      weights: ['400 700'],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],

  // Includes every prerendered page automatically. On-demand (SSR) routes
  // must be added via `customPages` — see CLAUDE.md.
  integrations: [
    sitemap({
      customPages: [
        'https://chessmoments.com/puzzle/',
        'https://chessmoments.com/puzzle/archive/',
        // Games database hubs (individual games/players/events are in /sitemaps/index.xml).
        'https://chessmoments.com/games/',
        'https://chessmoments.com/players/',
        'https://chessmoments.com/events/',
        ...puzzleDates.map((d) => `https://chessmoments.com/puzzle/${d}/`),
      ],
    }),
  ],
});
