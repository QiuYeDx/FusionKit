import type { AxiosRequestConfig } from 'axios';
import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from '../../../src/network/contract';
import { closeIdleSockets, ProxyAwareHttpAgent, ProxyAwareHttpsAgent } from './agent';
import { ProxyResolver, type ResolveSystemProxy } from './proxy-resolver';

/**
 * The process-wide network state that every main-process request shares. It starts as "direct"
 * (as before the settings are known) and the composition installs the saved settings and the
 * operating system's proxy lookup at startup, before the first request.
 */
const DIRECT_SETTINGS: NetworkSettings = Object.freeze({
  ...DEFAULT_NETWORK_SETTINGS,
  proxy: Object.freeze({ mode: 'none', host: '', port: '' }),
});

let getSettings: () => NetworkSettings = () => DIRECT_SETTINGS;
let resolveSystemProxy: ResolveSystemProxy | undefined;

const resolver = new ProxyResolver({
  getSettings: () => getSettings(),
  resolveSystemProxy: url => resolveSystemProxy ? resolveSystemProxy(url) : Promise.resolve('DIRECT'),
});
const httpAgent = new ProxyAwareHttpAgent({ routes: resolver });
const httpsAgent = new ProxyAwareHttpsAgent({ routes: resolver });

export interface NetworkRuntimeConfiguration {
  readonly getSettings: () => NetworkSettings;
  readonly resolveSystemProxy?: ResolveSystemProxy;
}

export function configureNetworkRuntime(configuration: NetworkRuntimeConfiguration): void {
  getSettings = configuration.getSettings;
  resolveSystemProxy = configuration.resolveSystemProxy;
  networkRouteChanged();
}

/** Proxy settings changed: forget proxy answers and idle connections made the old way. */
export function networkRouteChanged(): void {
  resolver.clear();
  closeIdleSockets(httpAgent);
  closeIdleSockets(httpsAgent);
}

export function currentNetworkSettings(): NetworkSettings {
  return getSettings();
}

/**
 * Axios options for a main-process request: axios's own proxy handling (which only reads
 * environment variables) is off and the agents connect the way the settings say.
 */
export function getAxiosProxyConfig(): Pick<AxiosRequestConfig, 'proxy' | 'httpAgent' | 'httpsAgent'> {
  return { proxy: false, httpAgent, httpsAgent };
}

export function getNetworkAgents(): { readonly http: ProxyAwareHttpAgent; readonly https: ProxyAwareHttpsAgent } {
  return { http: httpAgent, https: httpsAgent };
}

export function getProxyResolver(): ProxyResolver {
  return resolver;
}

