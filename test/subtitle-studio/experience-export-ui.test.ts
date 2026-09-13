import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}
async function option(page: Page, name: string, value: string) {
  await page.getByRole('dialog').getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function exporting(page: Page, batch = false) {
  await page.getByRole('button', { name: batch ? '批量下载' : '下载', exact: true }).click();
  await page.getByRole('menuitem', { name: batch ? '批量导出字幕' : '导出字幕', exact: true }).click();
  const dialog = page.getByRole('dialog'); await uiExpect(dialog).toBeVisible();
  await uiExpect(dialog.getByRole('combobox', { name: '导出内容', exact: true })).toContainText('双语');
  await uiExpect(dialog.getByRole('combobox', { name: '保存位置', exact: true })).toContainText('来源文件所在目录');
  await uiExpect(dialog.getByRole('combobox', { name: '缺失或过期的译文', exact: true })).toContainText('未完成处使用原文');
  await uiExpect(dialog.getByRole('combobox', { name: '文件名后缀', exact: true })).toContainText('无');
  await uiExpect(dialog.getByTestId('studio-selected-documents')).toHaveCount(1);
  expect(await dialog.getByTestId('studio-selected-documents').evaluate(element => element.hasAttribute('open'))).toBe(false);
  return dialog;
}
async function prepare(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '检查导出', exact: true }).click();
  await uiExpect(page.getByRole('dialog').locator('.studio-export-plan')).toBeVisible();
  await uiExpect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
}

