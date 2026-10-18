import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type tls from 'node:tls';
import { formatHost, type ProxyRoute } from './proxy-resolver';
import { openProxySocket, openTunnel, type TunnelTarget } from './tunnel';

/** Where the agents learn, per target, how to connect. */
export interface ProxyRouteSource {
  resolve(url: string): Promise<readonly ProxyRoute[]>;
  /** Bumped when settings change; part of the pool key so old connections are not reused. */
  readonly generation: number;
}

export interface ProxyAwareAgentOptions {
  readonly routes: ProxyRouteSource;
  readonly tunnelTimeoutMs?: number;
  readonly proxyTls?: tls.ConnectionOptions;
}

// Node's own global agents use these, so requests behave as before when no proxy applies.
const POOL_DEFAULTS = { keepAlive: true, scheduling: 'lifo', timeout: 5_000 } as const;
type ConnectCallback = (error: Error | null, stream: Duplex) => void;
type ProxyServerRoute = Exclude<ProxyRoute, { kind: 'direct' }>;
type ConnectionOptions = http.ClientRequestArgs & { readonly _agentKey?: unknown };
/** A connection the agent made: through a proxy (`socket`), or directly when undefined. */
type RoutedConnection = { readonly socket: net.Socket; readonly singleUse: boolean } | undefined;

const ROUTE_GENERATION = Symbol('fusionkit.network.routeGeneration');
const SINGLE_USE = Symbol('fusionkit.network.singleUse');
interface TaggedStream { [ROUTE_GENERATION]?: number; [SINGLE_USE]?: boolean }

/**
 * An https.Agent that connects each request the way its route says: directly (exactly like
 * Node's agent, including a custom `lookup`), or through an HTTP CONNECT / SOCKS tunnel, falling
 * back to the next route of a PAC list when a proxy cannot be reached.
 *
 * A custom `lookup` is not used for a tunnel: the proxy resolves the name, and the TLS
 * certificate, checked against the name, still decides whether the server is the right one.
 */
export class ProxyAwareHttpsAgent extends https.Agent {
  readonly #options: ProxyAwareAgentOptions;

  constructor(options: ProxyAwareAgentOptions, agentOptions: https.AgentOptions = {}) {
    super({ ...POOL_DEFAULTS, ...agentOptions });
    this.#options = options;
  }

