import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { Encoding } from '../../src/subtitle-studio/domain';
import type { DocumentPage } from '../../src/subtitle-studio/ipc-contract';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio local export workspace', () => {
  let app: ElectronApplication | undefined;
  let server: Server | undefined;
  let root: string;
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('exports separated tracks without model calls, explains losses, and saves a frozen revision', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-export-ui-'));
    const userData = path.join(root, 'profile');
    const artifacts = path.resolve('test-results/subtitle-studio-export');
    await mkdir(artifacts, { recursive: true });
    let modelRequests = 0;
    server = createServer((_request, response) => { modelRequests++; response.writeHead(500); response.end('Unexpected model request during local export'); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const sourceLines = ['Hello world.', 'The light is on.', 'We can leave now.', 'One more line.'];
    const targetLines = ['你好世界。', '灯已经亮了。', '我们现在可以走了。'];
    const original = `[ti:Local export fixture]\n${sourceLines.map((text, index) => `[00:0${index}.000]${text}${targetLines[index] ? `\n[00:0${index}.000]${targetLines[index]}` : ''}`).join('\n')}\n`;
    const input = path.join(root, '字幕工作台-整理后的双语导出-September-2026.lrc');
    await writeFile(input, original);
    const errors: string[] = [];
    const openStudio = async (page: Page) => {
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    };
    const launch = async () => {
      app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await openStudio(page);
      return page;
    };
    const snapshot = async (page: Page): Promise<DocumentPage> => page.evaluate(async () => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 });
      if (!list.ok) throw new Error(list.error);
      const document = list.value.documents[0];
      const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
    const parsedFile = async (file: string, format: 'lrc' | 'srt', encoding: Encoding = 'utf-8') => {
      const bytes = await readFile(file);
      const { text, bom } = decodeSubtitle(bytes, encoding);
      return { bytes, text, document: importSubtitleText(text, {
        format, encoding, displayName: path.basename(file), digest: createHash('sha256').update(bytes).digest('hex'),
      }, randomUUID, bom) };
    };
    let page = await launch();
    await page.evaluate(port => {
      localStorage.setItem('lang', 'zh');
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
      localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{
        id: 'studio-export-unused-model', name: 'Export must not use this model', provider: 'Other', apiKey: 'synthetic-key',
        baseUrl: `http://127.0.0.1:${port}`, modelKey: 'unused', apiFormat: 'chat_completions',
        tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
      }], assignment: { taskExecution: 'studio-export-unused-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
    }, port);
    await page.reload(); await openStudio(page);
    let window = await app!.browserWindow(page); await window.evaluate(win => win.setSize(1280, 860));
    await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    const bilingualDialog = page.getByRole('dialog', { name: '整理双语字幕', exact: true });
    await uiExpect(bilingualDialog).toBeVisible();
    await uiExpect(page.locator('.studio-bilingual-candidates > li')).toHaveCount(3);
    await bilingualDialog.getByRole('button', { name: '确认整理', exact: true }).click();
    await uiExpect(bilingualDialog).toHaveCount(0);
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);
    const organized = await snapshot(page);
    expect(organized.cues.map(cue => cue.source.plain)).toEqual(sourceLines);
    expect(organized.translationTracks).toHaveLength(1);

    const exportDialog = () => page.getByRole('dialog', { name: '导出字幕', exact: true });
    const openExport = async () => {
      await page.getByRole('button', { name: '导出字幕', exact: true }).click();
      await uiExpect(exportDialog()).toBeVisible();
      await uiExpect(exportDialog().getByRole('combobox', { name: '导出内容', exact: true })).toBeFocused();
    };
    const select = async (name: string, value: string) => {
      await exportDialog().getByRole('combobox', { name, exact: true }).click();
      await page.getByRole('option', { name: value, exact: true }).click();
    };
    const check = async () => {
      await exportDialog().getByRole('button', { name: '检查导出', exact: true }).click();
      await uiExpect(page.locator('.studio-export-plan')).toBeVisible();
    };
    const acceptLosses = async () => {
      const checkbox = exportDialog().getByRole('checkbox', { name: '接受以上格式变化', exact: true });
      if (await checkbox.count()) await checkbox.check();
    };
    const saveFile = async (name: string) => {
      const file = path.join(root, name);
      await app!.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
      await exportDialog().getByRole('button', { name: '保存字幕…', exact: true }).click();
      await uiExpect(exportDialog()).toHaveCount(0);
      return file;
    };
    const originalDownload = path.join(root, 'original-evidence.lrc');
    await app!.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, originalDownload);
    await page.getByRole('button', { name: '下载原文件', exact: true }).click();
    await uiExpect.poll(async () => readFile(originalDownload, 'utf8').catch(() => '')).toBe(original);

    await openExport();
    await page.keyboard.press('Escape');
    await uiExpect(exportDialog()).toHaveCount(0);
    await uiExpect(page.getByRole('button', { name: '导出字幕', exact: true })).toBeFocused();
    await openExport();
    await check();
    await uiExpect(page.locator('[data-issue="metadata_omitted"]')).toBeVisible();
    await uiExpect(exportDialog().getByRole('button', { name: '保存字幕…', exact: true })).toBeDisabled();
    await acceptLosses();
    await exportDialog().locator('.studio-export-advanced summary').click();
    await select('文件编码', 'GB18030');
    await uiExpect(page.locator('.studio-export-plan')).toHaveCount(0);
    await uiExpect(exportDialog().getByRole('checkbox', { name: '添加 Unicode BOM', exact: true })).toBeDisabled();
    await select('文件编码', 'UTF-8');
    await exportDialog().locator('.studio-export-advanced summary').click();
    await check();
    await uiExpect(exportDialog().getByRole('checkbox', { name: '接受以上格式变化', exact: true })).not.toBeChecked();
    await acceptLosses();
    const selectedRevision = await page.locator('.studio-export-plan').getAttribute('data-revision');
    await app!.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
    await exportDialog().getByRole('button', { name: '保存字幕…', exact: true }).click();
    await uiExpect(exportDialog().getByRole('button', { name: '保存字幕…', exact: true })).toBeEnabled();
    await uiExpect(page.locator('.studio-export-plan')).toHaveAttribute('data-revision', selectedRevision!);
    await page.screenshot({ path: path.join(artifacts, 'source-desktop.png'), animations: 'disabled' });
    const sourceLrc = await parsedFile(await saveFile('source.lrc'), 'lrc');
    expect(sourceLrc.document.cues.map(cue => cue.source.plain)).toEqual(sourceLines);
    expect(sourceLrc.text).not.toContain(targetLines[0]);

    // All transformed modes still work after reopening the same document library.
    await app!.close(); app = undefined;
    page = await launch();
    window = await app!.browserWindow(page); await window.evaluate(win => win.setSize(1280, 860));
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);
    for (const format of ['lrc', 'srt'] as const) {
      for (const mode of ['source', 'target', 'bilingual'] as const) {
        if (format === 'lrc' && mode === 'source') continue;
        await openExport();
        await select('导出内容', { source: '仅原文', target: '仅译文', bilingual: '双语' }[mode]);
        await select('字幕格式', format.toUpperCase());
        if (mode !== 'source') {
          await select('缺失或过期的译文', '阻止导出，等待译文完整');
          await check();
          await uiExpect(page.locator('[data-issue="translation_missing"]')).toContainText('1 条');
          await uiExpect(exportDialog().getByRole('button', { name: '保存字幕…', exact: true })).toHaveCount(0);
          await select('缺失或过期的译文', '仅导出已有有效译文的字幕');
        }
        if (format === 'srt') {
          const estimate = exportDialog().getByRole('checkbox', { name: '允许估算缺失的结束时间', exact: true });
          await estimate.uncheck();
          await check();
          await uiExpect(page.locator('[data-issue="missing_end"]')).toBeVisible();
          await estimate.check();
          await exportDialog().getByRole('spinbutton', { name: '最后一组时长（毫秒）', exact: true }).fill('2500');
        }
        if (mode === 'bilingual') await select('双语顺序', '译文在前');
        await check();
        await uiExpect(page.locator('.studio-export-plan')).toHaveAttribute('data-partial', String(mode !== 'source'));
        await acceptLosses();
        const result = await parsedFile(await saveFile(`${mode}.${format}`), format);
        const expected = mode === 'source' ? sourceLines : mode === 'target' ? targetLines : targetLines.flatMap((line, index) => format === 'lrc' ? [line, sourceLines[index]] : [`${line}\n${sourceLines[index]}`]);
        expect(result.document.cues.map(cue => cue.source.plain)).toEqual(expected);
        if (format === 'srt') {
          expect(result.document.cues.map(cue => cue.timing.endMs)).toEqual(mode === 'source' ? [1000, 2000, 3000, 5500] : [1000, 2000, 3000]);
        } else if (mode === 'bilingual') expect(result.document.cues.map(cue => cue.timing.startMs)).toEqual([0, 0, 1000, 1000, 2000, 2000]);
      }
    }
    expect((await snapshot(page)).summary.revision).toBe(organized.summary.revision);
    expect(modelRequests).toBe(0);

    await page.evaluate(() => { localStorage.setItem('lang', 'en'); });
    await page.reload(); await openStudio(page);
    await window.evaluate(win => win.setSize(786, 540));
    await page.getByRole('button', { name: 'Export subtitles', exact: true }).click();
    const englishDialog = page.getByRole('dialog', { name: 'Export subtitles', exact: true });
    await englishDialog.getByRole('combobox', { name: 'Content', exact: true }).click();
    await page.getByRole('option', { name: 'Bilingual', exact: true }).click();
    expect(await englishDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'bilingual-english-narrow.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
    await page.reload(); await openStudio(page);
    await window.evaluate(win => win.setSize(786, 540));
    await openExport();
    await select('导出内容', '双语');
    await select('字幕格式', 'srt'.toUpperCase());
    await select('缺失或过期的译文', '未完成处使用原文');
    await exportDialog().getByRole('checkbox', { name: '允许估算缺失的结束时间', exact: true }).check();
    await exportDialog().locator('.studio-export-advanced summary').click();
    await select('文件编码', 'UTF-16LE');
    await select('换行方式', 'CRLF');
    await exportDialog().getByRole('checkbox', { name: '添加 Unicode BOM', exact: true }).check();
    await check();
    await uiExpect(page.locator('[data-issue="source_fallback"]')).toContainText('1 条');
    await acceptLosses();
    const viewport = exportDialog().locator('[data-slot="scroll-area-viewport"]');
    await viewport.evaluate(element => { element.scrollTop = 0; });
    expect(await exportDialog().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await exportDialog().getByRole('button', { name: '保存字幕…', exact: true }).evaluate(element => {
      const bounds = element.getBoundingClientRect(); return bounds.bottom <= globalThis.innerHeight && bounds.top >= 0;
    })).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'bilingual-dark-narrow-options.png'), animations: 'disabled' });
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(artifacts, 'bilingual-dark-narrow-check.png'), animations: 'disabled' });
    const fallback = await parsedFile(await saveFile('fallback-utf16.srt'), 'srt', 'utf-16le');
    expect(fallback.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(fallback.text).toContain('\r\n');
    expect(fallback.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(fallback.document.cues).toHaveLength(4);
    expect(fallback.document.cues[3].source.plain).toContain(sourceLines[3]);

    await openExport();
    await select('导出内容', '仅译文');
    await select('字幕格式', 'LRC');
    await select('缺失或过期的译文', '仅导出已有有效译文的字幕');
    await exportDialog().locator('.studio-export-advanced summary').click();
    await select('文件编码', 'UTF-8');
    await exportDialog().getByRole('checkbox', { name: '添加 Unicode BOM', exact: true }).uncheck();
    await check(); await acceptLosses();
    const frozenRevision = await page.locator('.studio-export-plan').getAttribute('data-revision');
    const frozenFile = path.join(root, 'frozen-target.lrc');
    await app!.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => new Promise(resolve => {
        (globalThis as typeof globalThis & { studioExportSave?: typeof resolve }).studioExportSave = resolve;
      });
    });
    await exportDialog().getByRole('button', { name: '保存字幕…', exact: true }).click();
    await uiExpect.poll(() => app!.evaluate(() => !!(globalThis as typeof globalThis & { studioExportSave?: unknown }).studioExportSave)).toBe(true);
    const beforeClear = await snapshot(page);
    await page.evaluate(async ({ summary, translationTracks }) => {
      const result = await window.subtitleStudio.removeTranslationTrack({ documentId: summary.id, revision: summary.revision, trackId: translationTracks[0].id });
      if (!result.ok) throw new Error(result.error);
    }, beforeClear);
    await uiExpect(page.locator('.studio-export-frozen')).toBeVisible();
    await uiExpect(page.locator('.studio-export-plan')).toHaveAttribute('data-revision', frozenRevision!);
    await app!.evaluate((_electron, file) => {
      const globals = globalThis as typeof globalThis & { studioExportSave?: (result: { canceled: boolean; filePath: string }) => void };
      globals.studioExportSave!({ canceled: false, filePath: file }); delete globals.studioExportSave;
    }, frozenFile);
    await uiExpect(exportDialog()).toHaveCount(0);
    expect((await parsedFile(frozenFile, 'lrc')).document.cues.map(cue => cue.source.plain)).toEqual(targetLines);
    await openExport();
    await select('导出内容', '仅译文');
    await check();
    await uiExpect(page.locator('[data-issue="track_missing"]')).toBeVisible();
    await uiExpect(exportDialog().getByRole('button', { name: '保存字幕…', exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'missing-track-dark-narrow.png'), animations: 'disabled' });
    await select('导出内容', '仅原文');
    await check(); await acceptLosses();
    expect((await parsedFile(await saveFile('source-after-clear.lrc'), 'lrc')).document.cues.map(cue => cue.source.plain)).toEqual(sourceLines);
    expect((await snapshot(page)).cues.every(cue => cue.timing.endMs === null)).toBe(true);
    expect(await readFile(input, 'utf8')).toBe(original);
    expect(modelRequests).toBe(0);
    expect(errors).toEqual([]);
  }, 240000);
});
