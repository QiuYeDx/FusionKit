import { lookup as dnsLookup } from 'node:dns/promises';
import axios from 'axios';
import { webReadRequestSchema, webSearchRequestSchema, type WebLookupResult, type WebPage, type WebSearchResult } from '../../../src/web-lookup/contract';
import { getAxiosProxyConfig } from '../proxy';
import { assertPublicHost, isPrivateAddress, parsePublicUrl, WebLookupError, type LookupAll } from './guard';
import { readPage, searchSource, type FetchText } from './sources';

export const WEB_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const ACCEPTED = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/[a-z.+-]*json)\b/i;

/** One HTTP GET without following redirects; the service follows them itself after checking each hop. */
export type HttpGet = (url: string, accept: 'json' | 'html') => Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }>;

function userAgent() {
  return `Mozilla/5.0 (compatible; FusionKit/${process.env.npm_package_version ?? '0.4'}; translation materials lookup)`;
}

/**
 * The connection resolves the host again; on a direct connection it may only use public addresses, so
 * a name that changes its answer after the check still cannot reach the local network. Through a
 * proxy, the proxy resolves the target and the check before the request applies.
 */
export function publicOnlyLookup(lookup: LookupAll = host => dnsLookup(host, { all: true })) {
  return async (hostname: string) => {
    const addresses = await lookup(hostname);
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new WebLookupError('web_lookup_blocked');
    return addresses.map(({ address, family }) => ({ address, family }));
  };
}
const directConnection = (proxy: ReturnType<typeof getAxiosProxyConfig>) =>
  proxy.proxy === false || (!('proxy' in proxy) && !process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !process.env.https_proxy && !process.env.http_proxy);

export const axiosGet: HttpGet = async (url, accept) => {
  try {
    const proxy = getAxiosProxyConfig();
    const response = await axios.get<ArrayBuffer>(url, {
      ...proxy, ...(directConnection(proxy) ? { lookup: publicOnlyLookup() as never } : {}), maxRedirects: 0, validateStatus: () => true, responseType: 'arraybuffer', timeout: TIMEOUT_MS,
      maxContentLength: WEB_MAX_BYTES, maxBodyLength: WEB_MAX_BYTES, decompress: true, withCredentials: false,
      headers: { 'User-Agent': userAgent(), Accept: accept === 'json' ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7' },
    });
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value === undefined ? undefined : String(value)]));
    return { status: response.status, headers, body: Buffer.from(response.data) };
  } catch (error) {
    if (error instanceof WebLookupError || (error as { cause?: unknown }).cause instanceof WebLookupError) throw new WebLookupError('web_lookup_blocked');
    const code = (error as { code?: string }).code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') throw new WebLookupError('web_lookup_timeout');
    throw new WebLookupError('web_lookup_failed');
  }
};

function decode(body: Buffer, contentType: string | undefined): string {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  try { return new TextDecoder(charset && charset !== 'utf8' ? charset : 'utf-8').decode(body); }
  catch { return new TextDecoder('utf-8').decode(body); }
}

/**
 * Searches fixed public sources and reads public pages. Every request, including each redirect
 * hop, must go to a public host; responses are size-, type- and time-limited and carry no cookies.
 */
export class WebLookupService {
  constructor(private readonly get: HttpGet = axiosGet, private readonly lookup: LookupAll = host => dnsLookup(host, { all: true })) {}

  private fetchText: FetchText = async (raw, accept) => {
    let url = parsePublicUrl(raw);
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url, this.lookup);
      const response = await this.get(url.href, accept);
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new WebLookupError('web_lookup_failed');
        url = parsePublicUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status === 404) throw new WebLookupError('web_lookup_not_found');
      if (response.status >= 400) throw new WebLookupError('web_lookup_failed');
      if (response.body.length > WEB_MAX_BYTES) throw new WebLookupError('web_lookup_failed');
      const type = response.headers['content-type'];
      if (type && !ACCEPTED.test(type)) throw new WebLookupError('web_lookup_failed');
      return { url: url.href, text: decode(response.body, type) };
    }
  };

  async search(input: unknown): Promise<WebLookupResult<WebSearchResult>> {
    const parsed = webSearchRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_input' };
    return this.run(async () => ({ source: parsed.data.source, query: parsed.data.query, results: await searchSource(parsed.data, this.fetchText) }));
  }

  async read(input: unknown): Promise<WebLookupResult<WebPage>> {
    const parsed = webReadRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_input' };
    return this.run(async () => readPage(parsePublicUrl(parsed.data.url), this.fetchText));
  }

  private async run<T>(body: () => Promise<T>): Promise<WebLookupResult<T>> {
    try { return { ok: true, value: await body() }; }
    catch (error) { return { ok: false, error: error instanceof WebLookupError ? error.code : 'web_lookup_failed' }; }
  }
}