  override getName(options?: https.RequestOptions): string {
    return poolName(options, () => super.getName(options), this.#options.routes.generation);
  }

  override keepSocketAlive(socket: Duplex): boolean {
    return reusable(socket, this.#options.routes.generation) && keepAliveByNode(() => super.keepSocketAlive(socket));
  }

  override createConnection(options: http.ClientRequestArgs, callback?: ConnectCallback): Duplex | null | undefined {
    const target = targetOf(options, 443);
    const generation = this.#options.routes.generation;
    connectThroughRoutes(this.#options, `https://${formatHost(target.host)}:${target.port}/`, async route => (
      { socket: await openTunnel(route, target, tunnelOptions(this.#options)), singleUse: false }
    )).then(connection => {
      // https.Agent's own createConnection wraps the stream in TLS and reuses TLS sessions.
      const base = https.Agent.prototype.createConnection as (this: https.Agent, options: object) => Duplex;
      return tag(base.call(this, connection ? { ...options, socket: connection.socket } : options), generation, false);
    }).then(stream => callback?.(null, stream), error => callback?.(error as Error, undefined as never));
    return undefined;
  }
}

/**
 * The plain-http counterpart. Through an HTTP proxy a request is sent in absolute form
 * ("GET http://host/path"), as browsers do, so proxies that refuse CONNECT to port 80 still work;
 * through SOCKS it is tunnelled. A caller's custom `lookup` (web lookup only allows public
 * addresses) keeps its say through a proxy: the tunnel goes to the address it approved, because
 * plain http has no certificate that would catch a name the proxy resolves differently.
 */
export class ProxyAwareHttpAgent extends http.Agent {
  readonly #options: ProxyAwareAgentOptions;

  constructor(options: ProxyAwareAgentOptions, agentOptions: http.AgentOptions = {}) {
    super({ ...POOL_DEFAULTS, ...agentOptions });
    this.#options = options;
  }

  override getName(options?: http.ClientRequestArgs): string {
    return poolName(options, () => super.getName(options), this.#options.routes.generation);
  }

  override keepSocketAlive(socket: Duplex): boolean {
    return reusable(socket, this.#options.routes.generation) && keepAliveByNode(() => super.keepSocketAlive(socket));
  }

  override createConnection(options: http.ClientRequestArgs, callback?: ConnectCallback): Duplex | null | undefined {
    const target = targetOf(options, 80);
    const generation = this.#options.routes.generation;
    const lookup = options.lookup;
    let pinned: Promise<string> | undefined;
    connectThroughRoutes(this.#options, `http://${formatHost(target.host)}:${target.port}/`, async route => {
      if (lookup) {
        pinned ??= lookupAddress(lookup, target.host);
        return { socket: await openTunnel(route, { host: await pinned, port: target.port }, tunnelOptions(this.#options)), singleUse: false };
      }
      if (route.kind === 'http' || route.kind === 'https') {
        const socket = await openProxySocket({ ...route, kind: route.kind }, tunnelOptions(this.#options));
        return { socket: absoluteFormRequest(socket, `http://${formatHost(target.host)}:${target.port}`), singleUse: true };
      }
      return { socket: await openTunnel(route, target, tunnelOptions(this.#options)), singleUse: false };
    }).then(connection => {
      if (connection) return tag(connection.socket, generation, connection.singleUse);
      const base = http.Agent.prototype.createConnection as (this: http.Agent, options: object) => Duplex;
      return tag(base.call(this, options), generation, false);
    }).then(stream => callback?.(null, stream), error => callback?.(error as Error, undefined as never));
    return undefined;
  }
}

/** Closes idle pooled connections, for example after the proxy settings changed. */
export function closeIdleSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy();
  }
}

/**
 * The pool a connection belongs to, including the route generation it was made under. Node asks
 * again when a socket is freed or removed, passing the options the socket was created with
 * (`_agentKey` holds the name chosen then), so a socket never moves into a newer pool.
 */
function poolName(options: ConnectionOptions | undefined, base: () => string, generation: number): string {
  return typeof options?._agentKey === 'string' ? options._agentKey : `${base()}:route${generation}`;
}

/** Connections from before a settings change, and absolute-form proxy connections, are not reused. */
function reusable(socket: Duplex, generation: number): boolean {
  const tagged = socket as Duplex & TaggedStream;
  return !tagged[SINGLE_USE] && (tagged[ROUTE_GENERATION] ?? generation) === generation;
}

function keepAliveByNode(keep: () => unknown): boolean {
  // @types/node declares keepSocketAlive as void; Node returns whether to keep the socket.
  return keep() !== false;
}

function tag<T extends Duplex>(stream: T, generation: number, singleUse: boolean): T {
  const tagged = stream as T & TaggedStream;
  tagged[ROUTE_GENERATION] = generation;
  if (singleUse) tagged[SINGLE_USE] = true;
  return stream;
}

/**
 * Rewrites the request line of the first request on a connection to an HTTP proxy into absolute
 * form. Node writes the request head as the first chunk; the connection is single-use, so no later
 * request (still in origin form) is ever written to it.
 */
function absoluteFormRequest(socket: net.Socket, origin: string): net.Socket {
  const write = socket.write;
  socket.write = function (this: net.Socket, chunk: unknown, ...rest: unknown[]) {
    socket.write = write;
    return (write as (...args: unknown[]) => boolean).call(this, toAbsoluteForm(chunk, origin), ...rest);
  } as typeof socket.write;
  return socket;
}

function toAbsoluteForm(chunk: unknown, origin: string): unknown {
  const rewrite = (line: string) => line.replace(/^([A-Z]+) (\/\S*) (HTTP\/1\.[01])$/, `$1 ${origin}$2 $3`);
  if (typeof chunk === 'string') {
    const end = chunk.indexOf('\r\n');
    return end < 0 ? chunk : rewrite(chunk.slice(0, end)) + chunk.slice(end);
  }
  if (Buffer.isBuffer(chunk)) {
    const end = chunk.indexOf('\r\n');
    return end < 0 ? chunk : Buffer.concat([Buffer.from(rewrite(chunk.subarray(0, end).toString('latin1')), 'latin1'), chunk.subarray(end)]);
  }
  return chunk;
}

/** The address a caller's `lookup` approves for a host, IPv4 first (SOCKS4 has no IPv6). */
function lookupAddress(lookup: NonNullable<http.ClientRequestArgs['lookup']>, host: string): Promise<string> {
  if (net.isIP(host)) return Promise.resolve(host);
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (error, addresses) => {
      if (error) { reject(error); return; }
      const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: net.isIP(String(addresses)) }];
      const chosen = list.find(item => item.family === 4) ?? list[0];
      if (chosen?.address) resolve(chosen.address);
      else reject(Object.assign(new Error(`No address for ${host}.`), { code: 'ENOTFOUND' }));
    });
  });
}

function tunnelOptions(options: ProxyAwareAgentOptions) {
  return { timeoutMs: options.tunnelTimeoutMs, proxyTls: options.proxyTls };
}

/** Resolves to a proxy connection, or undefined when the route says to connect directly. */
async function connectThroughRoutes(
  options: ProxyAwareAgentOptions,
  url: string,
  open: (route: ProxyServerRoute) => Promise<RoutedConnection>,
): Promise<RoutedConnection> {
  const routes = await options.routes.resolve(url);
  let lastError: unknown;
  for (const route of routes) {
    if (route.kind === 'direct') return undefined;
    try {
      return await open(route);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No usable network route.');
}

function targetOf(options: http.ClientRequestArgs, defaultPort: number): TunnelTarget {
  const host = String(options.host ?? options.hostname ?? 'localhost').replace(/^\[|\]$/g, '');
  const port = Number(options.port) || defaultPort;
  return { host, port };
}
