# Hosting the games database

**Status (2026-10-21):** the site reads PostgreSQL on the Hetzner server hetz-stock (Hyperdrive config
`cm-games-hetz`), set up and migrated from Neon with [`ops/postgres/`](../ops/postgres/README.md). Neon stays,
untouched, for a rollback until it is retired (runbook steps 9–11).

## Why not Neon

Neon bills compute by the hour it is awake (compute size × wall-clock hours; it sleeps after 5 idle minutes).
The database pages are about 3.7 million URLs (3.5 M games, 120 k players, 18 k events and rounds), all in the
sitemaps, and a crawler's first visit to each is a database query, so while search engines index the site the
compute never sleeps. Always awake at the smallest size is 186 CU-hours a month: the free 100 CU-hours ran out
ten days after launch (2026-10-10), and paying for it means $20–25 a month at least (Launch plan, $0.106 per
CU-hour), more when crawls push it above the smallest size. Neon's $5 spending alert went off on 2026-10-17.

## Why hetz-stock

- **Cost:** nothing extra. The server is already paid for the engine (stockfish-svc) and render-svc.
- **No compute meter:** crawlers cost CPU time on a box we have, not money. Crawler pacing (`src/lib/bots.ts`) stays,
  now to protect the engine and the page latency rather than the bill.
- **Trade-offs:** one machine, shared with CPU-heavy neighbours (Postgres keeps to about 1 GB, its slice gets
  `CPUWeight=500` against the engine's 50 and the renders' 20, and the renders are capped so the box can't run out
  of memory); no point-in-time restore (nightly full dumps plus hourly dumps of the tables that can't be rebuilt,
  an off-site copy, and a restore drill every month); security updates are automatic, major upgrades are ours. If
  the box is lost: a new box restored from the off-site copy (newest full dump, then the site's own tables from
  the newest hourly one, then "Republish all approved"), with new secrets (certificate, Hyperdrive password);
  the runbook's "Losing the box" has the steps. Only if every dump is gone are the TWIC tables rebuilt from
  source (hours).
- **No open port:** Postgres listens on localhost; Hyperdrive comes in through a Cloudflare Tunnel (Workers VPC),
  with TLS and a role that can only do what the site does (`scripts/db/grants.sql`).

## What keeps the database load low (code)

Measured on the full dataset, connections per uncached request:

| Page | Before | After |
|---|---|---|
| Game page | 3 | 1 (+ redirect from an old URL: 1, now cached) |
| Player page | 3 (129 ms for Carlsen) | 1 (44 ms) |
| Event page | 2 | 1 |
| Round page | 3 | 2 |
| Game page viewed by a person (JSON for analysis and notes) | +2 every view | +2 the first time in 5 minutes |

- Edge cache lifetimes: game pages a month, player pages and sitemaps a week, finished TWIC events a month (a
  day while running), uploaded events, games and players 5 minutes; 301/404 answers cached too; database pages
  keep their cache across content deploys (keyed by a hash of the source, so code changes still roll it), and
  tracking parameters (fbclid, utm_*) don't bypass it.
- Sitemaps carry `<lastmod>` (games: the Monday their TWIC issue came out), so crawlers spend visits on new pages.
- robots.txt keeps crawlers off the colour/page variants of player pages and off search results.
- Crawlers are paced on cache misses: 600 uncached database pages a minute per search engine, 60 per AI
  assistant, 20 per other bot; browsers are never paced.
- Maintenance mode (`MAINTENANCE` "1" in `wrangler.jsonc`) closes only the database routes; the homepage,
  puzzles, openings, tools and robots.txt keep answering 200.

## Settings that matter

- **Hyperdrive** (new config `cm-games-hetz`): origin connection limit 20 (a soft cap; Postgres allows `cm_web` 40
  and 60 in total), caching on with the defaults (60 s). Status reads (analysis, notes, uploads) include `now()`
  so Hyperdrive never caches them. Hyperdrive has no advisory locks or session state.
- **Worker placement**: next to the database (`gcp:europe-north1`, Finland, from the switch; it was Frankfurt for
  Neon). Pages make one or two sequential queries.
- **Postgres** (`ops/postgres/postgresql.conf`): 512 MB shared buffers, 8 MB work memory, JIT off, slow queries
  (over 500 ms) logged to `/var/log/postgresql/`.

## What only you can do

1. **The move**: the dashboard and console steps of `ops/postgres/README.md` (Neon connection string, Origin CA
   certificate, tunnel, VPC service, Hyperdrive config), then say "merge". About an hour, most of it waiting.
2. **Workers plan**: uploads replay every move of a PGN, which needs more than the 10 ms of CPU a request gets on
   Workers Free. The current Hyperdrive config's connection limit of 60 suggests the account is already on Workers
   Paid; check under Workers & Pages → Plans.
3. **Off-site backups and an alarm** (`ops/postgres/README.md`, step 10): a nightly pull to the Mac mini or R2, and
   a free healthchecks.io check.
4. **Search Console**: watch Crawl Stats after reopening; Google ignores robots `Crawl-delay` (its own form:
   https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate); Bing honours it.
5. **Retire Neon** after a week or two on hetz-stock (step 11).

## Options not taken (yet)

- **Workers Caching** (`"cache": { "enabled": true }` in `wrangler.jsonc`): a shared, tiered cache in front of the
  Worker. It bills static-asset requests that are free today, and purging needs `cache.purge()` from the Worker.
- **Pre-generated sitemaps in R2**: the 50,000-row sitemap queries are the heaviest left (cached a week).
- **Cloudflare D1**: no server to run, but the database is 3 GB and growing, D1 caps at 10 GB, and every query
  would be rewritten.
