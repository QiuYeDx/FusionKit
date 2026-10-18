import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { LOCALHOST_TEST_CERT, LOCALHOST_TEST_KEY } from './localhost-test-cert';

/** Local stand-ins for proxies and servers; every test closes what it started. */
export interface Started {
  readonly port: number;
  close(): Promise<void>;
}

const open = new Set<Started>();
export async function closeAllServers(): Promise<void> {
  await Promise.all([...open].map(server => server.close()));
  open.clear();
}

function track(server: net.Server, extra: Record<string, unknown> = {}): Promise<Started & Record<string, unknown>> {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const started = {
      ...extra,
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>(done => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
        open.delete(started);
      }),
    };
    open.add(started);
    resolve(started);
  }));
}

export async function startHttpServer(handler: http.RequestListener): Promise<Started> {
  return track(http.createServer(handler));
}

export async function startHttpsServer(handler: http.RequestListener): Promise<Started> {
  return track(https.createServer({ cert: LOCALHOST_TEST_CERT, key: LOCALHOST_TEST_KEY }, handler));
}

export interface ConnectProxy extends Started {
  /** "host:port" of every CONNECT request, in order. */
  readonly connects: string[];
  /** The absolute-form target of every plain request it forwarded ("http://host:port/path"). */
  readonly forwards: string[];
}

/**
 * An HTTP proxy like Clash's mixed port: it tunnels CONNECT requests (refused with `status` when
 * set, like a proxy that only allows port 443) and forwards absolute-form plain-http requests.
 */
export async function startConnectProxy(options: { status?: number; redirectTo?: number } = {}): Promise<ConnectProxy> {
  const connects: string[] = [];
  const forwards: string[] = [];
  const server = http.createServer((request, response) => {
    if (!/^http:\/\//.test(request.url ?? '')) { response.statusCode = 400; response.end(); return; }
    forwards.push(request.url!);
    const target = new URL(request.url!);
    const upstream = http.request({
      host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname, port: Number(target.port) || 80,
      method: request.method, path: `${target.pathname}${target.search}`, headers: request.headers,
    }, answer => { response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response); });
    upstream.on('error', () => { response.statusCode = 502; response.end(); });
    request.pipe(upstream);
  });
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    connects.push(request.url ?? '');
    if (options.status && options.status !== 200) {
      client.end(`HTTP/1.1 ${options.status} Refused\r\n\r\n`);
      return;
    }
    const [host, port] = splitAuthority(request.url ?? '');
    const upstream = net.connect(options.redirectTo ?? port, options.redirectTo || host === 'localhost' ? '127.0.0.1' : host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return track(server, { connects, forwards }) as Promise<ConnectProxy>;
}

export interface SocksProxy extends Started {
  readonly targets: string[];
}

/** A SOCKS5 server without authentication, or one that demands it when `requireAuth` is set. */
export async function startSocks5Proxy(options: { requireAuth?: boolean; reply?: number } = {}): Promise<SocksProxy> {
  const targets: string[] = [];
  const server = net.createServer(client => {
    client.once('data', greeting => {
      if (greeting[0] !== 0x05) { client.destroy(); return; }
      if (options.requireAuth) { client.end(Buffer.from([0x05, 0xff])); return; }
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', request => {
        const type = request[3];
        let host: string; let offset: number;
        if (type === 0x01) { host = [...request.subarray(4, 8)].join('.'); offset = 8; }
        else if (type === 0x03) { const length = request[4]!; host = request.subarray(5, 5 + length).toString('ascii'); offset = 5 + length; }
        else { client.destroy(); return; }
        const port = request.readUInt16BE(offset);
        targets.push(`${host}:${port}`);
        if (options.reply) { client.end(Buffer.from([0x05, options.reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return; }
        const upstream = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
    });
  });
  return track(server, { targets }) as Promise<SocksProxy>;
}

/** A SOCKS4a server (what a PAC "SOCKS host:port" entry means). */
export async function startSocks4Proxy(): Promise<SocksProxy> {
  const targets: string[] = [];
  const server = net.createServer(client => {
    client.once('data', request => {
      if (request[0] !== 0x04 || request[1] !== 0x01) { client.destroy(); return; }
      const port = request.readUInt16BE(2);
      const ip = [...request.subarray(4, 8)];
      const userEnd = request.indexOf(0, 8);
      const host = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0
        ? request.subarray(userEnd + 1, request.indexOf(0, userEnd + 1)).toString('ascii')
        : ip.join('.');
      targets.push(`${host}:${port}`);
      const upstream = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
        client.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  });
  return track(server, { targets }) as Promise<SocksProxy>;
}

/** A port that nothing listens on (bound, then released). */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function splitAuthority(authority: string): [string, number] {
  const index = authority.lastIndexOf(':');
  return [authority.slice(0, index).replace(/^\[|\]$/g, ''), Number(authority.slice(index + 1))];
}
