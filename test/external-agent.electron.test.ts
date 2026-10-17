import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_EXTERNAL_PERMISSIONS } from '../src/agent/external/contract';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EXTERNAL_TOOLS } from '../src/agent/external/catalog';

const SECRET = 'synthetic-external-key-7f3a';
const PRIVATE_URL = 'https://private-llm.example/v1';

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function launch(profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  const win = await app.browserWindow(page);
  await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); });
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  return { app, page };
}

const settings = (page: Page) => page.evaluate(() => window.externalAgent!.getSettings());
const status = (page: Page) => page.evaluate(() => window.externalAgent!.getStatus());
const update = (page: Page, change: Record<string, unknown>) => page.evaluate(value => window.externalAgent!.updateSettings(value as never), change);

async function connect(port: number, token: string, name = 'e2e-agent') {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport };
}
const text = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content)[0].text);

function raw(port: number, headers: Record<string, string>, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }), pathName = '/mcp') {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

describe('external agents reach FusionKit over MCP', () => {
  it('stays closed by default, then serves an authenticated client with real data from the window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-agent-'));
    const profile = path.join(root, 'profile');
    let app: ElectronApplication | undefined;
    let blocker: NetServer | undefined;
    const clients: Client[] = [];
    try {
      ({ app } = await launch(profile));
      let page = await app.firstWindow();

      // Fresh profile: off, default port, confirm writes, nothing listening.
      const defaults = await settings(page);
      expect(defaults).toEqual({ ok: true, value: { version: 1, enabled: false, port: 47361, token: '', trust: 'confirm_writes', permissions: DEFAULT_EXTERNAL_PERMISSIONS, notices: true } });
      expect(await status(page)).toMatchObject({ ok: true, value: { enabled: false, state: 'stopped', sessions: [] } });

      // Only the main window may configure access.
      // A window of its own with direct IPC access: the main process refuses it all the same.
      const outsider = await app.evaluate(async ({ BrowserWindow }) => {
        const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
        await other.loadURL('data:text/html,<p>other</p>');
        const answer = await other.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('external-agent:update-settings', { enabled: true })");
        other.destroy();
        return answer;
      });
      expect(outsider).toEqual({ ok: false, error: 'external_agent_blocked' });
      expect((await settings(page)).value?.enabled).toBe(false);

      // A model with a key is configured; the key must never reach the external agent.
      await page.evaluate(([secret, url]) => {
        const model = { id: 'm', name: 'Private model', provider: 'Other', apiKey: secret, baseUrl: url, modelKey: 'private-model', apiFormat: 'responses', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [model], assignment: { agent: 'm', taskExecution: 'm' }, audioProfiles: [], audioAssignment: {} } }));
      }, [SECRET, PRIVATE_URL]);
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap'));

      const port = await freePort();
      const enabled = await update(page, { enabled: true, port });
      expect(enabled.ok).toBe(true);
      const token = enabled.value!.token;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await status(page)).toMatchObject({ value: { state: 'running', port, url: `http://127.0.0.1:${port}/mcp` } });

      // Refusals before any session exists.
      expect(await raw(port, {})).toBe(401);
      expect(await raw(port, { Authorization: `Bearer ${'x'.repeat(43)}` })).toBe(401);
      expect(await raw(port, { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).toBe(403);
      expect(await raw(port, { Authorization: `Bearer ${token}`, Host: `rebind.example:${port}` })).toBe(403);
      expect(await raw(port, { Authorization: `Bearer ${token}` }, undefined, '/')).toBe(404);

      // An authenticated client: handshake, catalog, real data from the window.
      const { client, transport } = await connect(port, token);
      clients.push(client);
      expect(client.getServerVersion()?.name).toBe('fusionkit');
      expect(client.getInstructions()).toContain('Subtitle Studio');
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(Object.keys(EXTERNAL_TOOLS).sort());
      await expect.poll(async () => (await status(page)).value?.sessions.map(session => session.client.name)).toEqual(['e2e-agent']);

      const state = await client.callTool({ name: 'get_fusionkit_status', arguments: {} });
      expect(state.isError).toBeFalsy();
      const stateText = JSON.stringify(text(state));
      expect(text(state)).toMatchObject({ app: 'FusionKit', currentPage: '/', trust: 'confirm_writes',
        fusionkitModels: { agent: { configured: true, name: 'Private model' } }, subtitleStudio: { available: true, documentCount: 0 } });
      expect(stateText).not.toContain(SECRET);
      expect(stateText).not.toContain('private-llm.example');

      expect(text(await client.callTool({ name: 'list_studio_documents', arguments: {} }))).toMatchObject({ total: 0, items: [], nextOffset: null });

      // Documents imported in the window are what the external agent lists.
      const subtitles = path.join(root, 'subtitles');
      await mkdir(subtitles, { recursive: true });
      const cue = (index: number, line: string) => `${index}\n00:00:0${index},000 --> 00:00:0${index},800\n${line}\n`;
      await writeFile(path.join(subtitles, 'Episode 01.srt'), [cue(1, 'おはよう'), cue(2, 'いい天気だね')].join('\n'));
      await writeFile(path.join(subtitles, 'Episode 02.srt'), cue(1, 'こんばんは'));
      const imported = await page.evaluate(folder => window.subtitleStudio.importSubtitlePaths({ encoding: 'utf-8', paths: [folder] }), subtitles);
      expect(imported.ok && imported.value.items.every(item => item.ok)).toBe(true);
      const library = text(await client.callTool({ name: 'list_studio_documents', arguments: { limit: 1 } }));
      expect(library).toMatchObject({ total: 2, nextOffset: 1 });
      expect(library.items[0]).toMatchObject({ documentId: expect.any(String), revision: expect.any(Number), format: 'srt' });
      const filtered = text(await client.callTool({ name: 'list_studio_documents', arguments: { query: 'Episode 02' } }));
      expect(filtered.items.map((item: { name: string }) => item.name)).toEqual(['Episode 02.srt']);
      expect(filtered.items[0].cueCount).toBe(1);

      // Bad arguments are answered by the main process.
      const bad = await client.callTool({ name: 'list_studio_documents', arguments: { limit: 999 } });
      expect(bad.isError).toBe(true);
      expect(text(bad).error).toBe('invalid_arguments');

      // A call racing a reload either waits for the new tool host or, if the old page already took it, fails cleanly; never hangs.
      const reloading = page.reload();
      const duringReload = await client.callTool({ name: 'get_fusionkit_status', arguments: {} });
      await reloading;
      if (duringReload.isError) expect(text(duringReload)).toEqual({ error: 'fusionkit_window_unavailable' });
      const afterReload = await client.callTool({ name: 'list_studio_documents', arguments: {} });
      expect(text(afterReload).total).toBe(2);

      // DELETE ends the session; its id is then unknown.
      const sessionId = transport.sessionId!;
      await transport.terminateSession();
      expect(await raw(port, { Authorization: `Bearer ${token}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toBe(404);
      await expect.poll(async () => (await status(page)).value?.sessions.length).toBe(0);

      // A new token ends every session and the old token stops working.
      const second = await connect(port, token, 'second-agent');
      clients.push(second.client);
      const renewed = await page.evaluate(() => window.externalAgent!.regenerateToken());
      expect(renewed.ok && renewed.value.token !== token).toBe(true);
      expect(await raw(port, { Authorization: `Bearer ${token}` })).toBe(401);
      await expect.poll(async () => (await status(page)).value?.sessions.length).toBe(0);
      const fresh = await connect(port, renewed.value!.token, 'third-agent');
      clients.push(fresh.client);
      expect(text(await fresh.client.callTool({ name: 'list_studio_documents', arguments: {} })).total).toBe(2);

      // Settings survive a restart, and the endpoint comes back with them.
      await app.close(); app = undefined;
      ({ app } = await launch(profile));
      page = await app.firstWindow();
      expect((await settings(page)).value).toEqual({ version: 1, enabled: true, port, token: renewed.value!.token, trust: 'confirm_writes', permissions: DEFAULT_EXTERNAL_PERMISSIONS, notices: true });
      expect(JSON.parse(await readFile(path.join(profile, 'external-agent', 'settings.json'), 'utf8')).token).toBe(renewed.value!.token);
      const afterRestart = await connect(port, renewed.value!.token, 'after-restart');
      clients.push(afterRestart.client);
      expect(text(await afterRestart.client.callTool({ name: 'list_studio_documents', arguments: {} })).total).toBe(2);

      // Turning access off closes the port; a port taken by another program is reported.
      expect((await update(page, { enabled: false })).ok).toBe(true);
      await expect(raw(port, { Authorization: `Bearer ${renewed.value!.token}` })).rejects.toThrow();
      expect(await status(page)).toMatchObject({ value: { state: 'stopped', sessions: [] } });
      blocker = createNetServer();
      const busy = await freePort();
      await new Promise<void>(resolve => blocker!.listen(busy, '127.0.0.1', resolve));
      await update(page, { enabled: true, port: busy });
      await expect.poll(async () => (await status(page)).value).toMatchObject({ state: 'error', error: 'port_in_use', port: busy });
      expect((await update(page, { port: 22 })).ok).toBe(false);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      if (blocker) await new Promise<void>(resolve => blocker!.close(() => resolve()));
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
