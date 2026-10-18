import https from 'node:https';
import net from 'node:net';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeIdleSockets, ProxyAwareHttpAgent, ProxyAwareHttpsAgent, type ProxyRouteSource } from '../../electron/main/network/agent';
import { classifyNetworkError } from '../../electron/main/network/errors';
import type { ProxyRoute } from '../../electron/main/network/proxy-resolver';
import { openTunnel, ProxyConnectionError } from '../../electron/main/network/tunnel';
import { LOCALHOST_TEST_CERT } from './localhost-test-cert';
import {
  closeAllServers, closedPort, startConnectProxy, startHttpServer, startHttpsServer, startSocks4Proxy, startSocks5Proxy,
} from './local-servers';

afterEach(closeAllServers);

/** Routes every target the same way, so loopback test servers can sit behind a proxy. */
function routes(list: readonly ProxyRoute[]): ProxyRouteSource & { generation: number; asked: string[] } {
  const source = { generation: 0, asked: [] as string[], resolve: async (url: string) => { source.asked.push(url); return list; } };
  return source;
}
const http = (port: number): ProxyRoute => ({ kind: 'http', host: '127.0.0.1', port });

async function secureServer(body = 'secure hello') {
  return startHttpsServer((request, response) => response.end(`${body} ${request.url}`));
}

