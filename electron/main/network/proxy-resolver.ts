import { isIP } from 'node:net';
import type { NetworkSettings } from '../../../src/network/contract';
import { parseCustomProxy, PROXY_URL_SCHEMES, splitHostPort, type ProxyServerAddress } from '../../../src/network/proxy-address';

export { parseCustomProxy };

/** One way to reach a target: directly, or through one proxy server. */
export type ProxyRoute = { readonly kind: 'direct' } | ProxyServerAddress;

type ProxyKind = ProxyServerAddress['kind'];

export const DIRECT_ROUTE: ProxyRoute = Object.freeze({ kind: 'direct' });
const DIRECT_ONLY: readonly ProxyRoute[] = Object.freeze([DIRECT_ROUTE]);
const DEFAULT_CACHE_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 256;
const SYSTEM_RESOLVE_TIMEOUT_MS = 5_000;
const DEFAULT_PORTS: Readonly<Record<ProxyKind, number>> = Object.freeze({ http: 80, https: 443, socks4: 1080, socks5: 1080 });

/** Asks the operating system (Electron's `session.resolveProxy`) for a PAC-style answer. */
export type ResolveSystemProxy = (url: string) => Promise<string>;

/**
 * Parses a PAC-style list as returned by `session.resolveProxy`, such as
 * "PROXY 127.0.0.1:7890; DIRECT". Keeps the order; unusable entries are skipped. Following
 * Chromium, "SOCKS" means SOCKS v4 and "SOCKS5" SOCKS v5.
 */
export function parseProxyRules(value: string): readonly ProxyRoute[] {
  const routes: ProxyRoute[] = [];
  for (const entry of String(value ?? '').split(';')) {
    const match = /^\s*([A-Za-z0-9]+)(?:\s+(\S+))?\s*$/.exec(entry);
    if (!match) continue;
    const keyword = match[1]!.toUpperCase();
    if (keyword === 'DIRECT') { routes.push(DIRECT_ROUTE); continue; }
    const kind: ProxyKind | undefined = keyword === 'PROXY' || keyword === 'HTTP' ? 'http'
      : keyword === 'HTTPS' ? 'https'
        : keyword === 'SOCKS5' ? 'socks5'
          : keyword === 'SOCKS' || keyword === 'SOCKS4' ? 'socks4'
            : undefined;
    if (!kind || !match[2]) continue;
    const address = splitHostPort(match[2]);
    if (address && address.port !== 0) routes.push(Object.freeze({ kind, host: address.host, port: address.port ?? DEFAULT_PORTS[kind] }));
  }
  return routes.length ? Object.freeze(routes) : DIRECT_ONLY;
}

/**
 * The proxy that HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (either case) name for a target, honouring
 * NO_PROXY, as axios applied them before. Credentials in the variable are not sent.
 */
export function environmentProxyRoute(target: URL, environment: Readonly<Record<string, string | undefined>>): ProxyRoute | undefined {
  const read = (name: string) => (environment[name] ?? environment[name.toUpperCase()])?.trim() || undefined;
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  if (bypassedByNoProxy(target.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port, read('no_proxy'))) return undefined;
  const value = read(`${target.protocol.replace(':', '')}_proxy`) ?? read('all_proxy');
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`); } catch { return undefined; }
  const kind = PROXY_URL_SCHEMES[url.protocol.slice(0, -1).toLowerCase()];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!kind || !host) return undefined;
  return Object.freeze({ kind, host, port: Number(url.port) || DEFAULT_PORTS[kind] });
}

/** NO_PROXY as curl reads it: "*", or names that also cover their subdomains (".x" and "*.x" too), optional ":port". */
function bypassedByNoProxy(hostname: string, port: number, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy === '*') return true;
  return noProxy.toLowerCase().split(/[,\s]+/).some(entry => {
    const withPort = /^(.+):(\d+)$/.exec(entry);
    const name = (withPort ? withPort[1]! : entry).replace(/^\*?\./, '');
    if (!name || (withPort && Number(withPort[2]) !== port)) return false;
    return hostname === name || hostname.endsWith(`.${name}`);
  });
}

/** "127.0.0.1:7890", or with a scheme for the less common kinds; null for a direct connection. */
export function describeRoute(route: ProxyRoute): string | null {
  if (route.kind === 'direct') return null;
  const address = `${formatHost(route.host)}:${route.port}`;
  return route.kind === 'http' ? address : `${route.kind}://${address}`;
}

/** Chromium never sends loopback traffic to a proxy; neither do we. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || /^::ffff:127\./.test(host);
  return false;
}

export function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export interface ProxyResolverOptions {
  readonly getSettings: () => NetworkSettings;
  /** Required for system mode; without it system mode connects directly. */
  readonly resolveSystemProxy?: ResolveSystemProxy;
  /** Proxy variables used in system mode when the operating system names no proxy; process.env by default. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Decides, per target, how a main-process request leaves the computer. System mode asks the
 * operating system (including PAC scripts) for every origin and keeps the answer briefly; when
 * it says DIRECT, HTTPS_PROXY-style variables still apply, as they did before system mode
 * consulted the operating system.
 */
export class ProxyResolver {
  readonly #options: ProxyResolverOptions;
  readonly #cache = new Map<string, { readonly expiresAt: number; readonly routes: Promise<readonly ProxyRoute[]> }>();
  #generation = 0;

  constructor(options: ProxyResolverOptions) {
    this.#options = options;
  }

  /** Changes whenever settings change, so pooled connections of the old route are not reused. */
  get generation(): number {
    return this.#generation;
  }

  clear(): void {
    this.#cache.clear();
    this.#generation += 1;
  }

  resolve(target: string | URL): Promise<readonly ProxyRoute[]> {
    let url: URL;
    try { url = typeof target === 'string' ? new URL(target) : target; }
    catch { return Promise.resolve(DIRECT_ONLY); }
    if (isLoopbackHost(url.hostname)) return Promise.resolve(DIRECT_ONLY);
    const { proxy } = this.#options.getSettings();
    if (proxy.mode === 'none') return Promise.resolve(DIRECT_ONLY);
    if (proxy.mode === 'custom') {
      const route = parseCustomProxy(proxy.host, proxy.port);
      return Promise.resolve(route ? Object.freeze([route]) : DIRECT_ONLY);
    }
    const resolveSystemProxy = this.#options.resolveSystemProxy;
    const fromEnvironment = (routes: readonly ProxyRoute[]) => {
      if (routes.some(route => route.kind !== 'direct')) return routes;
      const route = environmentProxyRoute(url, this.#options.environment ?? process.env);
      return route ? Object.freeze([route]) : routes;
    };
    if (!resolveSystemProxy) return Promise.resolve(fromEnvironment(DIRECT_ONLY));
    const key = `${url.protocol}//${url.host}`;
    const now = (this.#options.now ?? Date.now)();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > now) return cached.routes;
    if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.clear();
    // A slow PAC download or WPAD lookup must not hold requests; Chromium also falls back to DIRECT.
    const routes = withTimeout(resolveSystemProxy(`${url.protocol}//${url.host}/`), SYSTEM_RESOLVE_TIMEOUT_MS)
      .then(parseProxyRules, () => DIRECT_ONLY)
      .then(fromEnvironment);
    this.#cache.set(key, { expiresAt: now + (this.#options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS), routes });
    return routes;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
