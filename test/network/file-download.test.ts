import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyAwareHttpsAgent } from '../../electron/main/network/agent';
import { downloadToFile } from '../../electron/main/network/file-download';
import { LOCALHOST_TEST_CERT } from './localhost-test-cert';
import { closeAllServers, startConnectProxy, startHttpsServer } from './local-servers';

const roots: string[] = [];
const agents: ProxyAwareHttpsAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await closeAllServers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

async function target(name = 'FusionKit-Setup.exe') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fk-file-download-'));
  roots.push(root);
  return path.join(root, name);
}

function directAgent() {
  const agent = new ProxyAwareHttpsAgent({ routes: { generation: 0, resolve: async () => [{ kind: 'direct' }] } }, { ca: LOCALHOST_TEST_CERT });
  agents.push(agent);
  return agent;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

describe('installer download', () => {
  it('follows a relative redirect and goes through the proxy agent', async () => {
    const server = await startHttpsServer((request, response) => {
      if (request.url === '/latest/download/setup.exe') { response.writeHead(302, { location: '../files/setup.exe' }); response.end(); return; }
      response.writeHead(200, { 'content-length': '9' });
      response.end(`installer`);
    });
    const proxy = await startConnectProxy();
    const agent = new ProxyAwareHttpsAgent({ routes: { generation: 0, resolve: async () => [{ kind: 'http', host: '127.0.0.1', port: proxy.port }] } }, { ca: LOCALHOST_TEST_CERT });
    agents.push(agent);
    const file = await target();
    await downloadToFile(`https://localhost:${server.port}/latest/download/setup.exe`, file, { agent });
    expect(await readFile(file, 'utf8')).toBe('installer');
    expect(proxy.connects.length).toBeGreaterThanOrEqual(1);
    expect(proxy.connects.every(authority => authority === `localhost:${server.port}`)).toBe(true);
  });

  it('removes the partial file and fails once when the connection drops mid-file', async () => {
    const server = await startHttpsServer((_request, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('only ten b');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const file = await target();
    let settled = 0;
    const error = await downloadToFile(`https://localhost:${server.port}/setup.exe`, file, { agent: directAgent() })
      .then(() => { settled += 1; }, failure => { settled += 1; return failure; });
    expect(error).toBeInstanceOf(Error);
    expect(settled).toBe(1);
    expect(await exists(file)).toBe(false);
  });

  it('cuts a body that stops sending and removes what was written', async () => {
    const server = await startHttpsServer((_request, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('stalled...');
    });
    const file = await target();
    const started = Date.now();
    const error = await downloadToFile(`https://localhost:${server.port}/setup.exe`, file, { agent: directAgent(), idleTimeoutMs: 150 }).catch(failure => failure);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await exists(file)).toBe(false);
  });

  it('refuses error answers, redirects to plain http and redirect loops without writing a file', async () => {
    const server = await startHttpsServer((request, response) => {
      if (request.url === '/missing') { response.statusCode = 404; response.end(); return; }
      if (request.url === '/insecure') { response.writeHead(302, { location: 'http://localhost/setup.exe' }); response.end(); return; }
      response.writeHead(302, { location: '/loop' });
      response.end();
    });
    const agent = directAgent();
    const file = await target();
    await expect(downloadToFile(`https://localhost:${server.port}/missing`, file, { agent })).rejects.toThrow('status 404');
    await expect(downloadToFile(`https://localhost:${server.port}/insecure`, file, { agent })).rejects.toThrow('not https');
    await expect(downloadToFile(`https://localhost:${server.port}/loop`, file, { agent, maxRedirects: 2 })).rejects.toThrow('Too many redirects');
    expect(await exists(file)).toBe(false);
  });
});
