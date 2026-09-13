import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

async function select(page: Page, label: string, value: string) {
  await page.getByRole('dialog').getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function openExport(page: Page, batch = false, original = false) {
  await page.getByRole('button', { name: batch ? '批量下载' : '下载', exact: true }).click();
  await page.getByRole('menuitem', { name: original ? batch ? '批量下载原文件' : '下载原文件' : batch ? '批量导出字幕' : '导出字幕', exact: true }).click();
  await uiExpect(page.getByRole('dialog').locator('[data-step="settings"]')).toBeVisible();
}
async function review(page: Page, count: number) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '检查导出', exact: true }).click();
  await uiExpect(dialog).toHaveAccessibleName('确认导出');
  await uiExpect(dialog.locator('[data-step="review"]')).toBeVisible();
  await uiExpect(dialog.getByRole('heading', { name: '确认导出', exact: true })).toBeFocused();
  await uiExpect(dialog.getByRole('combobox')).toHaveCount(0);
  await uiExpect(dialog.getByRole('checkbox')).toHaveCount(0);
  await uiExpect(dialog.locator('.studio-document-row')).toHaveCount(0);
  await uiExpect(dialog.getByRole('button', { name: `确认并导出 ${count} 份`, exact: true })).toBeVisible();
}
async function closeResult(page: Page, successCount: number, testId = 'studio-export-result') {
  const result = page.getByTestId(testId);
  await uiExpect(result).toHaveAttribute('data-outcome', 'success');
  await uiExpect(result.locator('[data-result-id]')).toHaveCount(successCount === 1 ? 1 : 0);
  if (successCount === 1) await uiExpect(result.locator('[data-result-details]')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await uiExpect(page.getByRole('dialog')).toHaveCount(0);
}

describe.runIf(process.env.FUSIONKIT_STUDIO_I6_EXPORT_UI === '1')('I6 explicit export review and concise operation results', () => {
  it('keeps real plans guarded across back, cancel, expiry, partial blocking and original byte downloads', async () => {
    const artifacts = path.resolve('test-results/studio-i6-export'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const names = ['01-跨语言研讨记录与较长的文档名称-September-Workshop.srt', '02-独立来源目录.srt', '03-缺少结束时间.lrc'];
    const sourceText = '1\n00:00:01,000 --> 00:00:02,000\nOriginal first line.\n\n2\n00:00:03,000 --> 00:00:04,000\nOriginal second line.\n';
    const sourceBytes = [Buffer.from(sourceText), Buffer.from(sourceText), Buffer.from('\ufeff[00:01.00]Missing end time.\n')];
    const files: string[] = [];
    for (let index = 0; index < names.length; index++) { const directory = path.join(root, `s${index}`); await mkdir(directory); const file = path.join(directory, names[index]); await writeFile(file, sourceBytes[index]); files.push(file); }
    let app: ElectronApplication | undefined; let page: Page | undefined; let closed = false;
    const pageErrors: string[] = []; const geometry: unknown[] = [];
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      const capture = async (name: string) => {
        await page!.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
        const data = await page!.getByRole('dialog').evaluate(dialog => {
          const box = dialog.getBoundingClientRect();
          const done = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === '完成');
          const footer = (done?.parentElement ?? dialog.querySelector(':scope > .contents > .border-t'))!.getBoundingClientRect();
          return { x: box.x, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: dialog.scrollWidth - dialog.clientWidth, footerBottom: footer.bottom };
        });
        expect(data.x).toBeGreaterThanOrEqual(0); expect(data.right).toBeLessThanOrEqual(data.viewportWidth + 1); expect(data.bottom).toBeLessThanOrEqual(data.viewportHeight + 1); expect(data.footerBottom).toBeLessThanOrEqual(data.viewportHeight + 1); expect(data.overflow).toBeLessThanOrEqual(1);
        geometry.push({ name, ...data }); await page!.screenshot({ path: path.join(root, `${name}.png`), animations: 'disabled' });
      };
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await uiExpect(page.getByTestId('studio-library-result').locator('[data-result-id]')).toHaveCount(0);
      await capture('01-import-result-light');
      await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      await page.locator('.studio-document').filter({ hasText: names[0] }).click();
      await openExport(page);
      const scope = page.getByTestId('studio-selected-documents');
      expect(await scope.evaluate(element => element.hasAttribute('open'))).toBe(false);
      expect(await scope.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('[data-testid="studio-export-advanced"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      await scope.locator('summary').focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
      const baseline = await scope.locator('.studio-document-row').evaluate(row => {
        const number = row.querySelector('.studio-document-row-number')!;
        const name = row.querySelector('.studio-file-name-start') ?? row.querySelector('.studio-file-name')!;
        const glyphBounds = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
        const a = glyphBounds(number), b = glyphBounds(name);
        return { numberBottom: a.bottom, nameBottom: b.bottom, actionHeight: row.querySelector('button')!.getBoundingClientRect().height };
      });
      expect(Math.abs(baseline.numberBottom - baseline.nameBottom)).toBeLessThanOrEqual(2); expect(baseline.actionHeight).toBe(32); geometry.push({ baseline });
      await capture('02-settings-documents-before-encoding-light');
      await review(page, 1); await capture('03-review-summary-light');
      expect(await readdir(path.dirname(files[0]))).toEqual([names[0]]);
      await page.getByRole('button', { name: '返回设置', exact: true }).click();
      await uiExpect(page.getByRole('dialog').locator('.studio-export-plan')).toHaveCount(0);
      await uiExpect(page.getByRole('button', { name: '检查导出', exact: true })).toBeVisible();
      await select(page, '保存位置', '选择其他位置'); await review(page, 1);
      await app.evaluate(({ dialog }) => {
        const state = globalThis as typeof globalThis & { i6SaveCalls?: number }; state.i6SaveCalls = 0;
        dialog.showSaveDialog = async () => { state.i6SaveCalls!++; return { canceled: true, filePath: '' }; };
      });
      const selectedRevision = await page.getByTestId('studio-export-review').getAttribute('data-revision');
      await page.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
      await uiExpect(page.getByRole('button', { name: '确认并导出 1 份', exact: true })).toBeEnabled();
      await uiExpect(page.getByTestId('studio-export-review')).toHaveAttribute('data-revision', selectedRevision!);
      await uiExpect(page.getByTestId('studio-export-result')).toHaveCount(0);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { i6SaveCalls?: number }).i6SaveCalls)).toBe(1);
      // Advance only this isolated main process clock; the real plan service enforces its 15-minute TTL.
      await app.evaluate(() => { const state = globalThis as typeof globalThis & { i6OriginalNow?: typeof Date.now }; state.i6OriginalNow = Date.now; Date.now = () => state.i6OriginalNow!() + 16 * 60000; });
      try {
        await page.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
        await uiExpect(page.getByRole('dialog').locator('[data-step="settings"]')).toBeVisible();
        await uiExpect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        await uiExpect(page.getByRole('button', { name: '检查导出', exact: true })).toBeEnabled();
        expect(await app.evaluate(() => (globalThis as typeof globalThis & { i6SaveCalls?: number }).i6SaveCalls)).toBe(1);
      } finally {
        await app.evaluate(() => { const state = globalThis as typeof globalThis & { i6OriginalNow?: typeof Date.now }; if (state.i6OriginalNow) Date.now = state.i6OriginalNow; delete state.i6OriginalNow; });
      }
      await capture('04-expired-plan-requires-check-light');
      await review(page, 1);
      const output = path.join(root, 'confirmed.srt');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
      await page.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-export-result')).toHaveAttribute('data-outcome', 'success');
      await uiExpect(page.getByTestId('studio-export-result').locator('[data-result-id]')).toContainText('confirmed.srt'); await capture('05-single-result-light');
      expect(await readFile(output, 'utf8')).toBe(sourceText + '\n');
      await closeResult(page, 1);
      await page.locator('.studio-document').filter({ hasText: names[2] }).click();
      await openExport(page); await select(page, '字幕格式', 'SRT'); await review(page, 0);
      await uiExpect(page.getByRole('button', { name: '确认并导出 0 份', exact: true })).toBeDisabled();
      await uiExpect(page.locator('[data-issue="missing_end"]')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
      expect(await readdir(path.dirname(files[2]))).toEqual([names[2]]);
      for (const name of names) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
      await openExport(page, true); await select(page, '字幕格式', 'SRT');
      await nativeWindow.evaluate(win => win.setSize(786, 540)); await page.evaluate(() => document.documentElement.classList.add('dark'));
      await review(page, 2); await capture('06-partial-review-narrow-dark');
      await uiExpect(page.getByRole('dialog').locator('.studio-export-summary')).toContainText('4 条');
      const details = page.getByTestId('studio-export-review-details'); await details.locator('summary').focus(); await page.keyboard.press('Space');
      await uiExpect(details.locator('.studio-document-row')).toHaveCount(3);
      await uiExpect(details.locator('[data-state="failed"]')).toHaveCount(1);
      await details.evaluate(element => element.scrollIntoView({ block: 'center' })); await capture('07-partial-details-narrow-dark');
      await page.getByRole('button', { name: '确认并导出 2 份', exact: true }).click();
      const result = page.getByTestId('studio-batch-result'); await uiExpect(result).toHaveAttribute('data-outcome', 'partial');
      await uiExpect(result.locator('[data-result-id]')).toHaveCount(0); await capture('08-partial-result-narrow-dark');
      await result.locator('[data-result-details] > summary').focus(); await page.keyboard.press('Enter');
      await uiExpect(result.locator('[data-result-id]')).toHaveCount(3);
      await uiExpect(result.locator('[data-result-id][data-state="failed"]')).toHaveCount(1); await uiExpect(result.locator('[data-result-id][data-state="failed"]')).toContainText(names[2]); await capture('09-failure-details-narrow-dark');
      for (const file of files.slice(0, 2)) expect(await readFile(file.replace(/\.srt$/, ' (1).srt'), 'utf8')).toBe(sourceText + '\n');
      await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      await openExport(page, false, true);
      await uiExpect(page.getByRole('button', { name: '检查导出', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '保存到来源目录', exact: true }).click(); await closeResult(page, 1);
      expect(await readFile(files[2].replace(/\.lrc$/, ' (1).lrc'))).toEqual(sourceBytes[2]);
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await openExport(page, true, true);
      await nativeWindow.evaluate(win => win.setSize(786, 540));
      await uiExpect(page.locator('[data-testid="studio-source-location"][data-state="ready"]')).toHaveCount(3);
      const moved: string[] = [];
      try {
        for (const file of files) { await rename(file, `${file}.moved`); moved.push(file); }
        await page.getByRole('button', { name: '保存到来源目录', exact: true }).click();
        await uiExpect(page.getByTestId('studio-batch-result')).toHaveAttribute('data-outcome', 'failed');
        await uiExpect(page.getByTestId('studio-batch-result')).not.toContainText('成功');
        await uiExpect(page.getByTestId('studio-batch-result').locator('[data-result-id]')).toHaveCount(0);
        await capture('10-all-failed-original-result-narrow-dark');
      } finally { for (const file of moved) await rename(`${file}.moved`, file); }
      await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      for (let index = 0; index < files.length; index++) expect(digest(await readFile(files[index]))).toBe(digest(sourceBytes[index]));
      expect(pageErrors).toEqual([]);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ geometry, pageErrors, realPlans: true, nativeSaveCancellation: 'review retained', realPlanTtl: 'main clock advanced 16 minutes then restored; rejection before native picker', partialBatch: { success: 2, failed: 1 }, rawSourceBytesPreserved: true, noAsrOrTranslationCalls: true, productionMainSha256: digest(await readFile('dist-electron/main/index.js')), preloadSha256: digest(await readFile('dist-electron/preload/index.mjs')), rendererHtmlSha256: digest(await readFile('dist/index.html')) }, null, 2));
    } catch (failure) {
      await page?.screenshot({ path: path.join(root, 'failure.png'), animations: 'disabled' }).catch(() => {}); throw failure;
    } finally {
      try { await app?.close(); closed = true; } finally {
        if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped owned root');
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: closed, profileRemoved: true }));
      }
    }
  }, 180000);
});
