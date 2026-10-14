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

async function launch(profile: string, look: { lang: string; theme: 'light' | 'dark'; size: [number, number] } = { lang: 'zh', theme: 'light', size: [1280, 860] }) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); window.show(); }, look.size);
  await page.evaluate(({ lang, theme }) => {
    localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    localStorage.setItem('translation-knowledge-tour-done', '1');
  }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  // Count taskbar flashes instead of flashing during tests.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    (globalThis as { flashes?: number }).flashes = 0;
    window.flashFrame = () => { (globalThis as unknown as { flashes: number }).flashes++; };
  });
  return { app, page, errors };
}

async function connect(port: number, token: string, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
type CallResult = { isError?: boolean; content: { text: string }[] };
const body = (result: unknown) => JSON.parse((result as CallResult).content[0].text);
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as CallResult;
  return { error: result.isError ? body(result).error as string : null, value: body(result) };
}

const dialog = (page: Page) => page.getByRole('dialog');
const allow = (page: Page) => page.getByTestId('external-agent-confirm-allow');
const decline = (page: Page) => page.locator('#external-agent-confirm-decline');
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
}

const srt = (lines: string[]) => lines.map((line, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 1},800\n${line}\n`).join('\n');

describe('external agents translate with FusionKit without an API key', () => {
  it('imports, reads, writes its own translations and exports, with every change confirmed as the trust level says', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-external-tools-'));
    const profile = path.join(root, 'profile');
    const subtitles = path.join(root, 'subtitles');
    await mkdir(subtitles, { recursive: true });
    await writeFile(path.join(subtitles, 'Episode 01.srt'), srt(['おはよう', 'いい天気だね', 'また明日']));
    await writeFile(path.join(subtitles, 'Episode 02.srt'), srt(['こんばんは']));
    // A deep folder with a long name, for the dialog's path rows.
    const deep = path.join(root, 'Anime Archive', '2026 Spring Season', 'A Very Long Series Title That Keeps Going On And On', 'Subtitles (Japanese)');
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, `${'Long Episode Name '.repeat(5)}01.srt`), srt(['長い名前']));
    let app: ElectronApplication | undefined;
    const clients: Client[] = [];
    try {
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(profile));
      const port = await freePort();
      const enabled = await page.evaluate(port => window.externalAgent!.updateSettings({ enabled: true, port }), port);
      const token = enabled.ok ? enabled.value.token : '';
      const setTrust = (trust: string) => page.evaluate(value => window.externalAgent!.updateSettings({ trust: value as never }), trust);
      const agent = await connect(port, token, 'claude-code');
      clients.push(agent);
      expect((await call(agent, 'get_fusionkit_status')).value.fusionkitModels).toEqual({ agent: { configured: false }, taskExecution: { configured: false } });

      // Import: confirm_writes asks. Ten paths show eight rows and "2 more".
      const paths = [subtitles, deep, ...Array.from({ length: 8 }, (_, index) => path.join(root, `missing-${index}`))];
      const importing = call(agent, 'import_studio_subtitles', { paths });
      await uiExpect(dialog(page)).toBeVisible();
      await uiExpect(dialog(page)).toContainText('claude-code 请求导入字幕');
      await uiExpect(page.getByTestId("external-agent-confirm-items").locator("li")).toHaveCount(9);
      await uiExpect(page.getByTestId("external-agent-confirm-items").locator("li").first()).toContainText("subtitles");
      await uiExpect(page.locator('#external-agent-confirm-decline')).toBeFocused();
      expect(await app.evaluate(() => (globalThis as unknown as { flashes: number }).flashes)).toBeGreaterThan(0);
      await shot(page, 'confirm-import-zh-light-1280');
      await decline(page).click();
      expect((await importing).error).toBe('declined_by_user');
      expect((await call(agent, 'list_studio_documents')).value.total).toBe(0);

      const imported = call(agent, 'import_studio_subtitles', { paths: [subtitles] });
      await uiExpect(dialog(page)).toBeVisible();
      await allow(page).click();
      const importResult = await imported;
      expect(importResult.value).toMatchObject({ importedCount: 2, total: 2 });
      await uiExpect(dialog(page)).toBeHidden();

      // Read, create a track (allowing the rest of this connection), write in two batches.
      const docs = (await call(agent, 'list_studio_documents', { query: 'Episode 01' })).value.items;
      const documentId = docs[0].documentId as string;
      const read = (await call(agent, 'read_studio_document', { documentId })).value;
      expect(read.cues.map((cue: { text: string }) => cue.text)).toEqual(['おはよう', 'いい天気だね', 'また明日']);
      const creating = call(agent, 'create_studio_translation_track', { documentId, revision: read.document.revision, language: 'zh' });
      await uiExpect(dialog(page)).toContainText('编辑字幕译文');
      await uiExpect(dialog(page)).toContainText('Episode 01.srt');
      await shot(page, 'confirm-translation-zh-light-1280');
      await page.getByText('本次连接内允许此类操作，不再询问').click();
      await allow(page).click();
      const track = (await creating).value;
      expect(track).toMatchObject({ trackId: expect.any(String), revision: read.document.revision + 1 });
      const cueIds = read.cues.map((cue: { cueId: string }) => cue.cueId);
      const first = await call(agent, 'write_studio_translations', { documentId, revision: track.revision, trackId: track.trackId,
        translations: [{ cueId: cueIds[0], text: '早上好' }, { cueId: cueIds[1], text: '天气真好啊' }] });
      expect(first.error).toBeNull();
      expect(first.value).toMatchObject({ written: 2 });
      await uiExpect(dialog(page)).toBeHidden();
      expect((await call(agent, 'write_studio_translations', { documentId, revision: first.value.revision, trackId: track.trackId, translations: [{ cueId: cueIds[2], text: '<b>明天见</b>' }] })).error).toBe('invalid_translation_text');
      const stale = await call(agent, 'write_studio_translations', { documentId, revision: track.revision, trackId: track.trackId, translations: [{ cueId: cueIds[2], text: '明天见' }] });
      expect(stale.value).toEqual({ error: 'revision_conflict', currentRevision: first.value.revision });

      // Subtitle Studio shows the track and its unreviewed AI lines; one undo removes the agent's write.
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.getByTestId('studio-library-row').filter({ hasText: 'Episode 01.srt' }).locator('button.studio-document').click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(3);
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('早上好');
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toHaveText('天气真好啊');
      await uiExpect(page.locator('.studio-cue-table .studio-cue-mark')).toHaveCount(0);
      await uiExpect(page.locator('.studio-translation-track-controls [role=combobox]')).toHaveAttribute('title', /claude-code/);
      const undo = page.getByTestId('studio-cue-undo');
      await uiExpect(undo).toHaveAccessibleName('撤销：外部 Agent 写入 2 条译文');
      await shot(page, 'studio-agent-track-zh-light-1280');
      await undo.click();
      await uiExpect(rows.nth(0).locator('[data-field=target]')).not.toHaveText('早上好');
      const afterUndo = (await call(agent, 'read_studio_document', { documentId, trackId: track.trackId })).value;
      expect(afterUndo.cues.every((cue: { translation: unknown }) => cue.translation === null)).toBe(true);
      // Nothing translated and missing lines refused: the plan blocks before anything is asked or written.
      const blocked = await call(agent, 'export_studio_document', { documentId, revision: afterUndo.document.revision, content: 'target', incomplete: 'block', trackId: track.trackId });
      expect(blocked.value).toMatchObject({ error: 'export_blocked', issues: expect.arrayContaining([expect.objectContaining({ blocking: true })]) });
      await uiExpect(dialog(page)).toBeHidden();
      const rewritten = await call(agent, 'write_studio_translations', { documentId, revision: afterUndo.document.revision, trackId: track.trackId,
        translations: [{ cueId: cueIds[0], text: '早上好' }, { cueId: cueIds[1], text: '天气真好啊' }, { cueId: cueIds[2], text: '明天见' }] });
      expect(rewritten.value).toMatchObject({ written: 3 });
      const reread = (await call(agent, 'read_studio_document', { documentId, trackId: track.trackId })).value;
      expect(reread.cues[2].translation).toEqual({ text: '明天见', origin: 'ai', reviewed: false, stale: false });

      // Export: asked once per connection for exports; a bilingual SRT appears next to the source.
      const before = new Set(await readdir(subtitles));
      const exporting = call(agent, 'export_studio_document', { documentId, revision: rewritten.value.revision, content: 'bilingual' });
      await uiExpect(dialog(page)).toContainText('导出字幕');
      await allow(page).click();
      const exported = (await exporting).value;
      const written = (await readdir(subtitles)).filter(name => !before.has(name));
      expect(written).toEqual([exported.fileName]);
      const file = await readFile(path.join(subtitles, exported.fileName), 'utf8');
      expect(file).toContain('おはよう'); expect(file).toContain('早上好'); expect(file).toContain('明天见');

      // Structure: allowing translation writes does not cover splitting or inserting; each is one undo step.
      const splitting = call(agent, 'split_studio_cue', { documentId, revision: rewritten.value.revision, cueId: cueIds[1], splitBefore: '天気' });
      await uiExpect(dialog(page)).toContainText('修改字幕结构');
      await uiExpect(dialog(page)).toContainText('拆成两条');
      await decline(page).click();
      expect((await splitting).error).toBe('declined_by_user');
      await uiExpect(rows).toHaveCount(3);
      const splitAgain = call(agent, 'split_studio_cue', { documentId, revision: rewritten.value.revision, cueId: cueIds[1], splitBefore: '天気' });
      await uiExpect(dialog(page)).toContainText('拆成两条');
      await uiExpect(dialog(page).getByTestId('external-agent-confirm-items')).toContainText('天気だね');
      await shot(page, 'confirm-split-zh-light-1280');
      await allow(page).click();
      const split = (await splitAgain).value;
      expect(split).toMatchObject({ cueId: expect.any(String), basis: 'proportional' });
      await uiExpect(rows).toHaveCount(4);
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText('いい');
      await uiExpect(rows.nth(2).locator('[data-field=source]')).toHaveText('天気だね');
      const inserting = call(agent, 'insert_studio_cue', { documentId, revision: split.revision, cueId: cueIds[2], position: 'after', startMs: 4000, endMs: 4500, text: '补一句' });
      await uiExpect(dialog(page)).toContainText('之后插入一条新字幕');
      await page.getByText('本次连接内允许此类操作，不再询问').click();
      await allow(page).click();
      const inserted = (await inserting).value;
      expect(inserted).toMatchObject({ cueId: expect.any(String), revision: split.revision + 1 });
      await uiExpect(rows).toHaveCount(5);
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('补一句');
      // Allowed for this connection now.
      const secondInsert = await call(agent, 'insert_studio_cue', { documentId, revision: inserted.revision, cueId: cueIds[0], position: 'before', startMs: 0, endMs: 500, text: 'はじめ' });
      expect(secondInsert.error).toBeNull();
      await uiExpect(dialog(page)).toBeHidden();
      await uiExpect(rows).toHaveCount(6);
      expect((await call(agent, 'insert_studio_cue', { documentId, revision: secondInsert.value.revision, cueId: cueIds[0], position: 'after', startMs: 9000, endMs: 9500, text: 'x' })).error).toBe('invalid_time');
      await uiExpect(undo).toHaveAccessibleName(/插入/);
      for (let step = 0; step < 3; step++) await undo.click();
      await uiExpect(rows).toHaveCount(3);
      const restored = (await call(agent, 'read_studio_document', { documentId, trackId: track.trackId })).value;
      expect(restored.cues.map((cue: { text: string }) => cue.text)).toEqual(['おはよう', 'いい天気だね', 'また明日']);
      exported.revision = restored.document.revision;

      // Auto: writes run silently, but overwriting a file is always asked; declining leaves it alone.
      await setTrust('auto');
      // A plain write runs without asking.
      const silent = await call(agent, 'create_studio_translation_track', { documentId, revision: exported.revision, language: 'en', name: 'English draft' });
      expect(silent.error).toBeNull();
      await uiExpect(dialog(page)).toBeHidden();
      const overwriting = call(agent, 'export_studio_document', { documentId, revision: silent.value.revision, content: 'source', conflict: 'overwrite' });
      await uiExpect(dialog(page)).toContainText('同名文件会被覆盖');
      await uiExpect(page.getByText('本次连接内允许此类操作，不再询问')).toHaveCount(0);
      await shot(page, 'confirm-overwrite-zh-light-1280');
      await decline(page).click();
      expect((await overwriting).error).toBe('declined_by_user');
      expect(await readFile(path.join(subtitles, 'Episode 01.srt'), 'utf8')).toBe(srt(['おはよう', 'いい天気だね', 'また明日']));

      // Translation materials: always asked, saved and enabled on yes.
      const proposing = call(agent, 'prepare_knowledge_changes', { languagePair: { source: 'ja', target: 'zh-Hans' }, collections: [{ ref: 'show', name: '测试番剧' }],
        entries: [
          { action: 'create', collection: { ref: 'show' }, kind: 'term', source: 'おはよう', target: '早上好', basis: 'document' },
          { action: 'create', collection: { ref: 'show' }, kind: 'term', source: '明日', target: '明天', basis: 'agent_inferred' },
          { action: 'create', collection: { ref: 'show' }, kind: 'term', source: 'いい天気', target: '好天气', basis: 'agent_inferred' },
        ] });
      await uiExpect(dialog(page)).toContainText('修改翻译资料');
      await shot(page, 'confirm-knowledge-zh-light-1280');
      await allow(page).click();
      expect((await proposing).value).toMatchObject({ status: 'saved' });
      expect((await call(agent, 'search_translation_knowledge', { query: '好天气' })).value.entries).toHaveLength(1);

      // A second connection is asked again; three requests queue one after another.
      await setTrust('confirm_writes');
      const second = await connect(port, token, 'codex');
      clients.push(second);
      const queued = [
        call(second, 'create_studio_translation_track', { documentId, revision: silent.value.revision, language: 'en' }),
        call(second, 'import_studio_subtitles', { paths: [deep] }),
        call(second, 'import_studio_subtitles', { paths: [subtitles] }),
      ];
      await uiExpect(page.getByTestId('external-agent-confirm-queue')).toHaveText('还有 2 个请求');
      await shot(page, 'confirm-queue-zh-light-1280');
      for (let index = 0; index < 3; index++) { await uiExpect(decline(page)).toBeEnabled(); await decline(page).click(); }
      expect((await Promise.all(queued)).map(result => result.error)).toEqual(['declined_by_user', 'declined_by_user', 'declined_by_user']);

      // Read-only refuses changes in the main process; reads still work.
      await setTrust('read_only');
      expect((await call(second, 'write_studio_translations', { documentId, revision: 1, trackId: track.trackId, translations: [{ cueId: cueIds[0], text: 'x' }] })).error).toBe('read_only');
      expect((await call(second, 'read_studio_document', { documentId })).error).toBeNull();
      await uiExpect(dialog(page)).toBeHidden();

      // Pages, tasks and a transcription runtime that this test profile does not have.
      await call(agent, 'open_fusionkit_page', { page: 'translation_knowledge' });
      expect((await call(agent, 'get_fusionkit_status')).value.currentPage).toBe('/tools/translation-knowledge');
      await setTrust('auto');
      const transcription = await call(agent, 'start_studio_transcription', { paths: [subtitles] });
      expect(['transcription_not_ready', 'subtitle_studio_unavailable']).toContain(transcription.error);
      expect(errors).toEqual([]);

      // After a restart, a document is read straight by its id, without opening Subtitle Studio.
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      await app.close(); app = undefined;
      ({ app, page, errors } = await launch(profile, { lang: 'en', theme: 'dark', size: [900, 700] }));
      const later = await connect(port, token, 'claude-code');
      clients.push(later);
      const direct = (await call(later, 'read_studio_document', { documentId, trackId: track.trackId })).value;
      expect(direct.cues.map((cue: { translation: { text: string } }) => cue.translation.text)).toEqual(['早上好', '天气真好啊', '明天见']);
      expect((await call(later, 'read_studio_document', { documentId: '00000000-0000-4000-8000-0000000000ff' })).error).toBe('document_not_found');

      // English, dark, narrow: the long path list and the destructive variant.
      await page.evaluate(() => window.externalAgent!.updateSettings({ trust: 'confirm_writes' }));
      const englishImport = call(later, 'import_studio_subtitles', { paths: [deep, subtitles] });
      await uiExpect(dialog(page)).toContainText('claude-code wants to import subtitles');
      await shot(page, 'confirm-import-en-dark-900');
      await decline(page).click();
      expect((await englishImport).error).toBe('declined_by_user');
      const englishOverwrite = call(later, 'export_studio_document', { documentId, revision: direct.document.revision, content: 'bilingual', conflict: 'overwrite' });
      await uiExpect(dialog(page)).toContainText('cannot be undone');
      await shot(page, 'confirm-overwrite-en-dark-900');
      await decline(page).click();
      expect((await englishOverwrite).error).toBe('declined_by_user');
      const englishInsert = call(later, 'insert_studio_cue', { documentId, revision: direct.document.revision, cueId: direct.cues[2].cueId, position: 'after', startMs: 4000, endMs: 4600, text: 'A line that was missing from the end of the episode' });
      await uiExpect(dialog(page)).toContainText('claude-code wants to change the subtitle structure');
      await uiExpect(dialog(page)).toContainText('Insert a new line after line 3');
      await shot(page, 'confirm-insert-en-dark-900');
      await decline(page).click();
      expect((await englishInsert).error).toBe('declined_by_user');
      expect(errors).toEqual([]);
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 240_000);
});
