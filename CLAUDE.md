# cm-frontend

Astro site for https://chessmoments.com, deployed to Cloudflare Workers via Workers Builds
(push to `main` = production; other branches get previews at
`<branch>-cm-frontend.vidar-masson.workers.dev`). See README.md for structure and commands.

## Conventions

- **Content** lives in `src/content/` (homepage `home.md`, pages in `pages/*.md`) and is also
  edited through Sveltia CMS, which commits straight to `main`. Pull `main` before editing
  content so CMS edits aren't overwritten. Keep `src/content.config.ts` and
  `public/admin/config.yml` in sync when changing fields.
- **Sitemap and robots.txt must stay current.** `@astrojs/sitemap` picks up every prerendered
  page automatically (including new CMS pages). When adding features, also:
  - add on-demand routes (`export const prerender = false`) to `customPages` in
    `astro.config.mjs` if they should be indexed;
  - exclude private/utility routes (account pages, API endpoints, admin-like UIs) with the
    sitemap `filter` option and a `Disallow` line in `src/pages/robots.txt.ts`;
  - after `npm run build`, check `dist/client/sitemap-0.xml` and `dist/client/robots.txt`.
- **Wrangler config:** keep `previews: {}` and `preview_urls: true` in `wrangler.jsonc`, and
  keep `session: false` in `astro.config.mjs` unless a KV namespace ID is configured for both
  production and `previews` (`wrangler preview` can't auto-provision bindings).
- Before pushing, run `npm run build` and `npx wrangler deploy --dry-run`.
