// Crawler classification by User-Agent, for pacing the database routes (src/middleware.ts).
// Search and assistant crawlers are welcome but paced; the AI-training crawlers are disallowed on
// the database paths by robots.txt (src/pages/robots.txt.ts, which takes its list from TRAINING_AGENTS
// here) and get the lowest limit if they ignore it. Link-preview fetchers (Slack, Discord, X...) have
// their own budget so a shared link still gets its card while a scraper is busy.
// Review the training list every few months: new crawlers appear all the time.
import { limiterKey } from './client';

export type BotKind = 'search' | 'assistant' | 'preview' | 'training' | 'other';
export interface Bot {
  family: string;
  kind: BotKind;
}

/**
 * AI-training crawlers, by the token they use both in robots.txt and in their User-Agent. They may read
 * the tools, openings and puzzles but not the TWIC database (used with permission for display only).
 */
export const TRAINING_AGENTS = [
  'GPTBot', 'ClaudeBot', 'anthropic-ai', 'Claude-Web', 'CCBot', 'meta-externalagent', 'FacebookBot', 'Bytespider', 'Amazonbot',
  'cohere-training-data-crawler', 'cohere-ai', 'Diffbot', 'omgilibot', 'omgili', 'AI2Bot', 'Ai2Bot-Dolma', 'PanguBot', 'Timpibot',
  'ImagesiftBot', 'img2dataset',
];
/** Training opt-out tokens that only exist in robots.txt (the crawler itself sends its search User-Agent, e.g. Googlebot). */
export const TRAINING_ROBOTS_ONLY = ['Google-Extended', 'Applebot-Extended', 'Webzio-Extended'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FAMILIES: [RegExp, string, BotKind][] = [
  // Google's other crawlers get their own buckets, so a research crawl never eats Search's budget.
  [/GoogleOther/i, 'google-other', 'assistant'],
  [/Storebot-Google/i, 'google-store', 'assistant'],
  [/Googlebot|Google-InspectionTool/i, 'google', 'search'],
  [/bingbot|BingPreview|msnbot/i, 'bing', 'search'],
  [/DuckDuckBot|DuckAssistBot/i, 'duckduckgo', 'search'],
  [/Applebot/i, 'apple', 'search'],
  [/YandexBot|YandexImages/i, 'yandex', 'search'],
  [/Baiduspider/i, 'baidu', 'search'],
  [/Slurp/i, 'yahoo', 'search'],
  [/SeznamBot|Qwantify|NaverBot|Yeti\//i, 'search-other', 'search'],
  [/ChatGPT-User|OAI-SearchBot/i, 'openai', 'assistant'],
  [/PerplexityBot|Perplexity-User/i, 'perplexity', 'assistant'],
  [/Claude-User|Claude-SearchBot/i, 'anthropic', 'assistant'],
  [/MistralAI-User|meta-externalfetcher/i, 'assistant-other', 'assistant'],
  [new RegExp(TRAINING_AGENTS.map(escape).join('|'), 'i'), 'training', 'training'],
  [/Slackbot|Slack-ImgProxy/i, 'slack', 'preview'],
  [/Discordbot/i, 'discord', 'preview'],
  [/TelegramBot/i, 'telegram', 'preview'], // before Twitter: it says "TelegramBot (like TwitterBot)"
  [/Twitterbot/i, 'twitter', 'preview'],
  [/LinkedInBot/i, 'linkedin', 'preview'],
  [/facebookexternalhit|WhatsApp/i, 'meta-preview', 'preview'],
  [/Mastodon|Bluesky|Cardyb|redditbot|Embedly|Iframely|SkypeUriPreview|vkShare|Pinterestbot/i, 'preview-other', 'preview'],
  [/AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|BLEXBot|Barkrowler|serpstatbot/i, 'seo', 'other'],
  [/bot|crawler|spider|scraper|crawling|fetch|http-client|python-requests|curl\/|wget\//i, 'other', 'other'],
];

/** The crawler behind a User-Agent, or null for a browser. Empty user agents count as 'other'. */
export function classifyBot(userAgent: string | null): Bot | null {
  if (!userAgent?.trim()) return { family: 'other', kind: 'other' };
  for (const [re, family, kind] of FAMILIES) if (re.test(userAgent)) return { family, kind };
  return null;
}

/** Uncached database pages a crawler may fetch per minute before it is asked to slow down (the bindings in wrangler.jsonc). */
export const CRAWL_LIMIT: Record<BotKind, number> = { search: 600, assistant: 60, preview: 120, training: 20, other: 20 };

/**
 * The rate-limit key for a crawler. The User-Agent is easy to fake, so the well-behaved families are
 * also keyed by the network they come from (Googlebot always crawls from Google's AS15169): someone
 * claiming to be Googlebot from elsewhere fills only their own bucket, never the real Googlebot's.
 * Unknown bots and scripts are keyed by address, so one script can't starve the others. Training
 * crawlers share one bucket: they shouldn't be on these pages at all.
 */
export function crawlerKey(bot: Bot, ip: string | null | undefined, asn: number | string | null | undefined): string {
  if (bot.kind === 'training') return bot.family;
  if (bot.kind === 'other') return `${bot.family}:${limiterKey(ip)}`;
  return `${bot.family}:${asn ?? 'unknown'}`;
}
