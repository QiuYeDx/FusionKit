import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const artifacts = path.resolve('test-results/external-agent');

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function launch(profile: string, look: { lang: string; theme: 'light' | 'dark'; size: [number, number] }) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); window.show(); }, look.size);
  await page.evaluate(({ lang, theme }) => { localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 })); }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].flashFrame = () => {}; });
  return { app, page, errors };
}

async function connect(port: number, token: string, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
type CallResult = { isError?: boolean; content: { text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as CallResult;
  const body = JSON.parse(result.content[0].text);
  return { error: result.isError ? body.error as string : null, value: body };
}
const dialog = (page: Page) => page.getByRole('dialog');
const allow = (page: Page) => page.getByTestId('external-agent-confirm-allow');
const decline = (page: Page) => page.locator('#external-agent-confirm-decline');
async function shot(page: Page, name: string) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }

const ass = (line: string) => `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
  + 'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n'
  + `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,${line}\n`;

describe('external agents use the classic tools without an API key', () => {
  it('converts, extracts, renames with its own names and undoes, each confirmed as the trust level says', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-classic-'));
    const profile = path.join(root, 'profile');
    const subs = path.join(root, 'subs');
    const names = path.join(root, 'names');
    const show = path.join(names, 'アニメ');
    const many = path.join(root, 'many');
    await mkdir(subs, { recursive: true }); await mkdir(show, { recursive: true }); await mkdir(many, { recursive: true });
    await writeFile(path.join(subs, 'Episode 01.ass'), ass('おはよう'));
    await writeFile(path.join(subs, 'Episode 02.ass'), ass('こんばんは'));
    await writeFile(path.join(subs, 'Bilingual.srt'), '1\n00:00:01,000 --> 00:00:02,000\n早上好\nおはようございます\n\n2\n00:00:03,000 --> 00:00:04,000\n明天见\nまた明日ね\n');
    await writeFile(path.join(show, '第1話.mp4'), 'one'); await writeFile(path.join(show, '第2話.mp4'), 'two');
    for (let index = 1; index <= 25; index++) await writeFile(path.join(many, `ファイル${String(index).padStart(2, '0')}.txt`), String(index));
    let app: ElectronApplication | undefined;
    const clients: Client[] = [];
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(profile, { lang: 'zh', theme: 'light', size: [1280, 860] }));
      const port = await freePort();
      const enabled = await page.evaluate(port => window.externalAgent!.updateSettings({ enabled: true, port }), port);
      const token = enabled.ok ? enabled.value.token : '';
      const agent = await connect(port, token, 'claude-code');
      clients.push(agent);
      const listed = await agent.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['convert_subtitle_files', 'extract_subtitle_language', 'get_classic_tasks', 'inspect_name_paths', 'rename_paths', 'undo_name_changes']));

      // Convert a folder of ASS to SRT next to the files; the user allows conversions for this connection.
      const converting = call(agent, 'convert_subtitle_files', { paths: [subs], to: 'srt' });
      await uiExpect(dialog(page)).toContainText('claude-code 请求转换字幕文件');
      // Bilingual.srt is already SRT: it is skipped and not listed.
      await uiExpect(page.getByTestId('external-agent-confirm-items').locator('li')).toHaveCount(2);
      await shot(page, 'confirm-convert-zh-light-1280');
      await page.getByText('本次连接内允许此类操作，不再询问').click();
      await allow(page).click();
      const converted = (await converting).value;
      expect(converted).toMatchObject({ written: 2, total: 3 });
      expect(converted.files.find((item: { source: string }) => item.source.endsWith('Bilingual.srt'))).toMatchObject({ ok: false, skipped: true, error: 'already_srt' });
      const srtOut = await readFile(path.join(subs, 'Episode 01.srt'), 'utf8');
      expect(srtOut).toContain('おはよう');
      expect(srtOut).toContain('00:00:01,000 --> 00:00:02,500');

      // Extraction is allowed by the same grant: no dialog.
      const before = new Set(await readdir(subs));
      const extracted = await call(agent, 'extract_subtitle_language', { paths: [path.join(subs, 'Bilingual.srt')], keep: 'zh' });
      expect(extracted.error).toBeNull();
      await uiExpect(dialog(page)).toBeHidden();
      const created = (await readdir(subs)).filter(name => !before.has(name));
      expect(created).toHaveLength(1);
      const zh = await readFile(path.join(subs, created[0]), 'utf8');
      expect(zh).toContain('早上好'); expect(zh).not.toContain('おはよう');

      // Rename with the agent's own names: always asked, even after other grants; then undone.
      const inspected = (await call(agent, 'inspect_name_paths', { paths: [show], includeChildren: true })).value;
      expect(inspected.children.map((item: { name: string }) => item.name).sort()).toEqual(['第1話.mp4', '第2話.mp4']);
      const plan = [...inspected.children, ...inspected.entries].map((item: { path: string; name: string; kind: string; identity: string }) => ({
        path: item.path, kind: item.kind, identity: item.identity, newName: ({ '第1話.mp4': 'Episode 1.mp4', '第2話.mp4': 'Episode 2.mp4', 'アニメ': 'Anime' } as Record<string, string>)[item.name],
      }));
      const renaming = call(agent, 'rename_paths', { items: plan });
      await uiExpect(dialog(page)).toContainText('claude-code 请求重命名文件');
      await uiExpect(dialog(page)).toContainText('第1話.mp4 → Episode 1.mp4');
      await uiExpect(page.getByText('本次连接内允许此类操作，不再询问')).toHaveCount(0);
      await shot(page, 'confirm-rename-zh-light-1280');
      await allow(page).click();
      const renamed = (await renaming).value;
      expect(renamed).toMatchObject({ renamed: 3, journalId: expect.any(String) });
      expect((await readdir(path.join(names, 'Anime'))).sort()).toEqual(['Episode 1.mp4', 'Episode 2.mp4']);
      // A name that already exists is reported without asking or renaming.
      const again = (await call(agent, 'inspect_name_paths', { paths: [path.join(names, 'Anime', 'Episode 1.mp4')] })).value.entries[0];
      const clash = await call(agent, 'rename_paths', { items: [{ path: again.path, kind: again.kind, identity: again.identity, newName: 'Episode 2.mp4' }] });
      expect(clash).toMatchObject({ error: 'rename_issues', value: { issues: [{ issue: 'target_exists' }] } });
      await uiExpect(dialog(page)).toBeHidden();
      const undoing = call(agent, 'undo_name_changes', { journalId: renamed.journalId });
      await uiExpect(dialog(page)).toContainText('撤销外部 Agent 之前的一次重命名');
      await allow(page).click();
      expect((await undoing).value).toMatchObject({ status: 'completed', restored: 3 });
      expect((await readdir(show)).sort()).toEqual(['第1話.mp4', '第2話.mp4']);

      // Twenty-five renames: eight rows and the rest counted; declining renames nothing.
      const files = (await call(agent, 'inspect_name_paths', { paths: [many], includeChildren: true })).value.children;
      const bulk = call(agent, 'rename_paths', { items: files.map((item: { path: string; name: string; kind: string; identity: string }) => ({ path: item.path, kind: item.kind, identity: item.identity, newName: item.name.replace('ファイル', 'File ') })) });
      await uiExpect(page.getByTestId('external-agent-confirm-items').locator('li')).toHaveCount(9);
      await uiExpect(page.getByTestId('external-agent-confirm-items')).toContainText('另有 17 项');
      await shot(page, 'confirm-rename-many-zh-light-1280');
      await decline(page).click();
      expect((await bulk).error).toBe('declined_by_user');
      expect((await readdir(many)).every(name => name.startsWith('ファイル'))).toBe(true);

      // Classic pages: tasks read and a page shown.
      expect((await call(agent, 'get_classic_tasks')).value).toEqual({ total: 0, items: [] });
      expect((await call(agent, 'open_fusionkit_page', { page: 'name_translator' })).value).toMatchObject({ currentPage: '/tools/rename/name-translator' });

      // Read only: every write is refused.
      await page.evaluate(() => window.externalAgent!.updateSettings({ trust: 'read_only' }));
      expect((await call(agent, 'convert_subtitle_files', { paths: [subs], to: 'vtt' })).error).toBe('read_only');
      expect((await call(agent, 'rename_paths', { items: plan })).error).toBe('read_only');
      expect(errors).toEqual([]);

      // English, dark, narrow: the rename confirmation.
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await app.close(); app = undefined;
      ({ app, page, errors } = await launch(profile, { lang: 'en', theme: 'dark', size: [900, 700] }));
      await page.evaluate(() => window.externalAgent!.updateSettings({ trust: 'confirm_writes' }));
      const later = await connect(port, token, 'claude-code');
      clients.push(later);
      const fresh = (await call(later, 'inspect_name_paths', { paths: [show], includeChildren: true })).value;
      const english = call(later, 'rename_paths', { items: fresh.children.map((item: { path: string; name: string; kind: string; identity: string }) => ({ path: item.path, kind: item.kind, identity: item.identity, newName: item.name.replace('第', 'Episode ').replace('話', '') })) });
      await uiExpect(dialog(page)).toContainText('claude-code wants to rename files');
      await shot(page, 'confirm-rename-en-dark-900');
      await decline(page).click();
      expect((await english).error).toBe('declined_by_user');
      expect(errors).toEqual([]);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 240_000);
});