describe.runIf(process.env.FUSIONKIT_STUDIO_I5_EXPORT_UI === '1')('I5 export defaults and shared document lists', () => {
  it('uses real tracks, source folders and fallback with one collapsed scope and scroll-aware lists', async () => {
    const artifacts = path.resolve('test-results/studio-i5-export'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const names = ['01-多译轨-跨语言协作记录与长文件名尾部保留-September-Workshop.srt', '02-单译轨.srt', ...Array.from({ length: 6 }, (_, i) => `0${i + 3}-尚未翻译的文档-${i + 1}.srt`)];
    const files: string[] = []; const source = '1\n00:00:01,000 --> 00:00:02,000\nOriginal first line.\n\n2\n00:00:03,000 --> 00:00:04,000\nOriginal second line.\n';
    for (let index = 0; index < names.length; index++) { const directory = path.join(root, `source-${index}`); await mkdir(directory); const file = path.join(directory, names[index]); await writeFile(file, source); files.push(file); }
    let app: ElectronApplication | undefined; let server: Server | undefined; let page: Page | undefined;
    const errors: string[] = []; const requests: string[] = []; const geometry: unknown[] = []; let closed = false;
    const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk.toString();
        const input = JSON.parse(JSON.parse(body).messages[1].content); requests.push(request.url ?? '');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: input.items.map((item: { id: string }) => ({ id: item.id, text: request.url?.includes('older') ? 'Older translation.' : 'Latest translation.' })) }) } }] }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'i5-export-fixture', name: 'Controlled translation', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/older/v1`, modelKey: 'controlled-translation', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'i5-export-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await ready(page); const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      const capture = async (name: string) => {
        await page!.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
        const data = await page!.getByRole('dialog').evaluate(dialog => {
          const box = dialog.getBoundingClientRect(); const footer = dialog.querySelector('[data-slot="scrollable-dialog-footer"]')?.getBoundingClientRect();
          return { dialogLabel: dialog.getAttribute('aria-labelledby'), x: box.x, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: dialog.scrollWidth - dialog.clientWidth, footerBottom: footer?.bottom };
        });
        expect(data.x).toBeGreaterThanOrEqual(0); expect(data.right).toBeLessThanOrEqual(data.width + 1); expect(data.bottom).toBeLessThanOrEqual(data.height + 1); expect(data.overflow).toBeLessThanOrEqual(1); geometry.push({ name, ...data });
        await page!.screenshot({ path: path.join(root, `${name}.png`), animations: 'disabled' });
      };
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result').locator('[data-result-id]')).toHaveCount(0);
      await page.getByTestId('studio-library-result').locator('[data-result-details] > summary').click();
      await uiExpect(page.getByTestId('studio-library-result').locator('[data-result-id]')).toHaveCount(8);
      await capture('01-import-shared-rows-light');
      await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      const documents = await page.evaluate(async () => { const result = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!result.ok) throw new Error(result.error); return result.value.documents; });
      const first = documents.find(doc => doc.origin.displayName === names[0])!; const second = documents.find(doc => doc.origin.displayName === names[1])!;
      let completed = 0;
      for (const [documentId, language, kind] of [[first.id, 'zh', 'older'], [first.id, 'ja', 'latest'], [second.id, 'zh', 'older']]) {
        await page.evaluate(async ({ documentId, language, kind, port }) => {
          const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
          const doc = list.value.documents.find(item => item.id === documentId)!;
          const config = { model: { profileId: 'i5-export-fixture', modelKey: 'controlled-translation', endpoint: `http://127.0.0.1:${port}/${kind}/v1`, apiFormat: 'chat_completions' as const }, language, instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20 };
          const plan = await window.subtitleStudio.planTranslationBatch({ documents: [{ documentId, revision: doc.revision }], config }); if (!plan.ok) throw new Error(plan.error);
          const result = await window.subtitleStudio.createTranslationBatch({ batchId: plan.value.batchId, apiKey: 'synthetic-test-key' }); if (!result.ok || result.value.items.some(item => !item.ok)) throw new Error('Controlled translation admission failed');
        }, { documentId, language, kind, port });
        completed++;
        await uiExpect.poll(() => page!.evaluate(async () => { const result = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 50 }); return result.ok ? result.value.counts.completed : -1; }), { timeout: 20000 }).toBe(completed);
      }
      await page.locator('.studio-document').filter({ hasText: names[0] }).click();
      let dialog = await exporting(page); const scope = dialog.getByTestId('studio-selected-documents');
      await capture('02-defaults-collapsed-light');
      await scope.locator('summary').focus(); await page.keyboard.press('Enter');
      await uiExpect(scope.getByRole('combobox')).toHaveCount(1); await uiExpect(scope.getByRole('combobox')).toContainText('ja');
      await scope.getByRole('combobox').click(); await page.getByRole('option', { name: 'zh · 1', exact: true }).click();
      await prepare(page); await page.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-export-result')).toContainText('已保存 1 份字幕文件');
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      const firstOutput = files[0].replace(/\.srt$/, ' (1).srt'); expect(await readFile(firstOutput, 'utf8')).toContain('Older translation.'); expect(await readFile(firstOutput, 'utf8')).not.toContain('Latest translation.');
      await page.locator('.studio-document').filter({ hasText: names[1] }).click(); dialog = await exporting(page);
      await dialog.getByTestId('studio-selected-documents').locator('summary').click(); await uiExpect(dialog.getByTestId('studio-selected-documents').getByRole('combobox')).toHaveCount(0);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await page.locator('.studio-document').filter({ hasText: names[2] }).click(); dialog = await exporting(page);
      await prepare(page); await uiExpect(dialog.locator('[data-issue="source_fallback"]')).toContainText('2');
      await dialog.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-export-result')).toContainText('已保存 1 份字幕文件');
      await dialog.getByRole('button', { name: '完成', exact: true }).click(); await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await readFile(files[2].replace(/\.srt$/, ' (1).srt'), 'utf8')).toBe(source + '\n');
      for (const name of names) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
      dialog = await exporting(page, true); await capture('03-batch-defaults-light');
      const batchScope = dialog.getByTestId('studio-selected-documents'); await batchScope.locator('summary').focus(); await page.keyboard.press('Space');
      await uiExpect(batchScope.getByRole('combobox')).toHaveCount(1); await uiExpect(batchScope.locator('.studio-document-row')).toHaveCount(8);
      const fade = batchScope.locator('.studio-scroll-fade'); const viewport = fade.locator('.studio-scroll-fade-viewport');
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'false'); await uiExpect(fade).toHaveAttribute('data-fade-bottom', 'true');
      expect(await fade.locator('.studio-scroll-fade-edge').first().evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
      await capture('04-batch-tracks-scroll-light');
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'true'); await uiExpect(fade).toHaveAttribute('data-fade-bottom', 'false');
      await win.evaluate(window => window.setSize(786, 540)); await page.evaluate(() => document.documentElement.classList.add('dark'));
      await batchScope.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await capture('05-batch-scroll-narrow-dark');
      await viewport.evaluate(element => { element.scrollTop = 0; }); await batchScope.getByRole('combobox').click(); await page.getByRole('option', { name: 'zh · 1', exact: true }).click();
      await prepare(page);
      await uiExpect(dialog.locator('.studio-document-row')).toHaveCount(0);
      const reviewScope = dialog.getByTestId('studio-export-review-details');
      await reviewScope.locator('summary').click();
      await uiExpect(reviewScope.locator('.studio-document-row[data-state="ready"]')).toHaveCount(8);
      await reviewScope.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await capture('06-batch-plan-narrow-dark');
      await dialog.getByRole('button', { name: '确认并导出 8 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-result')).toContainText('已保存 8 份字幕文件');
      await uiExpect(page.getByTestId('studio-batch-result').locator('[data-result-id]')).toHaveCount(0);
      await page.getByTestId('studio-batch-result').locator('[data-result-details] > summary').click();
      await uiExpect(page.getByTestId('studio-batch-result').locator('[data-state="success"]')).toHaveCount(8); await capture('07-batch-result-narrow-dark');
      expect(await readFile(files[0].replace(/\.srt$/, ' (2).srt'), 'utf8')).toContain('Older translation.');
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await win.evaluate(window => window.setSize(1280, 860));
      await page.locator('.studio-document').filter({ hasText: names[3] }).click();
      await rename(files[3], `${files[3]}.moved`); dialog = await exporting(page);
      await uiExpect(dialog).toContainText('来源目录不可用'); await prepare(page);
      await uiExpect(dialog.getByRole('button', { name: '确认并导出 0 份', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: '返回设置', exact: true }).click();
      await dialog.getByTestId('studio-selected-documents').locator('summary').click();
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, path.dirname(files[3]));
      await dialog.getByRole('button', { name: '重新指定来源目录…', exact: true }).click(); await uiExpect(page.getByTestId('studio-source-location')).toHaveAttribute('data-state', 'ready');
      await prepare(page); await uiExpect(dialog.getByRole('button', { name: '确认并导出 1 份', exact: true })).toBeEnabled(); await capture('08-source-rebind-dark');
      await dialog.getByRole('button', { name: '取消', exact: true }).click(); await rename(`${files[3]}.moved`, files[3]);
      await page.getByRole('button', { name: '查看全部', exact: true }).click();
      await uiExpect(page.getByTestId('studio-translation-overview-list').locator('.studio-document-row')).toHaveCount(3);
      await capture('09-translation-overview-shared-rows-dark');
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '批量翻译', exact: true }).click();
      await page.getByRole('dialog').getByTestId('studio-selected-documents').locator('summary').click();
      await uiExpect(page.getByRole('dialog').locator('.studio-document-row')).toHaveCount(8);
      await capture('10-translation-scope-shared-rows-dark');
      await page.getByRole('dialog').getByRole('button', { name: '计算用量', exact: true }).click();
      await uiExpect(page.getByRole('dialog').getByTestId('studio-batch-plan').locator('.studio-document-row')).toHaveCount(8);
      await capture('11-translation-plan-shared-rows-dark');
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      expect(requests).toHaveLength(3); expect(errors).toEqual([]);
      for (const file of files) expect(digest(await readFile(file))).toBe(digest(source));
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ geometry, pageErrors: errors, controlledTranslationRequests: requests, defaults: ['bilingual', 'source-directory', 'source-fallback'], realSourceHashesPreserved: true, selectedOlderTrackExported: true, realBatchOutputs: 8,
        productionMainSha256: digest(await readFile('dist-electron/main/index.js')), preloadSha256: digest(await readFile('dist-electron/preload/index.mjs')), rendererHtmlSha256: digest(await readFile('dist/index.html')) }, null, 2));
    } catch (error) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), animations: 'disabled' }).catch(() => {}); throw error;
    } finally {
      try { await app?.close(); closed = true; } finally {
        await new Promise<void>(resolve => { if (!server) resolve(); else { server.closeAllConnections(); server.close(() => resolve()); } });
        if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped owned test root');
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: closed, serverClosed: true, profileRemoved: true }));
      }
    }
  }, 240000);
});
