import { z } from 'zod';

/**
 * Keyless web lookups for the assistant: search fixed public sources and read public pages, in the
 * main process. Only the query and page links leave the computer; nothing is written.
 */
export const WEB_LOOKUP_CHANNEL_PREFIX = 'web-lookup:';
export const WEB_LOOKUP_CHANNELS = { search: 'web-lookup:search', read: 'web-lookup:read' } as const;

/** Sources in the order the assistant is told to prefer them for general topics. */
export const WEB_SOURCES = ['wikipedia', 'moegirl', 'baidu_baike', 'biligame', 'bing'] as const;
export type WebSource = (typeof WEB_SOURCES)[number];
/** zh is Simplified and zh-Hant Traditional Chinese; the Chinese wikis convert their text to it. */
export const WEB_LANGUAGES = ['zh', 'zh-Hant', 'ja', 'en'] as const;
export type WebLanguage = (typeof WEB_LANGUAGES)[number];
export const WEB_RESULT_LIMIT = 8;
export const WEB_TEXT_LIMIT = 8000;
export const WEB_SNIPPET_LIMIT = 300;
/** A Bilibili game wiki is addressed by its code, as in wiki.biligame.com/zzz. */
export const biligameCodeSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const hostname = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export const webSearchRequestSchema = z.object({
  source: z.enum(WEB_SOURCES),
  query: z.string().trim().min(1).max(200),
  language: z.enum(WEB_LANGUAGES).default('zh'),
  /** biligame: which game's wiki. */
  game: biligameCodeSchema.optional(),
  /** bing: limit results to one site, such as a game's official site. */
  site: hostname.optional(),
  limit: z.number().int().min(1).max(WEB_RESULT_LIMIT).default(5),
}).strict();
export const webReadRequestSchema = z.object({ url: z.string().trim().min(8).max(2000) }).strict();
export type WebSearchRequest = z.input<typeof webSearchRequestSchema>;
export type WebReadRequest = z.infer<typeof webReadRequestSchema>;

export type WebSearchHit = { title: string; url: string; snippet: string };
export type WebSearchResult = { source: WebSource; query: string; results: WebSearchHit[] };
export type WebPage = {
  url: string;
  title: string;
  /** Main text, plain, at most WEB_TEXT_LIMIT characters. */
  text: string;
  truncated: boolean;
  /** Where it was read, such as "zh.wikipedia.org" or "moegirl.uk". */
  site: string;
  accessedAt: string;
};
export type WebLookupErrorCode = 'invalid_input' | 'web_lookup_blocked' | 'web_lookup_failed' | 'web_lookup_timeout' | 'web_lookup_not_found';
export type WebLookupResult<T> = { ok: true; value: T } | { ok: false; error: WebLookupErrorCode };

export interface WebLookupApi {
  search(request: WebSearchRequest): Promise<WebLookupResult<WebSearchResult>>;
  read(request: WebReadRequest): Promise<WebLookupResult<WebPage>>;
}
