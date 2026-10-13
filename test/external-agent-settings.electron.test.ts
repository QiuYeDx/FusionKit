import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const artifacts = path.resolve('test-results/external-agent-settings');

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
type Look = { lang: string; theme: 'light' | 'dark'; size: [number, number] };
async function launch(profile: string, home: string, look: Look) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_EXTERNAL_AGENT_HOME: home } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); window.show(); }, look.size);
  await page.evaluate(({ lang, theme }) => {
    localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    location.hash = '/setting?tab=external';
  }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.getByTestId('setting-external-agent').waitFor();
  return { app, page, errors };
}
async function connect(port: number, token: string, name: string) {
  const client = new Client({ name, version: name === 'codex' ? '0.60.0' : '2.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
/** Windows puts CRLF on the clipboard. */
const clipboard = async (app: ElectronApplication) => (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
async function shot(page: Page, name: string) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }
const scrollTo = (page: Page, testId: string) => page.getByTestId(testId).scrollIntoViewIfNeeded();

describe('external agent settings', () => {
  it('turns access on, shows state, configurations and connections, and manages them', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-settings-'));
    const profile = path.join(root, 'profile');
    const home = path.join(root, 'home');
    let app: ElectronApplication | undefined;
    let blocker: NetServer | undefined;
    const clients: Client[] = [];
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(profile, home, { lang: 'zh', theme: 'light', size: [1280, 860] }));
      const status = page.getByTestId('setting-external-status');
      await uiExpect(status).toHaveText('未开启');
      await uiExpect(page.getByTestId('setting-external-config-disabled')).toBeVisible();
      await uiExpect(page.getByTestId('setting-external-sessions-empty')).toBeVisible();
      await shot(page, 'settings-off-zh-light-1280');

      // A bad port is refused in place; a free one is saved, then access is turned on.
      const portInput = page.getByTestId('setting-external-port');
      await portInput.fill('80'); await portInput.press('Enter');
      await uiExpect(page.getByText('请输入 1024–65535 之间的整数。')).toBeVisible();
      const port = await freePort();
      await portInput.fill(String(port)); await portInput.press('Enter');
      await uiExpect(page.getByText('请输入 1024–65535 之间的整数。')).toHaveCount(0);
      await page.locator('#setting-external-enable').click();
      await uiExpect(status).toContainText('运行中');
      await uiExpect(status).toContainText(`http://127.0.0.1:${port}/mcp`);
      const settings = await page.evaluate(() => window.externalAgent!.getSettings());
      const token = settings.ok ? settings.value.token : '';
      expect(settings.ok && settings.value.port).toBe(port);

      // Token: hidden, shown, copied.
      const tokenText = page.getByTestId('setting-external-token');
      await uiExpect(tokenText).not.toContainText(token);
      await page.getByTestId('setting-external-token-toggle').click();
      await uiExpect(tokenText).toHaveText(token);
      await page.getByTestId('setting-external-token-copy').click();
      await expect.poll(() => clipboard(app!)).toBe(token);

      // Client configurations follow the endpoint, the token and this installation's paths.
      const config = page.getByTestId('setting-external-config');
      await uiExpect(config).toHaveText(`claude mcp add --scope user --transport http fusionkit http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`);
      await page.getByRole('tab', { name: 'Codex' }).click();
      await uiExpect(config).toContainText(`url = 'http://127.0.0.1:${port}/mcp'`);
      await page.getByRole('tab', { name: 'stdio（可自动启动）' }).click();
      await uiExpect(config).toContainText("env = { ELECTRON_RUN_AS_NODE = '1' }");
      await uiExpect(config).toContainText(path.join(process.cwd(), 'resources', 'external-agent', 'fusionkit-mcp-stdio.cjs'));
      await uiExpect(config).toContainText(path.join(profile, 'external-agent', 'endpoint.json'));
      await page.getByTestId('setting-external-config-copy').click();
      await expect.poll(() => clipboard(app!)).toBe(await config.textContent());
      await page.getByRole('tab', { name: 'Cursor' }).click();
      expect(JSON.parse(await config.textContent() ?? '')).toMatchObject({ mcpServers: { fusionkit: { env: { ELECTRON_RUN_AS_NODE: '1' } } } });
      await page.getByRole('tab', { name: 'HTTP（推荐）' }).click();
      await page.getByRole('tab', { name: 'Claude Code' }).click();
      await scrollTo(page, 'setting-external-config');
      await shot(page, 'settings-on-zh-light-1280');

      // Connections appear with their latest call; the title bar shows a dot.
      const claude = await connect(port, token, 'claude-code'); clients.push(claude);
      const codex = await connect(port, token, 'codex'); clients.push(codex);
      await claude.callTool({ name: 'list_studio_documents', arguments: {} });
      const rows = page.getByTestId('setting-external-session');
      await uiExpect(rows).toHaveCount(2);
      await uiExpect(rows.filter({ hasText: 'claude-code' })).toContainText('最近：list_studio_documents 成功');
      await uiExpect(page.getByTestId('titlebar-external-agent')).toHaveAttribute('title', '2 个外部 Agent 已连接');
      await scrollTo(page, 'setting-external-sessions');
      await shot(page, 'settings-connections-zh-light-1280');

      // Read only takes effect for the next call.
      await page.locator('#setting-external-trust-read_only').click();
      await expect.poll(async () => (await page.evaluate(() => window.externalAgent!.getSettings())).value?.trust).toBe('read_only');
      const refused = await claude.callTool({ name: 'import_studio_subtitles', arguments: { paths: [root] } }) as { isError?: boolean; content: { text: string }[] };
      expect(JSON.parse(refused.content[0].text).error).toBe('read_only');
      await page.locator('#setting-external-trust-confirm_writes').click();

      // Disconnecting one client ends its session.
      await rows.filter({ hasText: 'codex' }).getByTestId('setting-external-disconnect').click();
      await uiExpect(rows).toHaveCount(1);
      await expect(codex.callTool({ name: 'get_fusionkit_status', arguments: {} })).rejects.toThrow();

      // A port in use is reported; a free port brings access back.
      blocker = createNetServer();
      const busy = await freePort();
      await new Promise<void>(resolve => blocker!.listen(busy, '127.0.0.1', resolve));
      await portInput.fill(String(busy)); await portInput.press('Enter');
      await uiExpect(status).toHaveText(`端口 ${busy} 已被其他程序占用，请换一个端口。`);
      await status.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await shot(page, 'settings-port-busy-zh-light-1280');
      await portInput.fill(String(port)); await portInput.press('Enter');
      await uiExpect(status).toContainText('运行中');

      // Resetting the token asks first, then disconnects everyone.
      const reconnect = await connect(port, token, 'claude-code'); clients.push(reconnect);
      await uiExpect(rows).toHaveCount(1);
      await page.getByTestId('setting-external-token-reset').click();
      await page.getByRole('button', { name: '重置', exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.externalAgent!.getSettings())).value?.token).not.toBe(token);
      await uiExpect(page.getByTestId('setting-external-sessions-empty')).toBeVisible();
      await uiExpect(page.getByTestId('titlebar-external-agent')).toHaveCount(0);

      // The skill installs into the user's agent folders (a temporary home here).
      await page.getByTestId('setting-external-skill-claude').click();
      const claudeSkill = path.join(home, '.claude', 'skills', 'fusionkit-app', 'SKILL.md');
      await uiExpect(page.getByTestId('setting-external-skill-status-claude')).toHaveText(`已安装：${claudeSkill}`);
      expect((await readFile(claudeSkill, 'utf8')).replace(/\r\n/g, '\n')).toBe((await readFile(path.resolve('.agents/skills/fusionkit-app/SKILL.md'), 'utf8')).replace(/\r\n/g, '\n'));
      await page.getByTestId('setting-external-skill-codex').click();
      await expect.poll(() => existsSync(path.join(home, '.codex', 'skills', 'fusionkit-app', 'SKILL.md'))).toBe(true);
      await scrollTo(page, 'setting-external-skill-status-codex');
      await shot(page, 'settings-skill-zh-light-1280');
      expect(errors).toEqual([]);

      // English, dark, narrow.
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await app.close(); app = undefined;
      ({ app, page, errors } = await launch(profile, home, { lang: 'en', theme: 'dark', size: [900, 700] }));
      const newToken = (await page.evaluate(() => window.externalAgent!.getSettings())).value!.token;
      clients.push(await connect(port, newToken, 'claude-code'), await connect(port, newToken, 'codex'));
      await uiExpect(page.getByTestId('setting-external-session')).toHaveCount(2);
      await shot(page, 'settings-on-en-dark-900');
      await page.getByRole('tab', { name: 'stdio (starts FusionKit)' }).click();
      await scrollTo(page, 'setting-external-config');
      await shot(page, 'settings-stdio-en-dark-900');
      await scrollTo(page, 'setting-external-sessions');
      await shot(page, 'settings-connections-en-dark-900');
      // The page never scrolls sideways: long paths scroll inside their code block.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.getByTestId('setting-external-config').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      if (blocker) await new Promise<void>(resolve => blocker!.close(() => resolve()));
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
});
