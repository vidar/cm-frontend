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
- **Engine analysis (on demand):** game pages offer "Analyse with Stockfish". The engine runs on our VPS
  at `ENGINE_URL` (https://engine.chessmoments.com, API in its `/llm.txt`; Worker secret
  `STOCKFISH_TOKEN`). `src/lib/analysis.ts` submits a game as a job and polls it; results are stored in
  Neon table `game_analysis` (`scripts/analysis.pg.sql`) through the site's `HYPERDRIVE` binding
  (status reads include `now()` so Hyperdrive doesn't cache them). Endpoint
  `/games/analysis/<id>.json` (GET state, POST queue; same-site, rate-limited by `ANALYSIS_LIMITER`,
  refused while the engine queue is long); UI in `src/scripts/game-analysis.ts`. The panel stays hidden
  until `ENGINE_URL` and the secret are configured. Depth 18; move marks come from `src/lib/chess/classify.ts`
  (shared by the page and the AI prompt).
- **AI notes (on demand):** once a game is analysed, "Write notes with AI" has Claude (`MODEL` in
  `src/lib/annotate.ts`, Haiku 5.5; Worker secret `ANTHROPIC_KEY`, set for Production and Previews) write a
  summary and notes on key moves for club players from the stored analysis only (no invented lines). Stored in
  Neon table `game_annotation` (`scripts/annotation.pg.sql`), endpoint `/games/annotation/<id>.json` (GET state,
  POST write; same-site, rate-limited, at most `DAILY_LIMIT` new annotations a day). UI in
  `src/scripts/game-annotation.ts`: summary in the analysis panel, notes under their moves. A preamble and
  postamble set the game in its tournament: standings going into the round and after it (team standings and the
  match score in team events, the match score in knockouts/matches), from `src/lib/annotate-context.ts`, which
  gives only what was known at the time (no final standings).
- **Tournament uploads (`/upload/`):** organisers create a tournament and get a secret link
  (`/upload/<token>/`, only a SHA-256 of the token is stored) to upload PGN round by round (or a whole file
  split by Round tags), replace or remove rounds, and preview standings. Uploads live in Neon tables `uploads`
  and `upload_rounds` (`scripts/uploads.pg.sql`) until the site owner approves them at `/upload/admin/` (Worker
  secret `ADMIN_KEY`); approval publishes them into `events`/`players`/`games` with ids from
  `UPLOAD_ID_BASE` (100000000, `src/lib/uploads.ts`), and later rounds publish at once. `games.twic = 0` and
  ids ≥ `UPLOAD_ID_BASE` mark uploaded data: those pages credit the organiser instead of TWIC, and uploaded
  event pages are cached for 5 minutes. Players match existing ones by FIDE ID only, else by exact name among
  uploaded players. The TWIC importer resumes below `UPLOAD_ID_BASE` and `--patch` keeps uploaded events;
  after a `--reset` reload use "Republish all approved" on the admin page. PGN parsing: `src/lib/pgn.ts`.
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
