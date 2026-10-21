// Edge-cache key for the database pages (src/middleware.ts). The key keeps only the query
// parameters those pages read, sorted, so tracking tags (fbclid, utm_*, gclid), random cache
// busters and reordered parameters all share one cached entry instead of each costing a query.
// A parameter a database page starts reading must be added here, or its variants would share
// one entry.

/** Every query parameter read by /games/, /players/, /events/ and /sitemaps/ routes. */
export const KEY_PARAMS = new Set([
  // player pages and event pages
  'page', 'color', 'all',
  // player search and suggestions
  'q',
  // analysis / AI-notes JSON: a client polling live state must not get the cached answer
  'poll',
  // game search (src/lib/game-search.ts parseSearch)
  'white', 'black', 'any', 'result', 'event', 'opening', 'from', 'to', 'rating', 'minmoves', 'maxmoves', 'sort',
]);

/** The cache-key URL for a database page: allowed parameters only, sorted, plus the cache version. */
export function dbCacheKey(url: URL, version: string): string {
  const key = new URL(url.origin + url.pathname);
  const kept = [...url.searchParams].filter(([k]) => KEY_PARAMS.has(k)).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  for (const [k, v] of kept) key.searchParams.append(k, v);
  key.searchParams.set('__build', version);
  return key.toString();
}
