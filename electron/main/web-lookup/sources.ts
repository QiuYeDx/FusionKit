import { WEB_SNIPPET_LIMIT, WEB_TEXT_LIMIT, type WebLanguage, type WebPage, type WebSearchHit, type WebSearchRequest, type WebSource } from '../../../src/web-lookup/contract';
import { WebLookupError } from './guard';
import { htmlDescription, htmlTitle, htmlToText, inlineText } from './html';

/** Fetches a public URL as text; supplied by the service, which enforces the safety limits. */
export type FetchText = (url: string, accept: 'json' | 'html') => Promise<{ url: string; text: string }>;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const now = () => new Date().toISOString();
function json(text: string): Record<string, any> {
  try { return JSON.parse(text); } catch { throw new WebLookupError('web_lookup_failed'); }
}
function page(url: string, title: string, text: string, site: string): WebPage {
  const clean = text.trim();
  return { url, title: clip(title, 300), text: clip(clean, WEB_TEXT_LIMIT), truncated: clean.length > WEB_TEXT_LIMIT, site, accessedAt: now() };
}

/** A MediaWiki site: its API, how article links are formed and, for Chinese wikis, the script to convert to. */
type Wiki = { api: string; article: (title: string) => string; site: string; extracts: boolean; variant?: 'zh-cn' | 'zh-tw' };
const encodeTitle = (title: string) => encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
/** Chinese wikis store mixed Simplified and Traditional text and convert it on request. */
const chineseVariant = (language: WebLanguage) => language === 'zh-Hant' ? 'zh-tw' as const : 'zh-cn' as const;
export const wikis = {
  wikipedia: (language: WebLanguage): Wiki => {
    const host = `${language.startsWith('zh') ? 'zh' : language}.wikipedia.org`;
    const variant = language.startsWith('zh') ? chineseVariant(language) : undefined;
    return { api: `https://${host}/w/api.php`, article: title => `https://${host}/${variant ?? 'wiki'}/${encodeTitle(title)}`, site: host, extracts: true, variant };
  },
  // The official zh.moegirl.org.cn refuses programmatic access (API and Cloudflare challenge); its mirror serves the same wiki.
  moegirl: (language: WebLanguage = 'zh'): Wiki => {
    const variant = chineseVariant(language);
    return { api: 'https://moegirl.uk/api.php', article: title => `https://moegirl.uk/${encodeTitle(title)}${variant === 'zh-tw' ? '?variant=zh-tw' : ''}`, site: 'moegirl.uk', extracts: true, variant };
  },
  biligame: (code: string): Wiki => ({ api: `https://wiki.biligame.com/${code}/api.php`, article: title => `https://wiki.biligame.com/${code}/${encodeTitle(title)}`, site: `wiki.biligame.com/${code}`, extracts: false }),
};
const variantParam = (wiki: Wiki) => wiki.variant ? `&variant=${wiki.variant}` : '';

async function wikiSearch(wiki: Wiki, query: string, limit: number, fetchText: FetchText): Promise<WebSearchHit[]> {
  const url = `${wiki.api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srprop=snippet&format=json&utf8=1${variantParam(wiki)}`;
  const data = json((await fetchText(url, 'json')).text);
  const hits = data?.query?.search;
  if (!Array.isArray(hits)) throw new WebLookupError('web_lookup_failed');
  return hits.slice(0, limit).flatMap((hit: { title?: unknown; snippet?: unknown }) => typeof hit.title === 'string'
    ? [{ title: hit.title, url: wiki.article(hit.title), snippet: clip(inlineText(String(hit.snippet ?? '')), WEB_SNIPPET_LIMIT) }] : []);
}

async function wikiRead(wiki: Wiki, title: string, fetchText: FetchText): Promise<WebPage> {
  if (wiki.extracts) {
    const url = `${wiki.api}?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&utf8=1${variantParam(wiki)}`;
    const pages = json((await fetchText(url, 'json')).text)?.query?.pages;
    const first = pages && Object.values(pages)[0] as { title?: string; extract?: string; missing?: unknown } | undefined;
    if (!first || first.missing !== undefined || typeof first.extract !== 'string') throw new WebLookupError('web_lookup_not_found');
    return page(wiki.article(first.title ?? title), first.title ?? title, first.extract, wiki.site);
  }
  const url = `${wiki.api}?action=parse&page=${encodeURIComponent(title)}&prop=text&redirects=1&format=json&formatversion=2`;
  const parsed = json((await fetchText(url, 'json')).text);
  if (parsed?.error || typeof parsed?.parse?.text !== 'string') throw new WebLookupError('web_lookup_not_found');
  return page(wiki.article(parsed.parse.title ?? title), parsed.parse.title ?? title, htmlToText(parsed.parse.text), wiki.site);
}

/** Baidu Baike's item pages run a script challenge; its public lemma card interface gives the summary instead. */
const BAIKE = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_length=600&bk_key=';
async function baikeCard(key: string, fetchText: FetchText) {
  const data = json((await fetchText(BAIKE + encodeURIComponent(key), 'json')).text);
  if (!data || typeof data.key !== 'string' || !data.key) throw new WebLookupError('web_lookup_not_found');
  const fields = Array.isArray(data.card) ? data.card.flatMap((item: { name?: unknown; value?: unknown }) =>
    typeof item.name === 'string' && Array.isArray(item.value) ? [`${item.name}：${item.value.map(value => inlineText(String(value))).join('、')}`] : []) : [];
  const title = String(data.title || data.key);
  return { title, url: `https://baike.baidu.com/item/${encodeURIComponent(String(data.key))}`, description: inlineText(String(data.desc ?? '')), abstract: inlineText(String(data.abstract ?? '')), fields };
}

