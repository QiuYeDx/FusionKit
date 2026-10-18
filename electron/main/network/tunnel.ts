import net from 'node:net';
import tls from 'node:tls';
import { describeRoute, formatHost, type ProxyRoute } from './proxy-resolver';

export const DEFAULT_TUNNEL_TIMEOUT_MS = 20_000;
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;

type ProxyServerRoute = Exclude<ProxyRoute, { kind: 'direct' }>;

/**
 * A connection that failed at or through the proxy server. `code` keeps the socket error
 * (ECONNREFUSED when nothing listens on the proxy port) or names the proxy's refusal:
 * ERR_PROXY_CONNECT (CONNECT answered with a non-2xx status), ERR_PROXY_AUTH_REQUIRED (407 or a
 * SOCKS server that wants a password), ERR_SOCKS_REPLY (the SOCKS server could not connect).
 */
export class ProxyConnectionError extends Error {
  override readonly name = 'ProxyConnectionError';

  constructor(
    message: string,
    readonly code: string,
    /** As shown to the user, such as "127.0.0.1:7890". */
    readonly proxy: string,
    readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface TunnelTarget {
  readonly host: string;
  readonly port: number;
}

export interface TunnelOptions {
  readonly timeoutMs?: number;
  /** TLS options for an HTTPS proxy server itself (tests pass their own CA). */
  readonly proxyTls?: tls.ConnectionOptions;
}

/**
 * Opens a raw TCP stream to `target` through one proxy server: HTTP CONNECT (also over TLS for
 * an HTTPS proxy), SOCKS5 without authentication or SOCKS4a. The caller layers TLS on top for
 * https targets. Every failure destroys the socket and rejects with a ProxyConnectionError.
 */
export function openTunnel(route: ProxyServerRoute, target: TunnelTarget, options: TunnelOptions = {}): Promise<net.Socket> {
  return connectToProxy(route, options, (socket, reader, label) => route.kind === 'socks5' ? socks5Handshake(socket, reader, target, label)
    : route.kind === 'socks4' ? socks4Handshake(socket, reader, target, label)
      : connectHandshake(socket, reader, target, label));
}

/**
 * A plain connection to an HTTP or HTTPS proxy, for requests written in absolute form
 * ("GET http://host/path"), which is how browsers send plain-http requests through a proxy and
 * what proxies that only allow CONNECT to port 443 accept.
 */
export function openProxySocket(route: ProxyServerRoute & { readonly kind: 'http' | 'https' }, options: TunnelOptions = {}): Promise<net.Socket> {
  return connectToProxy(route, options, async () => undefined);
}

function connectToProxy(
  route: ProxyServerRoute,
  options: TunnelOptions,
  handshake: (socket: net.Socket, reader: SocketReader, label: string) => Promise<void>,
): Promise<net.Socket> {
  const label = describeRoute(route) ?? `${route.host}:${route.port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket: net.Socket = route.kind === 'https'
      ? tls.connect({ host: route.host, port: route.port, ...(net.isIP(route.host) ? {} : { servername: route.host }), ...options.proxyTls })
      : net.connect({ host: route.host, port: route.port });
    const reader = createSocketReader(socket);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.abort(error);
      socket.destroy();
      reject(toProxyConnectionError(error, label));
    };
    const timer = setTimeout(
      () => fail(Object.assign(new Error('The proxy connection timed out.'), { code: 'ETIMEDOUT' })),
      options.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
    );
    const closed = () => fail(Object.assign(new Error('The proxy closed the connection.'), { code: 'ECONNRESET' }));
    // `on`, not `once`: a second error during teardown must not go unhandled.
    socket.on('error', fail);
    socket.once('close', closed);
    socket.once(route.kind === 'https' ? 'secureConnect' : 'connect', () => {
      handshake(socket, reader, label).then(() => {
        if (settled) return;
        if (reader.pending() > 0) {
          fail(new ProxyConnectionError('The proxy sent data before the tunnel was used.', 'ERR_PROXY_CONNECT', label));
          return;
        }
        settled = true;
        clearTimeout(timer);
        reader.release();
        socket.removeListener('error', fail);
        socket.removeListener('close', closed);
        // Until the TLS layer or HTTP client attaches its own handler, a late error must not crash.
        socket.on('error', ignoreLateError);
        resolve(socket);
      }, fail);
    });
  });
}

async function connectHandshake(socket: net.Socket, reader: SocketReader, target: TunnelTarget, label: string): Promise<void> {
  const authority = `${formatHost(target.host)}:${target.port}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  const head = await reader.read(buffer => {
    const end = buffer.indexOf('\r\n\r\n');
    if (end >= 0) return end + 4;
    if (buffer.length > MAX_CONNECT_RESPONSE_BYTES) throw new ProxyConnectionError('The proxy answer was too long.', 'ERR_PROXY_CONNECT', label);
    return undefined;
  });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
  const statusCode = status ? Number(status[1]) : 0;
  if (statusCode >= 200 && statusCode < 300) return;
  if (statusCode === 407) {
    throw new ProxyConnectionError('The proxy requires a user name and password.', 'ERR_PROXY_AUTH_REQUIRED', label, 407);
  }
  throw new ProxyConnectionError(`The proxy refused the tunnel (HTTP ${statusCode || 'invalid'}).`, 'ERR_PROXY_CONNECT', label, statusCode || undefined);
}

async function socks5Handshake(socket: net.Socket, reader: SocketReader, target: TunnelTarget, label: string): Promise<void> {
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await reader.read(buffer => (buffer.length >= 2 ? 2 : undefined));
  if (greeting[0] !== 0x05) throw new ProxyConnectionError('The proxy is not a SOCKS5 server.', 'ERR_PROXY_CONNECT', label);
  if (greeting[1] !== 0x00) {
    throw new ProxyConnectionError('The SOCKS5 proxy requires a user name and password.', 'ERR_PROXY_AUTH_REQUIRED', label);
  }
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socks5Address(target.host), port(target.port)]));
  const reply = await reader.read(buffer => {
    if (buffer.length < 5) return undefined;
    const length = buffer[3] === 0x01 ? 10 : buffer[3] === 0x04 ? 22 : buffer[3] === 0x03 ? 7 + buffer[4]! : -1;
    if (length < 0) throw new ProxyConnectionError('The SOCKS5 proxy sent an invalid reply.', 'ERR_PROXY_CONNECT', label);
    return buffer.length >= length ? length : undefined;
  });
  if (reply[0] !== 0x05) throw new ProxyConnectionError('The SOCKS5 proxy sent an invalid reply.', 'ERR_PROXY_CONNECT', label);
  if (reply[1] !== 0x00) {
    throw new ProxyConnectionError(`The SOCKS5 proxy could not connect (reply ${reply[1]}).`, 'ERR_SOCKS_REPLY', label, reply[1]);
  }
}

