// Request helpers for the site's own POST endpoints (engine analysis, AI notes, uploads): is the
// request from one of our pages, which rate-limit bucket does the client fall in, and the id in a URL.

/**
 * Did the request come from a page of this site? True when the Origin header names this host, or,
 * without a usable Origin, when the browser says `Sec-Fetch-Site: same-origin`. A different origin is
 * always refused. Never throws (`Origin: null` and junk count as no Origin).
 * Headers only stop casual abuse: a script can send any Origin it likes.
 */
export function sameSite(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  let host: string | null = null;
  try {
    host = origin ? new URL(origin).host : null;
  } catch {
    host = null;
  }
  if (host) return host === url.host;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

/**
 * Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (a subscriber gets a whole /64, so
 * keying the full address would give one client 2^64 buckets), 'anon' when unknown. IPv4-mapped IPv6
 * counts as the IPv4 address. Unparseable input is returned unchanged.
 */
export function limiterKey(ip: string | null | undefined): string {
  const addr = ip?.trim().split('%')[0].toLowerCase();
  if (!addr) return 'anon';
  if (!addr.includes(':')) return addr;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1];
  const halves = addr.split('::');
  if (halves.length > 2) return addr;
  // An embedded IPv4 tail ("64:ff9b::1.2.3.4") takes two groups.
  const groups = (s: string) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return addr;
  const all = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return addr;
  return `${all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/** Largest id a Postgres `integer` column holds: bigger ids would fail the query instead of finding nothing. */
export const MAX_ID = 2_147_483_647;

/** The id at the start of a URL segment ("123" or "123-some-slug"), or null when it isn't a valid row id (1..MAX_ID). */
export function idParam(segment: string | undefined): number | null {
  const m = /^(\d{1,10})(?!\d)/.exec(segment ?? '');
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_ID ? n : null;
}
