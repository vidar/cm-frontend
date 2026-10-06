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
- **AI crawlers:** `src/pages/robots.txt.ts` is the single source of the policy: search/assistant
  agents may read everything; AI *training* crawlers are disallowed on the TWIC database paths
  (`/games/`, `/players/`, `/events/`, `/sitemaps/`) because Mark's permission covers display only.
  Cloudflare's "Block AI bots", managed robots.txt and AI-training preference are therefore off for
  the zone; don't re-enable them without updating this policy. Social preview cards: `/og.png`
  (`src/lib/og.ts`, `og-url.ts`); pass `og={{...}}` to `Layout` for page-specific cards.
- **llms.txt must stay current too.** `src/pages/llms.txt.ts` lists the tools (from `src/lib/tools.ts`),
  machine-readable endpoints and CMS pages. When adding a tool, add it to `TOOLS`; when adding an
  endpoint or data route, add it to llms.txt.
- **Chess features:** shared code in `src/lib/` (`chess/board-svg.ts` static SVG boards, `openings.ts`,
  `puzzles.ts`, `tools.ts`) and `src/scripts/board.ts` (interactive board). Data in `src/data/` (see
  its README; Lichess, CC0). Pieces are cburnett (BSD-3) — keep the credit on `/credits/`.
  Opening stats/evals are generated offline (`scripts/`, see `src/data/README.md`) and must only be
  imported by prerendered pages so they stay out of the Worker bundle.
  The analysis board (`/analysis/`, `src/scripts/analysis.ts`, `tree.ts`, `engine.ts`) runs Stockfish
  from `public/engine/` (vendored lite single-threaded build, GPL-3: keep `COPYING.txt`/`README.txt`
  with source links next to it; no COOP/COEP headers needed).
  Daily puzzles are on-demand routes (`prerender = false`) that switch at 00:00 UTC; the puzzle set
  runs out on 2028-10-01, regenerate before then. New top-level routes must be added to the
  reserved-names hint in `public/admin/config.yml`.
- **Games database (TWIC):** Neon Postgres via Hyperdrive (binding `HYPERDRIVE`, also declared under
  `previews`; the Hyperdrive config connects as the read-only role `readonly`), loaded offline by
  `scripts/twic/` (see its README) from The Week in Chess, used with Mark Crowther's permission for
  non-commercial use: keep the TWIC credit + issue link on game pages, offer no bulk export/API of
  games, and tell the user if the site becomes commercial (paid tier). `src/lib/games.ts` must only
  be imported by on-demand routes; run queries through its `query()` helper (one connection per
  query, `$n` parameters). Use indexed lookups (`indexes.pg.sql`) and the `meta` table for totals;
  `ORDER BY date DESC` needs `NULLS LAST` to match the indexes. Database pages are listed in
  `/sitemaps/index.xml` (on-demand), not in `@astrojs/sitemap`.
- **Design:** warm, understated amber. Colours are tokens in `src/layouts/Layout.astro` (`--bg`,
  `--surface`, `--surface-2`, `--fg`, `--muted`, `--border`, `--accent` for text/active states,
  `--accent-fill` for filled controls with white text, `--accent-soft` tints, `--win`/`--loss`),
  with dark values under `prefers-color-scheme`. Use tokens, not hex. Amber is for links in running
  text, the active nav item, current/selected states and key highlights; table and list links stay
  `--fg`. Fonts (self-hosted via Astro's fonts API in `astro.config.mjs`): Fraunces for headings
  (`--font-head`), Inter for text (`--font-body`). Global button/input styles use `:where()` so
  component styles override them; `button.primary` is the filled amber button.
  Board styles (Walnut default, Tournament, Ice, Marble) are `--sq-*` tokens per
  `html[data-board]`, chosen with `src/components/BoardStyle.astro` (footer + under boards) and
  remembered in localStorage (`cm-board`, applied before paint in Layout). Interactive boards
  (`board.css`) and inline diagrams (`BoardDiagram`, `renderBoardSvg({ themable: true })`) follow it;
  image exports (`/board.svg`, `/og.png`) keep fixed Walnut colours.
- **Wrangler config:** keep `previews: {}` and `preview_urls: true` in `wrangler.jsonc`, and
  keep `session: false` in `astro.config.mjs` unless a KV namespace ID is configured for both
  production and `previews` (`wrangler preview` can't auto-provision bindings).
- Before pushing, run `npm run build` and `npx wrangler deploy --dry-run`.