async function socks4Handshake(socket: net.Socket, reader: SocketReader, target: TunnelTarget, label: string): Promise<void> {
  const ipv4 = net.isIP(target.host) === 4;
  if (net.isIP(target.host) === 6) throw new ProxyConnectionError('SOCKS4 cannot reach IPv6 addresses.', 'ERR_PROXY_CONNECT', label);
  // SOCKS4a: the address 0.0.0.1 asks the proxy to resolve the host name that follows.
  const address = ipv4 ? Buffer.from(target.host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]);
  socket.write(Buffer.concat([
    Buffer.from([0x04, 0x01]), port(target.port), address, Buffer.from([0x00]),
    ...(ipv4 ? [] : [Buffer.from(target.host, 'ascii'), Buffer.from([0x00])]),
  ]));
  const reply = await reader.read(buffer => (buffer.length >= 8 ? 8 : undefined));
  if (reply[0] !== 0x00) throw new ProxyConnectionError('The proxy is not a SOCKS4 server.', 'ERR_PROXY_CONNECT', label);
  if (reply[1] !== 0x5a) {
    throw new ProxyConnectionError(`The SOCKS4 proxy could not connect (reply ${reply[1]}).`, 'ERR_SOCKS_REPLY', label, reply[1]);
  }
}

function ignoreLateError(): void {}

function socks5Address(host: string): Buffer {
  if (net.isIP(host) === 4) return Buffer.from([0x01, ...host.split('.').map(Number)]);
  if (net.isIP(host) === 6) return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
  const name = Buffer.from(host, 'ascii');
  if (name.length > 255) throw new TypeError('The host name is too long for SOCKS5.');
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function ipv6Bytes(address: string): Buffer {
  const [head = '', tail = ''] = address.includes('::') ? address.split('::') : [address, ''];
  const parts = (value: string) => value ? value.split(':') : [];
  const groups = [...parts(head), ...parts(tail)];
  const missing = 8 - groups.length;
  const full = address.includes('::') ? [...parts(head), ...Array(missing).fill('0'), ...parts(tail)] : groups;
  const bytes = Buffer.alloc(16);
  full.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2));
  return bytes;
}

function port(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function toProxyConnectionError(error: unknown, label: string): ProxyConnectionError {
  if (error instanceof ProxyConnectionError) return error;
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'ERR_PROXY_CONNECT';
  const message = error instanceof Error ? error.message : String(error);
  return new ProxyConnectionError(`Could not connect through the proxy ${label}: ${message}`, code, label, undefined, { cause: error });
}

interface SocketReader {
  /** Waits until `complete` reports a full message length, then consumes and returns it. */
  read(complete: (buffer: Buffer) => number | undefined): Promise<Buffer>;
  pending(): number;
  release(): void;
  abort(error: unknown): void;
}

/** Reads the handshake in paused mode, so the stream flows normally once it is released. */
function createSocketReader(socket: net.Socket): SocketReader {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let failure: unknown;
  const onReadable = () => {
    let chunk: Buffer | null;
    while ((chunk = socket.read() as Buffer | null) !== null) buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  };
  socket.on('readable', onReadable);
  return {
    async read(complete) {
      while (true) {
        if (failure !== undefined) throw failure;
        const length = complete(buffer);
        if (length !== undefined) {
          const message = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          return message;
        }
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    },
    pending: () => buffer.length,
    release() {
      socket.removeListener('readable', onReadable);
    },
    abort(error) {
      failure = error ?? new Error('aborted');
      socket.removeListener('readable', onReadable);
      wake?.();
    },
  };
}