/** Bing result links may be wrapped in a click redirect whose `u` parameter carries the target. */
export function bingTarget(href: string): string | undefined {
  try {
    const url = new URL(href, 'https://cn.bing.com');
    if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u');
      if (!encoded?.startsWith('a1')) return undefined;
      const target = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return /^https?:\/\//.test(target) ? target : undefined;
    }
    if (/(^|\.)bing\.com$/.test(url.hostname) || /(^|\.)microsoft\.com$/.test(url.hostname) && url.pathname.startsWith('/bing')) return undefined;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

/** Organic results of a Bing results page; ads, answers and Bing's own links are left out. */
export function parseBingResults(html: string, limit: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    const url = bingTarget(anchor[1].replace(/&amp;/g, '&'));
    if (!url || hits.some(hit => hit.url === url)) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(block);
    hits.push({ title: inlineText(anchor[2]), url, snippet: clip(inlineText(snippet?.[1] ?? '').replace(/阅读更多$|Read more$/, '').trim(), WEB_SNIPPET_LIMIT) });
    if (hits.length >= limit) break;
  }
  return hits;
}
const BING_LANGUAGE: Record<WebLanguage, string> = { zh: 'zh-Hans', 'zh-Hant': 'zh-Hant', ja: 'ja', en: 'en' };

export async function searchSource(request: Required<Pick<WebSearchRequest, 'source' | 'query' | 'language' | 'limit'>> & Pick<WebSearchRequest, 'game' | 'site'>, fetchText: FetchText): Promise<WebSearchHit[]> {
  const { source, query, language, limit } = request;
  switch (source as WebSource) {
    case 'wikipedia': return wikiSearch(wikis.wikipedia(language), query, limit, fetchText);
    case 'moegirl': return wikiSearch(wikis.moegirl(language), query, limit, fetchText);
    case 'biligame':
      if (!request.game) throw new WebLookupError('invalid_input');
      return wikiSearch(wikis.biligame(request.game), query, limit, fetchText);
    case 'baidu_baike': {
      try {
        const card = await baikeCard(query, fetchText);
        return [{ title: card.title, url: card.url, snippet: clip([card.description, card.abstract].filter(Boolean).join(' — '), WEB_SNIPPET_LIMIT) }];
      } catch (error) { if (error instanceof WebLookupError && error.code === 'web_lookup_not_found') return []; throw error; }
    }
    case 'bing': {
      const q = request.site ? `${query} site:${request.site}` : query;
      const { text } = await fetchText(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=${BING_LANGUAGE[language]}&count=${Math.min(10, limit + 2)}`, 'html');
      return parseBingResults(text, limit);
    }
  }
}

/** Reads a page: known wikis and Baidu Baike through their interfaces, anything else as HTML. */
export async function readPage(url: URL, fetchText: FetchText): Promise<WebPage> {
  const host = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname);
  // Traditional when the link asks for it (a /zh-tw/ path or ?variant=zh-tw), Simplified otherwise.
  const traditional = (variant: string | null | undefined) => !!variant && /^zh-(tw|hk|mo|hant)$/.test(variant.toLowerCase());
  const wikipedia = /^(zh|ja|en)\.(?:m\.)?wikipedia\.org$/.exec(host);
  const article = /^\/(wiki|zh(?:-[a-z]+)?)\/(.+)$/i.exec(path);
  if (wikipedia && article) {
    const language: WebLanguage = wikipedia[1] !== 'zh' ? wikipedia[1] as WebLanguage : traditional(article[1] === 'wiki' ? url.searchParams.get('variant') : article[1]) ? 'zh-Hant' : 'zh';
    return wikiRead(wikis.wikipedia(language), article[2].replace(/_/g, ' '), fetchText);
  }
  if ((host === 'moegirl.uk' || host === 'zh.moegirl.org.cn' || host === 'mzh.moegirl.org.cn') && path.length > 1) {
    const variantPath = /^\/(zh(?:-[a-z]+)?)\/(.+)$/i.exec(path);
    const language: WebLanguage = traditional(variantPath?.[1] ?? url.searchParams.get('variant')) ? 'zh-Hant' : 'zh';
    return wikiRead(wikis.moegirl(language), (variantPath?.[2] ?? path.slice(1)).replace(/_/g, ' '), fetchText);
  }
  const bili = /^\/([a-z0-9][a-z0-9_-]{0,39})\/(.+)$/.exec(path);
  if (host === 'wiki.biligame.com' && bili) return wikiRead(wikis.biligame(bili[1]), bili[2].replace(/_/g, ' '), fetchText);
  const baike = /^\/item\/([^/]+)/.exec(path);
  if (host === 'baike.baidu.com' && baike) {
    const card = await baikeCard(baike[1], fetchText);
    return page(card.url, card.title, [card.description, card.abstract, ...card.fields].filter(Boolean).join('\n'), 'baike.baidu.com');
  }
  const { url: finalUrl, text } = await fetchText(url.href, 'html');
  // A page drawn by scripts has no text in its HTML; its description is better than nothing.
  const body = /^\s*[{[]/.test(text) ? text : htmlToText(text) || htmlDescription(text);
  return page(finalUrl, htmlTitle(text) || new URL(finalUrl).hostname, body, new URL(finalUrl).hostname);
}
