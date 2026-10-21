// Unit tests for the request helpers in src/lib/client.ts: sameSite() (provenance of POSTs to the
// engine, AI and upload endpoints), limiterKey() (rate-limit buckets, IPv6 by /64) and idParam().
import { describe, expect, it } from 'vitest';
import { idParam, limiterKey, MAX_ID, sameSite } from '../src/lib/client';

const URL_ = new URL('https://chessmoments.com/games/analysis/1.json');
const req = (headers: Record<string, string>) => new Request(URL_, { method: 'POST', headers });

describe('sameSite', () => {
  it('accepts an Origin naming this host', () => {
    expect(sameSite(req({ Origin: 'https://chessmoments.com' }), URL_)).toBe(true);
  });

  it('refuses another origin, even when Sec-Fetch-Site claims same-origin', () => {
    expect(sameSite(req({ Origin: 'https://evil.example' }), URL_)).toBe(false);
    expect(sameSite(req({ Origin: 'https://chessmoments.com.evil.example' }), URL_)).toBe(false);
    expect(sameSite(req({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }), URL_)).toBe(false);
  });

  it('compares the port too (host includes it)', () => {
    expect(sameSite(req({ Origin: 'https://chessmoments.com:8443' }), URL_)).toBe(false);
    const local = new URL('http://localhost:4321/x');
    expect(sameSite(new Request(local, { method: 'POST', headers: { Origin: 'http://localhost:4321' } }), local)).toBe(true);
  });

  it('refuses a request with no Origin unless the browser says same-origin', () => {
    expect(sameSite(req({}), URL_)).toBe(false);
    expect(sameSite(req({ 'Sec-Fetch-Site': 'cross-site' }), URL_)).toBe(false);
    expect(sameSite(req({ 'Sec-Fetch-Site': 'same-site' }), URL_)).toBe(false);
    expect(sameSite(req({ 'Sec-Fetch-Site': 'same-origin' }), URL_)).toBe(true);
  });

  it('treats "Origin: null" and junk as no Origin instead of throwing', () => {
    expect(sameSite(req({ Origin: 'null' }), URL_)).toBe(false);
    expect(sameSite(req({ Origin: '::not a url::' }), URL_)).toBe(false);
    expect(sameSite(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }), URL_)).toBe(true);
  });
});

describe('limiterKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys IPv6 addresses on their /64', () => {
    expect(limiterKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2::101')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  });

  it('expands "::" before taking the prefix', () => {
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
    expect(limiterKey('::')).toBe('0:0:0:0::/64');
    expect(limiterKey('2001:db8:1::5:6:7:8')).toBe('2001:db8:1:0::/64');
  });

  it('writes one key per prefix whatever the spelling', () => {
    expect(limiterKey('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('reads an IPv4-mapped address as IPv4, and counts an embedded IPv4 tail as two groups', () => {
    expect(limiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it("gives 'anon' for no address and returns junk unchanged", () => {
    expect(limiterKey(undefined)).toBe('anon');
    expect(limiterKey(null)).toBe('anon');
    expect(limiterKey('  ')).toBe('anon');
    expect(limiterKey('1::2::3')).toBe('1::2::3');
    expect(limiterKey('1:2:3')).toBe('1:2:3');
    expect(limiterKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(limiterKey('2001:db8::xyz')).toBe('2001:db8::xyz');
  });
});

describe('idParam', () => {
  it('reads the id at the start of a segment', () => {
    expect(idParam('123')).toBe(123);
    expect(idParam('3076939-r-vs-rapport-2nd-uzchess-cup-masters-2025')).toBe(3076939);
    expect(idParam(String(MAX_ID))).toBe(MAX_ID);
  });

  it('refuses ids an integer column cannot hold, zero, and non-ids', () => {
    expect(idParam(String(MAX_ID + 1))).toBeNull();
    expect(idParam('99999999999-x')).toBeNull();
    expect(idParam('0')).toBeNull();
    expect(idParam('-5')).toBeNull();
    expect(idParam('abc')).toBeNull();
    expect(idParam('')).toBeNull();
    expect(idParam(undefined)).toBeNull();
  });
});
