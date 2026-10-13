import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const SCRIPT = path.resolve('resources/external-agent/fusionkit-mcp-stdio.cjs');
const testEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }) as Record<string, string>;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function launch(profile: string) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap'));
  return { app, page };
}
async function connectStdio(args: string[], name: string) {
  const client = new Client({ name, version: '1' });
  await client.connect(new StdioClientTransport({ command: ELECTRON, args: [SCRIPT, ...args], env: testEnv(), stderr: 'ignore' }));
  return client;
}
const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe('external agents reach FusionKit through the stdio bridge', () => {
  it('runs the bridge with FusionKit\'s own executable and starts FusionKit when it is not running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-stdio-'));
    const profile = path.join(root, 'profile');
    const endpointPath = path.join(profile, 'external-agent', 'endpoint.json');
    let app: ElectronApplication | undefined;
    const clients: Client[] = [];
    let launchedPid: number | undefined;
    try {
      let page;
      ({ app, page } = await launch(profile));
      expect(existsSync(endpointPath)).toBe(false);
      const port = await freePort();
      const enabled = await page.evaluate(port => window.externalAgent!.updateSettings({ enabled: true, port }), port);
      const token = enabled.ok ? enabled.value.token : '';
      // The endpoint file names the running endpoint and follows token changes.
      await expect.poll(async () => existsSync(endpointPath) ? JSON.parse(await readFile(endpointPath, 'utf8')) : null)
        .toMatchObject({ version: 1, url: `http://127.0.0.1:${port}/mcp`, token });
      const renewed = await page.evaluate(() => window.externalAgent!.regenerateToken());
      const newToken = renewed.ok ? renewed.value.token : '';
      await expect.poll(async () => JSON.parse(await readFile(endpointPath, 'utf8')).token).toBe(newToken);
      const info = await page.evaluate(() => window.externalAgent!.connectionInfo());
      expect(info).toMatchObject({ ok: true, value: { scriptPath: SCRIPT, endpointPath, appPath: process.cwd() } });

      // FusionKit's executable runs the bridge as Node; the agent sees FusionKit's tools and real data.
      const viaBridge = await connectStdio(['--endpoint', endpointPath], 'stdio-agent');
      clients.push(viaBridge);
      expect(text(await viaBridge.callTool({ name: 'list_studio_documents', arguments: {} }))).toMatchObject({ total: 0, items: [] });
      await expect.poll(async () => (await page.evaluate(() => window.externalAgent!.getStatus())).value?.sessions.map((session: { client: { name: string } }) => session.client.name)).toContain('stdio-agent');

      // Turning access off removes the file; closing FusionKit does too.
      await page.evaluate(() => window.externalAgent!.updateSettings({ enabled: false }));
      await expect.poll(() => existsSync(endpointPath)).toBe(false);
      await page.evaluate(() => window.externalAgent!.updateSettings({ enabled: true }));
      await expect.poll(() => existsSync(endpointPath)).toBe(true);
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await app.close(); app = undefined;
      expect(existsSync(endpointPath)).toBe(false);

      // FusionKit is closed: the bridge starts it, waits for the endpoint and serves the same call.
      const started = await connectStdio(['--endpoint', endpointPath, '--launch', ELECTRON, '--app', process.cwd(), '--launch-arg', `--user-data-dir=${profile}`], 'auto-start');
      clients.push(started);
      launchedPid = JSON.parse(await readFile(endpointPath, 'utf8')).pid;
      expect(text(await started.callTool({ name: 'get_fusionkit_status', arguments: {} }))).toMatchObject({ app: 'FusionKit', subtitleStudio: { available: true } });
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      if (launchedPid) { try { process.kill(launchedPid); } catch { /* already gone */ } }
      await new Promise(resolve => setTimeout(resolve, 1500));
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
});
