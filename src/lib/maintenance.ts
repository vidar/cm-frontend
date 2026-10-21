// Maintenance switch for the games database (src/worker.ts): with the var MAINTENANCE = "1" the
// database routes answer 503 and nothing may reach Neon.
const DB_ROUTES = /^\/(games|players|events|sitemaps|upload)(\/|$)/i;

/** The path as Astro routes it: percent-decoded until stable (it decodes up to 10 times) and with `//` collapsed, so `/%67ames/` can't slip past. */
export function routedPath(pathname: string): string {
  let p = pathname;
  for (let i = 0; i < 10; i++) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      break;
    }
    if (d === p) break;
    p = d;
  }
  return p.replace(/\/{2,}/g, '/');
}

/** Whether a request goes to a database route (closed while MAINTENANCE is "1"). */
export const isDbRoute = (url: string) => DB_ROUTES.test(routedPath(new URL(url).pathname));

/** True while the database is closed for maintenance; query() refuses to run then (defence in depth). */
export const maintenance = (env: unknown) => (env as { MAINTENANCE?: string } | undefined)?.MAINTENANCE === '1';
