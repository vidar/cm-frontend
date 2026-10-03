// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  // Sessions are unused; disabling them stops the adapter from adding a
  // SESSION KV binding, which `wrangler preview` can't auto-provision.
  session: false,
});