describe('HTTP CONNECT tunnel', () => {
  it('carries an https request through the proxy with TLS checked against the real host', async () => {
    const target = await secureServer();
    const proxy = await startConnectProxy();
    const source = routes([http(proxy.port)]);
    const agent = new ProxyAwareHttpsAgent({ routes: source }, { ca: LOCALHOST_TEST_CERT });
    try {
      const response = await axios.get(`https://localhost:${target.port}/models`, { proxy: false, httpsAgent: agent });
      expect(response.data).toBe('secure hello /models');
      expect(proxy.connects).toEqual([`localhost:${target.port}`]);
      expect(source.asked).toEqual([`https://localhost:${target.port}/`]);
    } finally { agent.destroy(); }
  });

  it('sends plain http to an HTTP proxy in absolute form, so a proxy that refuses CONNECT to port 80 still works', async () => {
    const seen: string[] = [];
    const target = await startHttpServer((request, response) => { seen.push(`${request.headers.host} ${request.url}`); response.end(`plain ${request.url}`); });
    const strict = await startConnectProxy({ status: 403 });
    const agent = new ProxyAwareHttpAgent({ routes: routes([http(strict.port)]) });
    try {
      expect((await axios.get(`http://localhost:${target.port}/v1/models?x=1`, { proxy: false, httpAgent: agent })).data).toBe('plain /v1/models?x=1');
      // The connection is not reused: a second request is written in absolute form too.
      expect((await axios.post(`http://localhost:${target.port}/v1/chat`, { a: 1 }, { proxy: false, httpAgent: agent })).data).toBe('plain /v1/chat');
      expect(strict.connects).toEqual([]);
      expect(strict.forwards).toEqual([`http://localhost:${target.port}/v1/models?x=1`, `http://localhost:${target.port}/v1/chat`]);
      expect(seen).toEqual([`localhost:${target.port} /v1/models?x=1`, `localhost:${target.port} /v1/chat`]);
      expect(Object.keys(agent.freeSockets)).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('keeps a caller lookup through the proxy for plain http: the tunnel goes to the approved address', async () => {
    const target = await startHttpServer((request, response) => response.end(`pinned ${request.headers.host}`));
    const proxy = await startConnectProxy();
    const agent = new ProxyAwareHttpAgent({ routes: routes([http(proxy.port)]) });
    const looked: string[] = [];
    const lookup = (host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) => {
      looked.push(host);
      callback(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    };
    try {
      const response = await axios.get(`http://public.example:${target.port}/`, { proxy: false, httpAgent: agent, lookup: lookup as never });
      expect(response.data).toBe(`pinned public.example:${target.port}`);
      expect(looked).toEqual(['public.example']);
      expect(proxy.connects).toEqual([`127.0.0.1:${target.port}`]);
      expect(proxy.forwards).toEqual([]);
      const refused = await axios.get(`http://blocked.example:${target.port}/`, {
        proxy: false, httpAgent: agent,
        lookup: ((_host: string, _options: unknown, callback: (error: Error) => void) => callback(Object.assign(new Error('blocked'), { code: 'EBLOCKED' }))) as never,
      }).catch(error => error);
      expect(refused.cause?.code ?? refused.code).toBe('EBLOCKED');
      expect(proxy.connects).toHaveLength(1);
    } finally { agent.destroy(); }
  });

  it('reports a refused tunnel and a proxy that wants a password as proxy failures', async () => {
    const refusing = await startConnectProxy({ status: 502 });
    const auth = await startConnectProxy({ status: 407 });
    const target = { host: 'example.test', port: 443 };
    const refused = await openTunnel(http(refusing.port) as Exclude<ProxyRoute, { kind: 'direct' }>, target).catch(error => error);
    expect(refused).toBeInstanceOf(ProxyConnectionError);
    expect(refused).toMatchObject({ code: 'ERR_PROXY_CONNECT', statusCode: 502, proxy: `127.0.0.1:${refusing.port}` });
    expect(classifyNetworkError(refused)).toBe('proxy_failed');
    const needsAuth = await openTunnel(http(auth.port) as Exclude<ProxyRoute, { kind: 'direct' }>, target).catch(error => error);
    expect(needsAuth).toMatchObject({ code: 'ERR_PROXY_AUTH_REQUIRED', statusCode: 407 });
    expect(classifyNetworkError(needsAuth)).toBe('proxy_auth');
  });

  it('keeps the socket error of an unreachable proxy and classifies it as a proxy failure even inside axios', async () => {
    const port = await closedPort();
    const agent = new ProxyAwareHttpsAgent({ routes: routes([http(port)]) });
    try {
      const error = await axios.get('https://example.test/', { proxy: false, httpsAgent: agent }).catch(failure => failure);
      expect(error.code).toBe('ECONNREFUSED');
      expect(classifyNetworkError(error)).toBe('proxy_failed');
    } finally { agent.destroy(); }
  });

  it('times out a proxy that accepts the connection but never answers', async () => {
    const quiet = net.createServer(() => undefined);
    await new Promise<void>(resolve => quiet.listen(0, '127.0.0.1', () => resolve()));
    try {
      const started = Date.now();
      const route = http((quiet.address() as net.AddressInfo).port) as Exclude<ProxyRoute, { kind: 'direct' }>;
      const error = await openTunnel(route, { host: 'example.test', port: 443 }, { timeoutMs: 150 }).catch(failure => failure);
      expect(error).toMatchObject({ code: 'ETIMEDOUT' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(classifyNetworkError(error)).toBe('proxy_failed');
    } finally {
      quiet.close();
    }
  });
});

describe('SOCKS tunnels', () => {
  it('connects through SOCKS5 without authentication, sending the host name to the proxy', async () => {
    const target = await secureServer('socks5');
    const proxy = await startSocks5Proxy();
    const agent = new ProxyAwareHttpsAgent({ routes: routes([{ kind: 'socks5', host: '127.0.0.1', port: proxy.port }]) }, { ca: LOCALHOST_TEST_CERT });
    try {
      const response = await axios.get(`https://localhost:${target.port}/a`, { proxy: false, httpsAgent: agent });
      expect(response.data).toBe('socks5 /a');
      expect(proxy.targets).toEqual([`localhost:${target.port}`]);
    } finally { agent.destroy(); }
  });

  it('refuses a SOCKS5 proxy that requires a password, and reports a failed SOCKS connect', async () => {
    const auth = await startSocks5Proxy({ requireAuth: true });
    const failing = await startSocks5Proxy({ reply: 0x05 });
    const target = { host: 'example.test', port: 443 };
    const needsAuth = await openTunnel({ kind: 'socks5', host: '127.0.0.1', port: auth.port }, target).catch(error => error);
    expect(needsAuth).toMatchObject({ code: 'ERR_PROXY_AUTH_REQUIRED' });
    expect(classifyNetworkError(needsAuth)).toBe('proxy_auth');
    const refused = await openTunnel({ kind: 'socks5', host: '127.0.0.1', port: failing.port }, target).catch(error => error);
    expect(refused).toMatchObject({ code: 'ERR_SOCKS_REPLY', statusCode: 5 });
    expect(classifyNetworkError(refused)).toBe('proxy_failed');
  });

  it('speaks SOCKS4a for a PAC "SOCKS" entry', async () => {
    const target = await startHttpServer((_request, response) => response.end('socks4'));
    const proxy = await startSocks4Proxy();
    const agent = new ProxyAwareHttpAgent({ routes: routes([{ kind: 'socks4', host: '127.0.0.1', port: proxy.port }]) });
    try {
      const response = await axios.get(`http://localhost:${target.port}/`, { proxy: false, httpAgent: agent });
      expect(response.data).toBe('socks4');
      expect(proxy.targets).toEqual([`localhost:${target.port}`]);
    } finally { agent.destroy(); }
  });
});

describe('route fallback and pooling', () => {
  it('falls back to the next PAC route when the first proxy is down, then to DIRECT', async () => {
    const target = await secureServer('fallback');
    const proxy = await startConnectProxy();
    const down = await closedPort();
    const viaSecond = new ProxyAwareHttpsAgent({ routes: routes([http(down), http(proxy.port)]) }, { ca: LOCALHOST_TEST_CERT });
    const viaDirect = new ProxyAwareHttpsAgent({ routes: routes([http(down), { kind: 'direct' }]) }, { ca: LOCALHOST_TEST_CERT });
    try {
      expect((await axios.get(`https://localhost:${target.port}/`, { proxy: false, httpsAgent: viaSecond })).data).toBe('fallback /');
      expect(proxy.connects).toHaveLength(1);
      expect((await axios.get(`https://localhost:${target.port}/`, { proxy: false, httpsAgent: viaDirect })).data).toBe('fallback /');
      expect(proxy.connects).toHaveLength(1);
    } finally { viaSecond.destroy(); viaDirect.destroy(); }
  });

  it('connects directly exactly like Node, including a custom lookup', async () => {
    const target = await secureServer('direct');
    const agent = new ProxyAwareHttpsAgent({ routes: routes([{ kind: 'direct' }]) }, { ca: LOCALHOST_TEST_CERT });
    const looked: string[] = [];
    try {
      const response = await axios.get(`https://localhost:${target.port}/`, {
        proxy: false, httpsAgent: agent,
        lookup: ((host: string, _options: unknown, callback: (error: null, address: string, family: number) => void) => {
          looked.push(host); callback(null, '127.0.0.1', 4);
        }) as never,
      });
      expect(response.data).toBe('direct /');
      expect(looked).toEqual(['localhost']);
    } finally { agent.destroy(); }
  });

  it('keeps a connection that was busy during a settings change out of the new pool', async () => {
    let release: (() => void) | undefined;
    const target = await startHttpsServer((request, response) => {
      if (request.url === '/slow') { release = () => response.end('slow'); return; }
      response.end('fast');
    });
    const proxy = await startConnectProxy();
    const source = routes([http(proxy.port)]);
    const agent = new ProxyAwareHttpsAgent({ routes: source }, { ca: LOCALHOST_TEST_CERT });
    const get = (path: string) => new Promise<string>((resolve, reject) => https.get(`https://localhost:${target.port}${path}`, { agent }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body));
    }).on('error', reject));
    try {
      const slow = get('/slow');
      await vi.waitFor(() => expect(release).toBeDefined());
      source.generation += 1;
      release!();
      expect(await slow).toBe('slow');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await get('/fast')).toBe('fast');
      // The old connection was not reused for the request made after the change.
      expect(proxy.connects).toHaveLength(2);
      expect(Object.keys(agent.sockets)).toEqual([]);
      expect(Object.keys(agent.freeSockets).every(name => name.endsWith(':route1'))).toBe(true);
    } finally { agent.destroy(); }
  });

  it('does not reuse pooled connections after the route generation changes', async () => {
    const target = await secureServer('pool');
    const proxy = await startConnectProxy();
    const source = routes([http(proxy.port)]);
    const agent = new ProxyAwareHttpsAgent({ routes: source }, { ca: LOCALHOST_TEST_CERT });
    try {
      const get = () => new Promise<void>((resolve, reject) => https.get(`https://localhost:${target.port}/`, { agent }, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
      await get();
      await get();
      expect(proxy.connects).toHaveLength(1);
      source.generation += 1;
      closeIdleSockets(agent);
      await get();
      expect(proxy.connects).toHaveLength(2);
    } finally { agent.destroy(); }
  });
});
