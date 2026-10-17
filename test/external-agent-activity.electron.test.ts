import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const artifacts = path.resolve('test-results/external-agent-activity');
const DAY = 24 * 60 * 60 * 1000;

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
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows()[0].flashFrame = () => {};
    const state = globalThis as unknown as { revealed: string[] };
    state.revealed = [];
    shell.showItemInFolder = (file: string) => { state.revealed.push(file); };
  });
  return { app, page, errors };
}

async function connect(port: number, token: string, name: string) {
  const client = new Client({ name, version: '2.1.0' });
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
const records = (page: Page) => page.getByTestId('external-activity-record');
const record = (page: Page, text: string) => records(page).filter({ hasText: text }).first();
async function shot(page: Page, name: string) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }

const srt = (lines: string[]) => lines.map((line, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 1},800\n${line}\n`).join('\n');
const ass = (line: string) => `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
  + 'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n'
  + `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,${line}\n`;

/** An earlier connection two days ago, as FusionKit would have recorded it. */
function seededHistory(now: number): string {
  const at = now - 2 * DAY;
  const client = { name: 'codex', version: '0.47.0' };
  const deep = 'D:\\Anime Archive\\2026 Spring Season\\A Very Long Series Title That Keeps Going On And On\\Subtitles (Japanese)';
  const lines = [
    { t: 'session', id: 'codex-1', client, connectedAt: at },
    { t: 'call', id: 'old-read', sessionId: 'codex-1', client, tool: 'read_studio_document', access: 'read', startedAt: at + 1000, endedAt: at + 1040, status: 'ok', approval: 'none',
      note: { target: { documentId: '00000000-0000-4000-8000-000000000001', documentName: 'Old Episode.srt' } } },
    { t: 'call', id: 'old-convert', sessionId: 'codex-1', client, tool: 'convert_subtitle_files', access: 'write', startedAt: at + 2000, endedAt: at + 3400, status: 'ok', approval: 'confirmed',
      note: { summary: { action: 'files', key: 'convert_source', values: { count: 3, format: 'SRT' }, items: [1, 2, 3].map(index => ({ text: `${'Long Episode Name '.repeat(4)}0${index}.ass`, detail: `${deep}\\${'Long Episode Name '.repeat(4)}0${index}.ass` })) },
        result: { files: 3 }, outputs: [`${deep}\\Long Episode Name 01.srt`] } },
    { t: 'call', id: 'old-failed', sessionId: 'codex-1', client, tool: 'write_studio_translations', access: 'write', startedAt: at + 5000, endedAt: at + 5600, status: 'failed', approval: 'confirmed', error: 'tool_failed',
      note: { summary: { action: 'translation', key: 'write_translations', values: { count: 40, document: 'Old Episode.srt', track: 'codex' } }, reason: `The document could not be saved because the disk is full. ${'More detail about the failure. '.repeat(4)}` } },
    { t: 'call', id: 'old-declined', sessionId: 'codex-1', client, tool: 'prepare_knowledge_changes', access: 'write', startedAt: at + 7000, endedAt: at + 9000, status: 'declined', approval: 'declined',
      note: { summary: { action: 'knowledge', key: 'knowledge', values: { count: 2 }, items: [{ text: '法尔童 → 法厄同', tag: 'term' }, { text: '人名', tag: 'collection' }] } } },
    { t: 'end', id: 'codex-1', endedAt: at + 20 * 60 * 1000 },
  ];
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

describe('external agent activity', () => {
  it('records what external agents did, tells the user about changes made without asking, and keeps the record across restarts', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-activity-'));
    const profile = path.join(root, 'profile');
    const subtitles = path.join(root, 'subtitles');
    const classic = path.join(root, 'classic');
    const show = path.join(root, 'names', 'アニメ');
    await mkdir(subtitles, { recursive: true }); await mkdir(classic, { recursive: true }); await mkdir(show, { recursive: true });
    await mkdir(path.join(profile, 'external-agent'), { recursive: true });
    await writeFile(path.join(profile, 'external-agent', 'activity.jsonl'), seededHistory(Date.now()));
    await writeFile(path.join(subtitles, 'Episode 01.srt'), srt(['おはよう', 'いい天気だね', 'また明日']));
    await writeFile(path.join(classic, 'Episode 01.ass'), ass('おはよう'));
    await writeFile(path.join(show, '第1話.mp4'), 'one'); await writeFile(path.join(show, '第2話.mp4'), 'two');
    const secretTranslations = ['早上好呀（活动记录测试）', '天气真好（活动记录测试）', '明天见（活动记录测试）', '再见（活动记录测试）'];
    let app: ElectronApplication | undefined;
    const clients: Client[] = [];
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(profile, { lang: 'zh', theme: 'light', size: [1280, 860] }));
      const indicator = page.getByTestId('titlebar-external-agent');
      await uiExpect(indicator).toHaveCount(0);
      const port = await freePort();
      const enabled = await page.evaluate(port => window.externalAgent!.updateSettings({ enabled: true, port }), port);
      const token = enabled.ok ? enabled.value.token : '';
      const setTrust = (trust: string) => page.evaluate(value => window.externalAgent!.updateSettings({ trust: value as never }), trust);
      const agent = await connect(port, token, 'claude-code');
      clients.push(agent);
      expect((await call(agent, 'get_fusionkit_status')).error).toBeNull();
      await uiExpect(indicator).toBeVisible();
      await uiExpect(indicator).toContainText('claude-code');

      // Import and a track, each allowed for the rest of the connection.
      const importing = call(agent, 'import_studio_subtitles', { paths: [subtitles] });
      await uiExpect(dialog(page)).toContainText('claude-code 请求导入字幕');
      await page.getByText('本次连接内允许此类操作，不再询问').click();
      await allow(page).click();
      expect((await importing).value).toMatchObject({ importedCount: 1 });
      const documentId = (await call(agent, 'list_studio_documents')).value.items[0].documentId as string;
      const read = (await call(agent, 'read_studio_document', { documentId })).value;
      const creating = call(agent, 'create_studio_translation_track', { documentId, revision: read.document.revision, language: 'zh' });
      await uiExpect(dialog(page)).toContainText('编辑字幕译文');
      await page.getByText('本次连接内允许此类操作，不再询问').click();
      await allow(page).click();
      const track = (await creating).value;
      const cueIds = read.cues.map((cue: { cueId: string }) => cue.cueId);

      // Three writes nobody is asked about: one merged notice, three unseen changes, focus untouched.
      const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
      let revision = track.revision;
      for (let index = 0; index < 3; index++) {
        const written = await call(agent, 'write_studio_translations', { documentId, revision, trackId: track.trackId, translations: [{ cueId: cueIds[index], text: secretTranslations[index] }] });
        expect(written.error).toBeNull();
        revision = written.value.revision;
      }
      await uiExpect(dialog(page)).toBeHidden();
      const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'claude-code' });
      await uiExpect(notice).toHaveCount(1);
      await uiExpect(notice).toContainText('claude-code 做了 3 项改动');
      await uiExpect(page.getByTestId('titlebar-external-unseen')).toHaveText('3');
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(focused);
      await shot(page, 'activity-notice-zh-light-1280');

      // A rename (always asked), a conversion, one declined and one refused by read-only access.
      const inspected = (await call(agent, 'inspect_name_paths', { paths: [show], includeChildren: true })).value;
      const plan = inspected.children.map((item: { path: string; name: string; kind: string; identity: string }) => ({ path: item.path, kind: item.kind, identity: item.identity, newName: item.name.replace('第', 'Episode ').replace('話', '') }));
      const renaming = call(agent, 'rename_paths', { items: plan });
      await uiExpect(dialog(page)).toContainText('claude-code 请求重命名文件');
      await allow(page).click();
      expect((await renaming).value).toMatchObject({ renamed: 2 });
      const converting = call(agent, 'convert_subtitle_files', { paths: [classic], to: 'srt' });
      await uiExpect(dialog(page)).toContainText('claude-code 请求转换字幕文件');
      await allow(page).click();
      expect((await converting).value).toMatchObject({ written: 1 });
      const declining = call(agent, 'convert_subtitle_files', { paths: [classic], to: 'vtt' });
      await uiExpect(dialog(page)).toBeVisible();
      await decline(page).click();
      expect((await declining).error).toBe('declined_by_user');
      await setTrust('read_only');
      expect((await call(agent, 'write_studio_translations', { documentId, revision, trackId: track.trackId, translations: [{ cueId: cueIds[0], text: 'x' }] })).error).toBe('read_only');
      await setTrust('confirm_writes');

      // The indicator grows into a panel (Escape folds it back); its button opens this connection's activity and clears the count.
      const panel = page.getByTestId('titlebar-external-panel');
      await indicator.click();
      await uiExpect(panel).toContainText('claude-code');
      await uiExpect(panel).toContainText('当前权限：修改前询问');
      await uiExpect(page.getByTestId('titlebar-external-agent-root')).toHaveAttribute('data-open', 'true');
      await shot(page, 'titlebar-panel-zh-light-1280');
      await page.keyboard.press('Escape');
      await uiExpect(indicator).toBeVisible();
      await uiExpect(page.getByTestId('titlebar-external-agent-root')).not.toHaveAttribute('data-open', 'true');
      await indicator.click();
      await page.getByTestId('titlebar-external-open').click();
      await page.waitForURL(/#\/external-agent\?session=/);
      await uiExpect(indicator).toBeVisible();
      await uiExpect(page.getByTestId('titlebar-external-unseen')).toHaveCount(0);
      await uiExpect(notice).toHaveCount(0);
      await uiExpect(page.locator('#external-activity-panel')).toContainText('claude-code');
      await uiExpect(records(page).first()).toBeVisible();
      // Changes only (newest first): read-only refusal, declined, conversion, rename, three writes, track, import.
      await uiExpect(records(page)).toHaveCount(9);
      await uiExpect(records(page).first()).toContainText('只读权限拒绝');
      await uiExpect(record(page, '写入 1 条译文')).toContainText('本次连接已放行');
      await uiExpect(record(page, '改为外部 Agent 给出的名称')).toContainText('你已确认');
      await shot(page, 'activity-changes-zh-light-1280');

      // A new write while the page is open appears at the top, with no notice.
      const live = await call(agent, 'write_studio_translations', { documentId, revision, trackId: track.trackId, translations: [{ cueId: cueIds[0], text: secretTranslations[3] }] });
      expect(live.error).toBeNull();
      await uiExpect(records(page)).toHaveCount(10);
      await uiExpect(records(page).first()).toContainText('本次连接已放行');
      await page.waitForTimeout(600);
      await uiExpect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      await uiExpect(page.getByTestId('titlebar-external-unseen')).toHaveCount(0);

      // All calls include reads; problems are the declined and refused ones.
      await page.getByTestId('external-activity-filter-all').click();
      await uiExpect(record(page, '读取字幕内容')).toBeVisible();
      await page.getByTestId('external-activity-filter-problems').click();
      await uiExpect(records(page)).toHaveCount(2);
      await page.getByTestId('external-activity-filter-changes').click();

      // Details and actions: reveal the converted file, undo the rename.
      await record(page, '转换为 SRT').locator('button[aria-expanded]').click();
      await uiExpect(record(page, '转换为 SRT').getByTestId('external-activity-results')).toContainText('写出 1 个文件');
      await record(page, '转换为 SRT').getByTestId('external-activity-reveal').click();
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([path.join(classic, 'Episode 01.srt')]);
      const renameRow = record(page, '改为外部 Agent 给出的名称');
      await renameRow.locator('button[aria-expanded]').click();
      await uiExpect(renameRow.getByTestId('external-activity-details')).toContainText('第1話.mp4 → Episode 1.mp4');
      await shot(page, 'activity-expanded-zh-light-1280');
      await renameRow.getByTestId('external-activity-undo').click();
      await page.getByRole('dialog').getByRole('button', { name: '撤销' }).click();
      await uiExpect(renameRow).toContainText('已撤销');
      expect((await readdir(show)).sort()).toEqual(['第1話.mp4', '第2話.mp4']);
      await uiExpect(renameRow.getByTestId('external-activity-undo')).toHaveCount(0);

      // Open the written document in Subtitle Studio.
      const writeRow = record(page, '写入 1 条译文');
      await writeRow.locator('button[aria-expanded]').click();
      await writeRow.getByTestId('external-activity-open-document').click();
      await page.getByTestId('subtitle-studio').waitFor();
      await uiExpect(page.locator('.studio-cue-table')).toContainText('いい天気だね');
      expect(await page.evaluate(() => location.hash)).toBe('#/tools/subtitle/studio');

      // The earlier connection, from two days ago, with its failure explained.
      await page.evaluate(() => { location.hash = '/external-agent'; });
      await page.getByTestId('external-activity-session').filter({ hasText: 'codex' }).click();
      await uiExpect(records(page)).toHaveCount(3);
      await record(page, '向《Old Episode.srt》').locator('button[aria-expanded]').click();
      await uiExpect(record(page, '向《Old Episode.srt》').getByTestId('external-activity-error')).toContainText('执行时出错');
      await record(page, '转换为 SRT').locator('button[aria-expanded]').click();
      await shot(page, 'activity-history-zh-light-1280');

      // Settings: entry points and the notice switch.
      await page.evaluate(() => { location.hash = '/setting?tab=external'; });
      await page.getByTestId('setting-external-notices').waitFor();
      await uiExpect(page.getByTestId('setting-external-session-activity')).toBeVisible();
      await page.getByTestId('setting-external-sessions').scrollIntoViewIfNeeded();
      await shot(page, 'activity-settings-zh-light-1280');
      await page.getByTestId('setting-external-notices').click();
      await uiExpect(page.getByTestId('setting-external-notices')).toHaveAttribute('data-state', 'unchecked');
      await page.getByTestId('setting-external-activity').click();
      await page.waitForURL(/#\/external-agent$/);
      expect(errors).toEqual([]);

      // Nothing private reached the file.
      const file = await readFile(path.join(profile, 'external-agent', 'activity.jsonl'), 'utf8');
      for (const text of [...secretTranslations, 'おはよう', 'いい天気だね', token]) expect(file).not.toContain(text);
      expect(file).not.toContain('"translations"');

      // Restart: the record is still there; English, dark, narrow; the notice switch stayed off.
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await app.close(); app = undefined;
      ({ app, page, errors } = await launch(profile, { lang: 'en', theme: 'dark', size: [900, 700] }));
      await page.evaluate(() => { location.hash = '/external-agent'; });
      await uiExpect(records(page).first()).toBeVisible();
      await uiExpect(page.locator('#external-activity-panel')).toContainText('All connections');
      await uiExpect(record(page, 'Converted 1 subtitle file to SRT')).toBeVisible();
      await shot(page, 'activity-en-dark-900');
      const settings = await page.evaluate(() => window.externalAgent!.getSettings());
      expect(settings.ok && settings.value.notices).toBe(false);

      // Clearing removes every call and ended connection; a live connection stays and keeps recording.
      const later = await connect(port, token, 'claude-code');
      clients.push(later);
      await call(later, 'get_fusionkit_status');
      await page.getByTestId('external-activity-clear').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click();
      await uiExpect(page.getByTestId('external-activity-session')).toHaveCount(1);
      await uiExpect(page.getByTestId('external-activity-session')).toContainText('claude-code');
      await page.getByTestId('external-activity-filter-all').click();
      await uiExpect(records(page)).toHaveCount(0);
      await call(later, 'list_studio_documents');
      await uiExpect(records(page)).toHaveCount(1);
      await shot(page, 'activity-cleared-en-dark-900');
      expect(errors).toEqual([]);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 300_000);
});
