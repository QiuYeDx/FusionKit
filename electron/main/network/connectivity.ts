import http from 'node:http';
import https from 'node:https';
import { normalizeModelEndpoint } from '../../../src/lib/model-endpoint';
import {
  NETWORK_TEST_MAX_ENDPOINTS,
  networkTestRequestSchema,
  type NetworkSettings,
  type NetworkTestResult,
  type NetworkTestTarget,
  type NetworkTestTargetKind,
} from '../../../src/network/contract';
import { matchDownloadSources } from './download-sources';
import { classifyNetworkError } from './errors';
import { describeRoute, type ProxyRoute } from './proxy-resolver';

const TEST_TIMEOUT_MS = 8_000;
/** Updates and their downloads come from GitHub. */
const GITHUB_TEST_URL = 'https://github.com/';

export interface ReachabilityAnswer {
  readonly status: number;
}

/** One GET that stops at the response headers; any HTTP answer means the server is reachable. */
export type ReachabilityProbe = (url: URL, signal: AbortSignal) => Promise<ReachabilityAnswer>;

export function createReachabilityProbe(agents: { readonly http: http.Agent; readonly https: https.Agent }): ReachabilityProbe {
  return (url, signal) => new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request(url, {
      method: 'GET',
      agent: url.protocol === 'http:' ? agents.http : agents.https,
      signal,
      headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'FusionKit-network-test/1', range: 'bytes=0-0' },
    }, response => {
      resolve({ status: response.statusCode ?? 0 });
      response.destroy();
      request.destroy();
    });
    request.on('error', reject);
    request.end();
  });
}

export interface NetworkTestDependencies {
  readonly settings: NetworkSettings;
  readonly probe: ReachabilityProbe;
  readonly resolveRoutes: (url: string) => Promise<readonly ProxyRoute[]>;
  /** The recommended speech model's official address, used to test the download source. */
  readonly modelDownloadUrl: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface PlannedTarget {
  readonly kind: NetworkTestTargetKind;
  readonly url: URL;
  readonly source?: 'official' | 'mirror';
}

/**
 * Tests what the app really uses, through the configured proxy: the model services the user
 * configured (addresses only, never keys), the speech model download source(s) for the current
 * setting, and GitHub for updates. All targets run concurrently.
 */
export async function testNetworkTargets(input: unknown, dependencies: NetworkTestDependencies): Promise<NetworkTestResult> {
  const request = networkTestRequestSchema.parse(input ?? {});
  const targets: PlannedTarget[] = [];
  const seen = new Set<string>();
  for (const endpoint of request.modelEndpoints) {
    const url = modelsUrlOf(endpoint);
    if (!url || seen.has(url.href) || seen.size >= NETWORK_TEST_MAX_ENDPOINTS) continue;
    seen.add(url.href);
    targets.push({ kind: 'model_api', url });
  }
  const sources = matchDownloadSources(dependencies.modelDownloadUrl);
  const official = sources?.candidates[0];
  const mirror = sources?.candidates.find(candidate => candidate.domestic);
  const mode = dependencies.settings.downloadSource;
  if (official && mode !== 'mirror') targets.push({ kind: 'model_download', url: new URL(official.url), source: 'official' });
  if (mirror && mode !== 'official') targets.push({ kind: 'model_download', url: new URL(mirror.url), source: 'mirror' });
  targets.push({ kind: 'github', url: new URL(GITHUB_TEST_URL) });

  const results = await Promise.all(targets.map(target => testOne(target, dependencies)));
  return Object.freeze({
    proxyMode: dependencies.settings.proxy.mode,
    downloadSource: mode,
    targets: Object.freeze(results),
  });
}

async function testOne(target: PlannedTarget, dependencies: NetworkTestDependencies): Promise<NetworkTestTarget> {
  const now = dependencies.now ?? (() => performance.now());
  const routes = await dependencies.resolveRoutes(target.url.href).catch(() => [] as readonly ProxyRoute[]);
  const via = routes[0] ? describeRoute(routes[0]) : null;
  const base = { kind: target.kind, host: target.url.host, ...(target.source ? { source: target.source } : {}), via };
  const started = now();
  try {
    const answer = await dependencies.probe(target.url, AbortSignal.timeout(dependencies.timeoutMs ?? TEST_TIMEOUT_MS));
    return Object.freeze({ ...base, ok: true, latencyMs: Math.max(0, Math.round(now() - started)), status: answer.status });
  } catch (error) {
    const category = classifyNetworkError(error);
    return Object.freeze({
      ...base,
      ok: false,
      latencyMs: Math.max(0, Math.round(now() - started)),
      // The test's own deadline is a timeout to the user, not a cancellation.
      category: category === 'aborted' ? 'timeout' : category,
    });
  }
}

/** The model service's list endpoint, without credentials; a non-http(s) address is skipped. */
function modelsUrlOf(endpoint: string): URL | undefined {
  const { modelsUrl } = normalizeModelEndpoint(endpoint);
  if (!modelsUrl) return undefined;
  try {
    const url = new URL(modelsUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
    url.hash = '';
    url.search = '';
    return url;
  } catch {
    return undefined;
  }
}
