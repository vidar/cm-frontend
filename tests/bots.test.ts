// Crawler classification (src/lib/bots.ts), its rate-limit keys, and robots.txt (src/pages/robots.txt.ts),
// whose AI-training group must list every training crawler bots.ts paces.
import { describe, expect, it } from 'vitest';
import { classifyBot, crawlerKey, TRAINING_AGENTS, TRAINING_ROBOTS_ONLY } from '../src/lib/bots';
import { GET } from '../src/pages/robots.txt';

const UAS: [string, string, string][] = [
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'google', 'search'],
  ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)', 'google', 'search'],
  ['Mozilla/5.0 (compatible; GoogleOther)', 'google-other', 'assistant'],
  ['Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36', 'google-store', 'assistant'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bing', 'search'],
  ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1)', 'apple', 'search'],
  ['DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', 'duckduckgo', 'search'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'openai', 'assistant'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'anthropic', 'assistant'],
  ['Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)', 'assistant-other', 'assistant'],
  ['meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'assistant-other', 'assistant'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'training', 'training'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'training', 'training'],
  ['anthropic-ai', 'training', 'training'],
  ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'training', 'training'],
  ['Mozilla/5.0 (compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/webmasters/facebookbot/)', 'training', 'training'],
  ['Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)', 'training', 'training'],
  ['Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)', 'training', 'training'],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'slack', 'preview'],
  ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'discord', 'preview'],
  ['Twitterbot/1.0', 'twitter', 'preview'],
  ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'linkedin', 'preview'],
  ['TelegramBot (like TwitterBot)', 'telegram', 'preview'],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'meta-preview', 'preview'],
  ['WhatsApp/2.23.20.0', 'meta-preview', 'preview'],
  ['Mastodon/4.3.0 (http.rb/5.2.0; +https://mastodon.social/)', 'preview-other', 'preview'],
  ['Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)', 'preview-other', 'preview'],
  ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'seo', 'other'],
  ['curl/8.0.1', 'other', 'other'],
  ['python-requests/2.32.3', 'other', 'other'],
  ['', 'other', 'other'],
];

describe('classifyBot', () => {
  it.each(UAS)('%s', (ua, family, kind) => {
    expect(classifyBot(ua)).toEqual({ family, kind });
  });
  it('treats browsers as people', () => {
    expect(classifyBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBeNull();
    expect(classifyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBeNull();
    expect(classifyBot(null)).toEqual({ family: 'other', kind: 'other' });
  });
  it('classifies every training token as training', () => {
    for (const t of TRAINING_AGENTS) expect(classifyBot(`Mozilla/5.0 (compatible; ${t}/1.0)`), t).toEqual({ family: 'training', kind: 'training' });
  });
});

describe('crawlerKey', () => {
  it('keys welcome crawlers by network, unknown bots by address (IPv6 by /64), training crawlers together', () => {
    expect(crawlerKey({ family: 'google', kind: 'search' }, '66.249.66.1', 15169)).toBe('google:15169');
    expect(crawlerKey({ family: 'google', kind: 'search' }, '1.2.3.4', 64500)).toBe('google:64500');
    expect(crawlerKey({ family: 'slack', kind: 'preview' }, '1.2.3.4', undefined)).toBe('slack:unknown');
    expect(crawlerKey({ family: 'other', kind: 'other' }, '2001:db8:1:2::5', 64500)).toBe('other:2001:db8:1:2::/64');
    expect(crawlerKey({ family: 'training', kind: 'training' }, '1.2.3.4', 64500)).toBe('training');
  });
});

describe('robots.txt', () => {
  const robots = async () => (await (GET as unknown as (c: { site: URL }) => Promise<Response>)({ site: new URL('https://chessmoments.com/') })).text();
  const groups = async () => (await robots()).split('\n\n').filter((g) => g.includes('User-agent:')).map((g) => `${g}\n`);

  it('keeps every AI-training crawler bots.ts knows off the TWIC paths', async () => {
    const training = (await groups()).find((g) => g.includes('User-agent: GPTBot'))!;
    for (const t of [...TRAINING_AGENTS, ...TRAINING_ROBOTS_ONLY]) expect(training, t).toContain(`User-agent: ${t}\n`);
    for (const p of ['/games/', '/players/', '/events/', '/sitemaps/', '/upload/', '/admin/', '/health/']) expect(training).toContain(`Disallow: ${p}\n`);
  });

  it('lets everyone else read the database pages but not the private routes', async () => {
    const all = (await groups()).find((g) => g.startsWith('User-agent: *'))!;
    expect(all).toContain('Allow: /\n');
    for (const p of ['/upload/', '/health/', '/games/analysis/', '/games/annotation/', '/players/*?', '/games/search/?']) expect(all).toContain(`Disallow: ${p}\n`);
    expect(all).not.toContain('Disallow: /games/\n');
    expect(await robots()).toContain('Sitemap: https://chessmoments.com/sitemaps/index.xml');
  });
});
