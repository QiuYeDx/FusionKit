import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

const enabled = process.env.FUSIONKIT_STUDIO_I3_UI === '1';
const vtt = 'WEBVTT\n\nNOTE keep-note\nThis is private format metadata.\n\nSTYLE\n::cue { color: lime; }\n\nscene-one\n00:00:01.000 --> 00:00:03.000 align:start position:20%\n<b>Hello</b> from the workshop.\n';
const ass = '[Script Info]\nTitle: keep-ass-title\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,keep-comment\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Another scene, with detail.\n';

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}
async function selectOption(page: Page, name: string, value: string) {
  await page.getByRole('dialog').getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function openExport(page: Page, batch = false) {
  await page.getByRole('button', { name: batch ? '批量下载' : '下载', exact: true }).click();
  await page.getByRole('menuitem', { name: batch ? '批量导出字幕' : '导出字幕', exact: true }).click();
  await page.getByRole('dialog').waitFor();
}
async function prepareAndAccept(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '检查导出', exact: true }).click();
  await uiExpect(page.getByRole('dialog').locator('.studio-export-plan')).toBeVisible();
  const acknowledgement = page.getByRole('dialog').getByRole('checkbox', { name: '接受以上格式变化', exact: true });
  if (await acknowledgement.count()) await acknowledgement.check();
}

