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
  agents may read everything; AI *training* crawlers (list: `TRAINING_AGENTS` in `src/lib/bots.ts`) are disallowed
  on the TWIC database paths (`/games/`, `/players/`, `/events/`, `/sitemaps/`) because Mark's permission covers
  display only.
  Cloudflare's "Block AI bots", managed robots.txt and AI-training preference are therefore off for
  the zone; don't re-enable them without updating this policy. Social preview cards: `/og.png`
  (`src/lib/og.ts`, `og-url.ts`); pass `og={{...}}` to `Layout` for page-specific cards.
- **llms.txt must stay current too.** `src/pages/llms.txt.ts` lists the tools (from `src/lib/tools.ts`),
  machine-readable endpoints, the database pages' parameters and CMS pages (`/privacy/` and `/licences/`, CMS pages
  that must stay true to what the site stores and serves, are described there). When adding a tool, add it to `TOOLS`; when adding an
  endpoint or data route, add it to llms.txt.
- **Chess features:** shared code in `src/lib/` (`chess/board-svg.ts` static SVG boards, `openings.ts`,
  `puzzles.ts`, `tools.ts`) and `src/scripts/board.ts` (interactive board). Data in `src/data/` (see
  its README; Lichess, CC0). Pieces are cburnett (BSD-3) — keep the credit on `/credits/`.
  Opening stats/evals are generated offline (`scripts/`, see `src/data/README.md`) and must only be
  imported by prerendered pages so they stay out of the Worker bundle.
  The analysis board (`/analysis/`, `src/scripts/analysis.ts`, `tree.ts`, `engine.ts`) runs Stockfish
  from `public/engine/` (vendored lite single-threaded build, GPL-3: keep `COPYING.txt`/`README.txt`
  with source links next to it; no COOP/COEP headers needed).
  Daily puzzles are on-demand routes (`prerender = false`) that switch at 00:00 UTC (unknown dates: the 404 page); the puzzle set
  runs out on 2028-10-01, regenerate before then. New top-level routes must be added to the
  reserved-names hint in `public/admin/config.yml`.
