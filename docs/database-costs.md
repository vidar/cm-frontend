# Keeping the games database affordable

Written 2026-10-20 after the Neon free allowance ran out ten days after launch. Sources: the Neon
plans/pricing pages, Google's crawl-rate and site-outage guidance, Cloudflare's Workers/Hyperdrive
docs (all read that day), and measurements on a local copy of the full database.

## What Neon bills

Compute hours = compute size (CU) × wall-clock hours the endpoint is awake. Queries don't cost
anything by themselves; being awake does. The endpoint suspends after 5 minutes without a query
(fixed on the Free plan) and accrues nothing while suspended.

- Free plan: 100 CU-hours a month per project, autoscaling up to 2 CU, smallest size 0.25 CU.
  Running out suspends the compute until the next month (that is the outage we had).
- Always awake at 0.25 CU = 744 h × 0.25 = **186 CU-hours a month**, 1.86× the free allowance:
  it lasts about 16 days even with perfect queries. We lasted 10, which means the endpoint never
  slept and scaled above 0.25 CU part of the time (crawler bursts on the heavy pages).
- Launch plan: pay as you go, **$0.106 per CU-hour**, no monthly minimum, no included hours.
  Always awake and pinned at 0.25 CU: about **$19.70 a month** (plus storage at Launch rates;
  the console shows the database size).

## Why it can't sleep while being indexed

The database pages are about 3.7 million unique URLs (3.5 M games, 120 k players, 18 k events
and their rounds), all listed in the sitemaps. Caches are per URL, so a crawler's first visit to
each page is always a database query, and any crawl rate that indexes the site in months is far
above one query per five minutes. While search engines index the site, the endpoint is awake
around the clock whatever the queries cost.

**Verdict: the Free plan cannot carry the site while it is being indexed.** The only free
configuration that fits on paper is answering every crawler with 429 outside a ~10-hour daily
window, which Google treats as a site in trouble (it lowers the crawl rate for the whole host and
drops URLs that fail for more than two days). Not recommended.

**Cheapest workable setup: Neon Launch with the compute pinned at 0.25 CU, ~$20–25 a month.**
Paying for hosting doesn't make the site commercial, so the TWIC terms are unaffected.

## What changed in the code (branch `claude/nice-darwin-fmxre9`)

Measured on the full dataset, connections per uncached request:

| Page | Before | After |
|---|---|---|
| Game page | 3 | 1 (+ redirect from an old URL: 1, now cached) |
| Player page | 3 (129 ms for Carlsen) | 1 (44 ms) |
| Event page | 2 | 1 |
| Round page | 3 | 2 |
| Game page viewed by a person (JSON for analysis and notes) | +2 every view | +2 the first time in 5 minutes |

- Edge cache lifetimes: game pages a month, player pages and sitemaps a week, finished TWIC
  events a month (a day while running), uploaded events 5 minutes; 301/404 answers cached too;
  the database pages keep their cache across content deploys (keyed by a hash of the source, so
  code changes still roll it), and tracking parameters (fbclid, utm_*) no longer bypass it.
- Sitemaps carry `<lastmod>` (games: the Monday their TWIC issue came out), so crawlers spend
  their visits on new pages.
- robots.txt keeps crawlers off the colour/page variants of player pages and off search results.
- Crawlers are paced on cache misses: 600 uncached database pages a minute per search engine
  (a backstop; Google treats 429 as an emergency signal), 60 per AI assistant, 20 per other bot;
  browsers are never paced (`src/lib/bots.ts`, `src/middleware.ts`, bindings in `wrangler.jsonc`).
- Maintenance mode (`MAINTENANCE=1`) now closes only the database routes; the homepage, puzzles,
  openings, tools and robots.txt keep answering 200 (a 503 on robots.txt stops crawling, and a
  site that is 503 for weeks loses rankings).

## What only you can do

1. **Neon → Launch, and pin the compute** (project settings: minimum = maximum = 0.25 CU; raise
   the maximum only if pages feel slow). Budget ~$20–25 a month. With the Free plan the site
   dies again around day 16 of every month.
2. **Hyperdrive query cache: raise `max_age` from 60 s to 600 s** (Workers & Pages → Hyperdrive →
   cm-games → caching; or `npx wrangler hyperdrive update ff39804dfb964a2ca13a9e1d7ec27cbe
   --caching-max-age 600 --caching-stale-while-revalidate 60`). The event query is the same for
   an event page and all its round pages, so a crawl of an Olympiad costs one query instead of
   twelve. Status reads for analysis and uploads use `now()` and stay uncached. An organiser's
   newly uploaded round can then lag up to 10 minutes.
3. **Workers plan**: on Workers Free, 100,000 requests a day is the cap; a full crawl of the
   database pages runs into it. Workers Paid ($5 a month, 10 M requests included) removes it. It
   is also needed before tournament uploads go live: reading a round replays every move, which
   takes far more than the 10 ms of CPU a request gets on Workers Free.
4. **Search Console**: watch Crawl Stats after reopening; if Googlebot's rate is too high for
   the database, the request form at
   https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate is Google's own
   route (robots `Crawl-delay` is ignored by Google; Bing honours it and has a crawl-control
   panel in Bing Webmaster Tools).
5. **Reopen** by setting `MAINTENANCE` to `"0"` in `wrangler.jsonc` (both `vars` blocks) once the
   database is back, or tell Claude to; the longer the database routes are closed, the more
   re-indexing is lost. `wrangler.jsonc` is the only source of truth: a change in the dashboard is
   overwritten by the next deploy, and every CMS commit deploys.

## Options not taken (yet)

- **Workers Caching** (`"cache": { "enabled": true }` in `wrangler.jsonc`, Wrangler ≥ 4.69): a
  shared, tiered cache in front of the Worker that serves hits without running it. Worth turning
  on once on Workers Paid; it bills static-asset requests that are free today, and purging then
  needs `cache.purge({ tags: ['games-db'] })` from inside the Worker rather than the zone API.
- **Pre-generated sitemaps in R2** (the 50,000-row sitemap query is the heaviest statement left;
  it is cached a week). Needs an R2 bucket, i.e. a payment method on the account.
- **Cloudflare D1 instead of Neon**: no awake-time billing at all (~$5 a month all in), but the
  database is 2.2 GB and growing, D1 caps at 10 GB, and every query would be rewritten. A
  multi-day migration; the long-term cheapest path if the Neon bill ever matters.
- **A 2 CU-friendly night mode** (429 to crawlers for part of the day): rejected, see above.