describe.runIf(enabled)('I3 native files, format preservation and export UI', () => {
  it('imports real dropped Files, translates VTT/ASS, exports to separate source folders and restores locations', async () => {
    const artifacts = path.resolve('test-results/studio-i3-files'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const a = path.join(root, 'A'), b = path.join(root, 'B'); await mkdir(a); await mkdir(b);
    const vttFile = path.join(a, 'Session.vtt'), assFile = path.join(b, 'Dialogue.ass'), badFile = path.join(root, 'notes.txt');
    await writeFile(vttFile, vtt); await writeFile(assFile, ass); await writeFile(badFile, 'Not subtitles');
    const profile = path.join(root, 'profile');
    const requests: unknown[] = []; const pageErrors: string[] = [];
    let app: ElectronApplication | undefined; let server: Server | undefined;
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk.toString();
        const parsed = JSON.parse(body); requests.push(parsed);
        const payload = JSON.parse(parsed.messages[1].content);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: item.text.replace(/<[^>]*>|[^<>]+/g, part => part.startsWith('<') ? part : '这是经过翻译的字幕。') })) }) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      let page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
      await page.reload(); await ready(page);
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.dataset.studioDropFixture = ''; document.body.append(input); });
      await page.locator('[data-studio-drop-fixture]').setInputFiles([vttFile, assFile, badFile]);
      await page.evaluate(() => {
        const files = (document.querySelector('[data-studio-drop-fixture]') as HTMLInputElement).files!;
        const transfer = new DataTransfer(); Array.from(files).forEach(file => transfer.items.add(file));
        document.querySelector('[data-testid=subtitle-studio]')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await uiExpect(page.getByTestId('studio-drop-overlay')).toContainText('松开以导入字幕');
      await page.screenshot({ path: path.join(root, '01-native-drop-light.png'), animations: 'disabled' });
      await page.evaluate(() => {
        const files = (document.querySelector('[data-studio-drop-fixture]') as HTMLInputElement).files!;
        const transfer = new DataTransfer(); Array.from(files).forEach(file => transfer.items.add(file));
        document.querySelector('[data-testid=subtitle-studio]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await uiExpect(page.getByTestId('studio-library-result')).toContainText('Session.vtt');
      await uiExpect(page.getByRole('dialog', { name: '导入结果' })).toContainText('成功 2 份');
      await uiExpect(page.getByRole('dialog', { name: '导入结果' })).toContainText('失败 1 份');
      await page.getByRole('dialog', { name: '导入结果' }).getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('[data-studio-drop-fixture]').evaluate(element => element.remove());
      const imported = await page.evaluate(async () => {
        const result = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!result.ok) throw new Error(result.error); return result.value.documents;
      });
      expect(imported.map(doc => doc.origin.format).sort()).toEqual(['ass', 'vtt']);
      const refs = imported.map(doc => ({ documentId: doc.id, revision: doc.revision }));
      await page.evaluate(async ({ refs, port }) => {
        const config = { model: { profileId: 'i3-fixture', modelKey: 'controlled-translation', endpoint: `http://127.0.0.1:${port}/v1`, apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
        const planned = await window.subtitleStudio.planTranslationBatch({ documents: refs, config }); if (!planned.ok) throw new Error(planned.error);
        const started = await window.subtitleStudio.createTranslationBatch({ batchId: planned.value.batchId, apiKey: 'synthetic-test-key' }); if (!started.ok) throw new Error(started.error);
        if (started.value.items.some(item => !item.ok)) throw new Error('Translation admission failed.');
      }, { refs, port });
      await uiExpect.poll(() => page.evaluate(async () => { const result = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 50 }); return result.ok ? result.value.counts.completed : -1; }), { timeout: 20000 }).toBe(2);
      await uiExpect(page.locator('.studio-cue-table')).toContainText('这是经过翻译的字幕。');
      expect(requests).toHaveLength(2);
      for (const marker of ['keep-comment', 'keep-note', '\\an8', 'V4+ Styles']) expect(JSON.stringify(requests)).not.toContain(marker);
      await page.screenshot({ path: path.join(root, '02-translated-workspace-light.png'), animations: 'disabled' });

      await page.locator('.studio-document').filter({ hasText: 'Session.vtt' }).click();
      await openExport(page); await selectOption(page, '导出内容', '双语'); await selectOption(page, '字幕格式', 'VTT');
      await selectOption(page, '保存位置', '来源文件所在目录');
      await uiExpect(page.getByTestId('studio-source-location')).toHaveAttribute('data-state', 'ready');
      await uiExpect(page.getByRole('combobox', { name: '文件名后缀', exact: true })).toContainText('无');
      await prepareAndAccept(page);
      await uiExpect(page.getByTestId('studio-export-file-name')).toContainText('Session.vtt');
      await page.screenshot({ path: path.join(root, '03-vtt-source-export.png'), animations: 'disabled' });
      await page.getByRole('button', { name: '保存到来源目录', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      const vttOutput = await readFile(path.join(a, 'Session (1).vtt'), 'utf8');
      expect(vttOutput).toContain('NOTE keep-note'); expect(vttOutput).toContain('align:start position:20%'); expect(vttOutput).toContain('这是经过翻译的字幕。');
      expect(await readFile(vttFile, 'utf8')).toBe(vtt);

      await page.locator('.studio-document').filter({ hasText: 'Dialogue.ass' }).click();
      await openExport(page); await selectOption(page, '导出内容', '仅译文'); await selectOption(page, '字幕格式', 'ASS');
      await selectOption(page, '保存位置', '来源文件所在目录'); await selectOption(page, '文件名后缀', '自定义');
      await page.getByRole('textbox', { name: '自定义后缀', exact: true }).fill('../bad');
      await uiExpect(page.getByRole('button', { name: '检查导出', exact: true })).toBeDisabled();
      await page.getByRole('textbox', { name: '自定义后缀', exact: true }).fill('zh-CN');
      await prepareAndAccept(page);
      await uiExpect(page.getByTestId('studio-export-file-name')).toContainText('Dialogue.zh-CN.ass');
      await nativeWindow.evaluate(win => win.setSize(786, 540));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.waitForFunction(() => innerHeight <= 540);
      await uiExpect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(540);
      const dialogBox = await page.getByRole('dialog').boundingBox(); expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      await page.screenshot({ path: path.join(root, '04-ass-custom-export-narrow-dark.png'), animations: 'disabled' });
      await page.getByRole('button', { name: '保存到来源目录', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      const assOutput = await readFile(path.join(b, 'Dialogue.zh-CN.ass'), 'utf8');
      expect(assOutput).toContain('[V4+ Styles]'); expect(assOutput).toContain('keep-comment'); expect(assOutput).toContain('{\\an8}'); expect(assOutput).toContain('这是经过翻译的字幕。'); expect(assOutput).not.toContain('Another scene');
      expect(await readFile(assFile, 'utf8')).toBe(ass);

      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      for (const name of ['Session.vtt', 'Dialogue.ass']) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
      await openExport(page, true); await selectOption(page, '保存位置', '来源文件所在目录'); await selectOption(page, '字幕格式', 'SRT');
      await selectOption(page, '导出内容', '双语'); await prepareAndAccept(page);
      await page.getByRole('button', { name: '导出 2 份就绪文档', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-result')).toContainText('Session.srt');
      await uiExpect(page.getByTestId('studio-batch-result')).toContainText('Dialogue.srt');
      expect(await readFile(path.join(a, 'Session.srt'), 'utf8')).toContain('这是经过翻译的字幕。');
      expect(await readFile(path.join(b, 'Dialogue.srt'), 'utf8')).toContain('这是经过翻译的字幕。');
      await page.screenshot({ path: path.join(root, '05-batch-separate-source-folders.png'), animations: 'disabled' });
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '下载', exact: true }).click(); await page.getByRole('menuitem', { name: '下载原文件', exact: true }).click();
      await selectOption(page, '保存位置', '来源文件所在目录'); await page.getByRole('button', { name: '保存到来源目录', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await readFile(path.join(b, 'Dialogue (1).ass'), 'utf8')).toBe(ass);

      await app.close(); app = undefined;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      const locations = await page.evaluate(async ids => {
        const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
        return Promise.all(ids.map(documentId => window.subtitleStudio.getSourceLocation({ documentId })));
      }, refs.map(ref => ref.documentId));
      expect(locations).toEqual([{ ok: true, value: { status: 'ready', origin: 'input' } }, { ok: true, value: { status: 'ready', origin: 'input' } }]);
      // A historical document has no private source receipt. Its content remains usable,
      // and only a native directory selection may establish a new binding.
      const vttId = imported.find(doc => doc.origin.format === 'vtt')!.id;
      const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
      expect(path.resolve(actualProfile)).toBe(path.resolve(profile));
      await rm(path.join(actualProfile, 'subtitle-studio', 'documents', vttId, 'source-location.private.json'));
      await page.locator('.studio-document').filter({ hasText: 'Session.vtt' }).click();
      await openExport(page); await selectOption(page, '保存位置', '来源文件所在目录');
      await uiExpect(page.getByTestId('studio-source-location')).toHaveAttribute('data-state', 'missing');
      await prepareAndAccept(page);
      await uiExpect(page.getByRole('button', { name: '保存到来源目录', exact: true })).toBeDisabled();
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, a);
      await page.getByRole('button', { name: '重新指定来源目录…', exact: true }).click();
      await uiExpect(page.getByTestId('studio-source-location')).toHaveAttribute('data-state', 'ready');
      await uiExpect(page.getByRole('dialog')).toContainText('使用你重新指定的来源目录');
      await uiExpect(page.getByRole('button', { name: '检查导出', exact: true })).toBeEnabled();
      await prepareAndAccept(page);
      await page.screenshot({ path: path.join(root, '06-historical-source-rebound.png'), animations: 'disabled' });
      await page.getByRole('button', { name: '保存到来源目录', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await readFile(vttFile, 'utf8')).toBe(vtt);
      expect(pageErrors).toEqual([]); expect(requests).toHaveLength(2);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ nativeFileDrop: true, partialImport: '2 success / 1 rejected', controlledTranslationRequests: requests.length, sourceDirectories: 'independent', reload: '2 sources ready', historicalSourceRecovery: 'native rebind and re-plan verified', originalBytes: { vtt: createHash('sha256').update(vtt).digest('hex'), ass: createHash('sha256').update(ass).digest('hex') }, pageErrors }, null, 2));
    } finally {
      try { await app?.close(); } finally {
        await new Promise<void>(resolve => { if (!server) resolve(); else { server.closeAllConnections(); server.close(() => resolve()); } });
        if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped test root.');
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }
  }, 300000);
});