- **Games database (TWIC):** PostgreSQL 18 on hetz-stock (the Hetzner box that also runs the engine),
  set up by `ops/postgres/` (its README is the runbook: roles, tunnel, backups, restore), reached only via
  Hyperdrive (binding `HYPERDRIVE`, also declared under `previews`: previews share the production database, engine
  and `ANTHROPIC_KEY`/`DAILY_LIMIT`, so their POST endpoints and upload approval write to production) over a Cloudflare Tunnel (Workers VPC);
  it listens on localhost only. The site's role `cm_web` has exactly the rights in `scripts/db/grants.sql`
  (add a line there when code starts writing a table); `cm_owner` owns everything. Schema changes go into the
  idempotent `scripts/*.pg.sql` and reach the server by rerunning `ops/postgres/install.sh` there (runbook "Kit
  updates") before the code that needs them is merged. The Hyperdrive config is
  `cm-games-hetz` (`2a7346a0…`; Neon's old one, `ff39804d…`, stays only for a rollback until Neon is retired,
  runbook step 11). Hyperdrive has no advisory locks or session state: serialise with `LOCK TABLE` inside a transaction. Loaded offline by
  `scripts/twic/` (see its README) from The Week in Chess; weekly updates build with `build.py --previous
  twic-live.sqlite`, check with `remap_events.py` and load with `import_pg.py --patch` (ids only append, analyses and
  notes stay), `--reset` only for full reloads. Data used with Mark Crowther's permission for
  non-commercial use: keep the TWIC credit + issue link on game pages, offer no bulk export/API of
  games, and tell the user if the site becomes commercial (paid tier). `src/lib/games.ts` must only
  be imported by on-demand routes; run queries through its `query()` helper (one connection per
  query, `$n` parameters). Use indexed lookups (`indexes.pg.sql`) and the `meta` table for totals;
  `ORDER BY date DESC` needs `NULLS LAST` to match the indexes (`scripts/twic/indexes.pg.sql`, also applied by
  `install.sh`). Game search (`src/lib/game-search.ts`) runs in one transaction under a 3 s `SET LOCAL
  statement_timeout` ("too broad" beyond); `/events/` takes `q` (every word), `year` and `page`. Team tiebreaks:
  Olympiads MP, Olympiad SB, GP; others MP, GP, SB. Database pages are listed in
  `/sitemaps/index.xml` (on-demand), not in `@astrojs/sitemap`; every URL there carries `<lastmod>`
  (games: the publication Monday of their TWIC issue, `twicIssueDate()`).
  **Database budget:** the database shares a 4-vCPU box with the engine, so a page makes ONE
  statement where it can: `getGamePage()`, `getPlayerPage()` and `getEventWithGames()` return the
  whole page's data with JSON aggregation (round pages add one for board moves). Keep new pages to one
  or two statements and check with `scratchpad measure.sh`-style counting (log_statement) before adding
  a query. Edge cache lifetimes (`src/middleware.ts` honours `s-maxage`): game pages a month, player
  pages and sitemaps a week, TWIC events a month once three weeks past (`eventCacheControl()`), a day
  while running, the events index, uploaded events, games and players (and TWIC players with uploaded games) 5 minutes; 301/404s of database pages are cached too (404s render the on-demand `src/pages/404.astro` via
  `Astro.rewrite('/404')`, set Cache-Control on GET only);
  purge the `games-db` tag after an import. Database pages are cache-keyed by `__DATA_VERSION__`, a hash
  of `src/` without `src/content/` (astro.config.mjs), not the build id, so CMS commits keep their cache and
  code changes roll it; the key keeps only the query parameters in `src/lib/cache-key.ts` (add one there
  when a database page starts reading it); HEAD is served and paced like GET. The "not analysed yet"/"no notes yet" JSON answers
  are cached 5 minutes; clients that just queued work poll with `?poll=1`. Cache misses of
  database pages are paced (`src/middleware.ts`, `src/lib/bots.ts`): crawlers by family (`CRAWL_SEARCH` 600/min,
  `CRAWL_ASSISTANT` 60, `CRAWL_BOT` 20 for training and, per address, unknown bots; search/assistant families keyed by
  family and ASN; link previews 120 on `VISITOR_LIMITER`), browsers 120/min per address (`VISITOR_LIMITER`), and
  searches (`/games/search/`, `/players/?q=`) 20/min per address for everyone (`SEARCH_LIMITER`); 429 + Retry-After
  beyond. robots.txt keeps crawlers off `/players/*?`, `/games/search/?` and `/events/?q=`. Slash-less on-demand
  pages 301 to the slashed URL. Worker responses get nosniff, X-Frame-Options SAMEORIGIN and Referrer-Policy
  (`src/worker.ts`; static assets via `public/_headers`). Maintenance: `MAINTENANCE` "1" in `wrangler.jsonc` (both `vars`
  blocks; deploys overwrite dashboard vars) closes only the database routes with 503 (`src/worker.ts`,
  path decoded as Astro routes it, `src/lib/maintenance.ts`) and makes `query()` refuse to connect; the
  rest of the site stays up. A 500 from a database route (the database failing) becomes a 503 with
  `Retry-After: 120` in `src/worker.ts`, so search engines retry instead of dropping URLs. `/health/db` (one
  `SELECT now()`, 200 or 503, never cached, robots Disallow; in maintenance a 503 saying so, without a query) is
  what the server's health check (`ops/postgres/check.sh`) fetches; it also watches the off-site backup copy, the
  engine's `/healthz` (`ENGINE_CHECK_URL`), failed analyses/notes with none done, maintenance left on and the age
  of `meta.built_at`.
  POST endpoints use `src/lib/client.ts` (`sameSite`, `limiterKey` keys IPv6
  by /64, `idParam` for int4 ids). Hosting decisions and the Hyperdrive settings
  that matter are in `docs/database-costs.md`.
- **Engine analysis (on demand):** game pages offer "Analyse with Stockfish". The engine runs on our VPS
  at `ENGINE_URL` (https://engine.chessmoments.com, API in its `/llm.txt`; Worker secret
  `STOCKFISH_TOKEN`). `src/lib/analysis.ts` submits a game as a job and polls it; results are stored in
  table `game_analysis` (`scripts/analysis.pg.sql`) through the site's `HYPERDRIVE` binding
  (status reads include `now()` so Hyperdrive doesn't cache them). Endpoint
  `/games/analysis/<id>.json` (GET state, POST queue; same-site, rate-limited by `ANALYSIS_LIMITER`,
  refused while the engine queue is long, at most 30 games a day per client: column `requester`, a salted hash; jobs
  time out after 30 minutes); UI in `src/scripts/game-analysis.ts`. The panel stays hidden
  until `ENGINE_URL` and the secret are configured. Depth 18; move marks come from `src/lib/chess/classify.ts`
  (shared by the page and the AI prompt).
- **AI notes (on demand):** once a game is analysed, "Write notes with AI" has Claude (`MODEL` in
  `src/lib/annotate.ts`, Haiku 5.5; Worker secret `ANTHROPIC_KEY`, set for Production and Previews) write a
  summary and notes on key moves for club players from the stored analysis only (no invented lines). Stored in
  table `game_annotation` (`scripts/annotation.pg.sql`), endpoint `/games/annotation/<id>.json` (GET state,
  POST write under `waitUntil`; same-site, rate-limited, at most `DAILY_LIMIT` new annotations a day and 10 per
  client; an AI outage stores nothing and answers 503). `getGamePage()` returns finished notes in its one
  statement, so the game page's HTML holds them (the month-long cache may lag; the client script replaces them). UI in
  `src/scripts/game-annotation.ts`: summary in the analysis panel, notes under their moves. A preamble and
  postamble set the game in its tournament: standings going into the round and after it (team standings and the
  match score in team events, the match score in knockouts/matches), from `src/lib/annotate-context.ts`, which
  gives only what was known at the time (no final standings).
- **Tournament uploads (`/upload/`):** organisers create a tournament and get a secret link
  (`/upload/<token>/`, only a SHA-256 of the token is stored) to upload PGN round by round (or a whole file
  split by Round tags), replace or remove rounds, and preview standings. Uploads live in tables `uploads`
  and `upload_rounds` (`scripts/uploads.pg.sql`) until the site owner approves them at `/upload/admin/` (Worker
  secret `ADMIN_KEY`, entered once by POST; the page keeps an HttpOnly cookie holding a digest of it, never the key
  in a URL); approval publishes them into `events`/`players`/`games` with ids from
  `UPLOAD_ID_BASE` (100000000, `src/lib/uploads.ts`), and later rounds publish at once. Those ids come from the
  sequence `upload_ids_seq`, which never goes down, so an id never names a second game (analyses, notes and cached
  pages stay with their game); every publish records each round's file time in `upload_published`. `games.twic = 0` and
  ids ≥ `UPLOAD_ID_BASE` mark uploaded data: those pages credit the organiser instead of TWIC, and uploaded
  pages are cached for 5 minutes. Players match existing ones by FIDE ID when the names agree (`sameName`; a
  FIDE ID under another name, or a new one given to clashing names, is dropped, and the preview lists how IDs
  resolve), else by exact name among uploaded players; later rounds link a TWIC player only if the tournament
  already did. Rounds whose games are unchanged are skipped; the admin page can also Delete. Files are decoded as
  UTF-16, UTF-8 or Windows-1252. The token and admin pages send `Referrer-Policy: same-origin` (not no-referrer:
  Astro's origin check needs the Origin header), and Layout leaves the analytics beacon off `/upload/<token>/`. Publishing runs one at a time (a lock on the games table: Hyperdrive has no advisory locks; a lock timeout,
  e.g. behind an import's swap, shows `BUSY` and changes nothing), in batched statements; saveRounds/deleteRound lock
  the upload row; Round tags are stored rebuilt from the numbers ("5.1"). `LIMITS` caps bytes (and `stored` per tournament), games (per round
  and tournament), plies (per game and file, 60,000, failed games count), pending and daily tournaments per address
  (column `uploads.client`, a digest), pending tournaments with games, and new ones a day; uploads replay
  every move with chess.js, which needs Workers Paid CPU time for real rounds. The TWIC importer resumes below
  `UPLOAD_ID_BASE`, `--patch` keeps uploaded events, and an uploaded slug TWIC now uses is renamed `<slug>-u<n>`;
  after a `--reset` reload or a restore use "Republish all approved" on the admin page. After a restore it publishes
  again only the rounds whose file differs from what `upload_published` recorded (which only the full backup
  holds), so everything else keeps its game ids, analyses and notes; after a `--reset` every approved tournament is
  published whole with new game ids, and the analyses and notes of uploaded games are lost (`scripts/twic/README.md`).
  Either way it takes uploaded events off the site that no approved upload of that name points to. The id counter
  makes each table's uploaded ids sparse: `/sitemaps/index.xml` lists only the uploaded files that hold rows. PGN parsing: `src/lib/pgn.ts`.
- **Layout:** the canonical URL is the slash-normalised path; a skip link targets `<main id="main">`.
- **Structured data:** `Layout` takes `jsonLd` (an object or a `@graph` array; `@context` is added)
  and renders it in `<head>`. Game pages give BreadcrumbList + WebPage about the players and event,
  player pages Person (FIDE profile as `sameAs`), event pages SportsEvent with competitors and rounds
  as `subEvent`, round pages the round with its `superEvent`, the homepage WebSite + SearchAction.
- **Tests:** `npm test` (vitest, `tests/*.test.ts`; `cloudflare:workers` is stubbed by
  `tests/stubs/cloudflare-workers.ts`). Pure modules are tested with hand-computed fixtures;
  `*-db.test.ts` run one at a time against a local Postgres database (`TEST_DATABASE_URL`, default
  `postgres://postgres:postgres@localhost:5432/cm_games_test`: `createdb -T cm_games cm_games_test` or
  `tests/fixtures/create-test-db.sh`) and skip themselves without one; the writing suites refuse `cm_games`, and an
  explicit `TEST_DATABASE_URL` that doesn't work fails. games-db and game-search-db run their exact assertions only
  on the production snapshot or the 14-issue sample. GitHub Actions (`.github/workflows/test.yml`) runs the suite
  against a postgres:18 service as `cm_web`, the build and dry run, and the TWIC importer's Python tests
  (`python3 -m unittest discover -s scripts/twic/tests`). Keep logic that needs testing
  out of `.astro` frontmatter and in `src/lib`.
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
