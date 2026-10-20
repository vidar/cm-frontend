// Crawler classification by User-Agent, for throttling the database routes (src/middleware.ts).
// Search and assistant crawlers are welcome but paced; the AI-training crawlers are disallowed on
// the database paths by robots.txt (src/pages/robots.txt.ts) and get the lower limit if they ignore it.
export type BotKind = 'search' | 'assistant' | 'training' | 'other';
export interface Bot {
  family: string;
  kind: BotKind;
}

const FAMILIES: [RegExp, string, BotKind][] = [
  [/Googlebot|Google-InspectionTool|Storebot-Google|GoogleOther/i, 'google', 'search'],
  [/bingbot|BingPreview|msnbot/i, 'bing', 'search'],
  [/DuckDuckBot|DuckAssistBot/i, 'duckduckgo', 'search'],
  [/Applebot/i, 'apple', 'search'],
  [/YandexBot|YandexImages/i, 'yandex', 'search'],
  [/Baiduspider/i, 'baidu', 'search'],
  [/Slurp/i, 'yahoo', 'search'],
  [/SeznamBot|Qwantify|NaverBot|Yeti\//i, 'search-other', 'search'],
  [/ChatGPT-User|OAI-SearchBot/i, 'openai', 'assistant'],
  [/PerplexityBot|Perplexity-User/i, 'perplexity', 'assistant'],
  [/Claude-User|Claude-SearchBot|anthropic-ai/i, 'anthropic', 'assistant'],
  [/Google-Extended|GPTBot|ClaudeBot|CCBot|Bytespider|Amazonbot|meta-externalagent|cohere-training-data-crawler|Diffbot|omgili/i, 'training', 'training'],
  [/AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|BLEXBot|Barkrowler|serpstatbot/i, 'seo', 'other'],
  [/bot|crawler|spider|scraper|crawling|fetch|http-client|python-requests|curl\/|wget\//i, 'other', 'other'],
];

/** The crawler behind a User-Agent, or null for a browser. Empty user agents count as 'other'. */
export function classifyBot(userAgent: string | null): Bot | null {
  if (!userAgent?.trim()) return { family: 'other', kind: 'other' };
  for (const [re, family, kind] of FAMILIES) if (re.test(userAgent)) return { family, kind };
  return null;
}

/** Uncached database pages a crawler family may fetch per minute before it is asked to slow down (the bindings in wrangler.jsonc). */
export const CRAWL_LIMIT: Record<BotKind, number> = { search: 600, assistant: 60, training: 20, other: 20 };
