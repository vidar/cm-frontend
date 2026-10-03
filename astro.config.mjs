// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

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
  integrations: [sitemap()],
});
