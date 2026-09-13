import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

describe.runIf(process.env.FUSIONKIT_STUDIO_SMART_EXPORT_UI === '1')('content-aware export in real Electron', () => {
  it('restricts source-only scopes and exports mixed target/bilingual files with one source fallback', async () => {
    const artifacts = path.resolve('test-results/studio-smart-export'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const names = ['paired.srt', 'source.srt'];
    const original = ['1\n00:00:01,000 --> 00:00:02,000\nHello\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\nUntranslated line\n', '1\n00:00:01,000 --> 00:00:02,000\nSource only\n'];
    const files = names.map(name => path.join(root, name));
    for (let i = 0; i < files.length; i++) await writeFile(files[i], original[i]);
    let app: ElectronApplication | undefined;
    try {
      const launch = () => electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      app = await launch(); let page = await app.firstWindow(); await page.evaluate(() => localStorage.setItem('lang', 'zh')); await app.close();
      app = await launch(); page = await app.firstWindow(); await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      const openExport = async (batch = false) => {
        await page.getByRole('button', { name: batch ? '批量下载' : '下载', exact: true }).click();
        await page.getByRole('menuitem', { name: batch ? '批量导出字幕' : '导出字幕', exact: true }).click();
        return page.getByRole('dialog');
      };
      const close = async () => { await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); };
      await page.locator('.studio-document').filter({ hasText: names[1] }).click();
      let dialog = await openExport();
      await uiExpect(dialog.getByRole('combobox', { name: '导出内容', exact: true })).toContainText('仅原文');
      await uiExpect(dialog.getByRole('combobox', { name: '导出内容', exact: true })).toBeDisabled();
      await page.getByRole('dialog').screenshot({ path: path.join(root, 'single-source.png'), animations: 'disabled' }); await close();
      for (const name of names) await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check();
      dialog = await openExport(true);
      await uiExpect(dialog.getByRole('combobox', { name: '导出内容', exact: true })).toContainText('仅原文');
      await uiExpect(dialog.getByRole('combobox', { name: '导出内容', exact: true })).toBeDisabled();
      await dialog.screenshot({ path: path.join(root, 'batch-source.png'), animations: 'disabled' }); await close();
      await page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const document = listed.value.documents.find(doc => doc.origin.displayName === 'paired.srt')!;
        const result = await window.subtitleStudio.applyBilingual({ documentId: document.id, revision: document.revision, options: { sourceSide: 'first', splitInline: false, overrides: [] } });
        if (!result.ok) throw Error(result.error);
      });
      await uiExpect.poll(() => page.evaluate(async () => { const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); return listed.ok && listed.value.documents.some(doc => doc.translationStatus === 'partial'); })).toBe(true);
      // Wait for the library's observed summary rather than relying only on the IPC result.
      await uiExpect(page.locator('.studio-document').filter({ hasText: names[0] })).toContainText('部分译文');
      for (const [mode, index] of [['仅译文', 1], ['双语', 2]] as const) {
        dialog = await openExport(true);
        const choice = dialog.getByRole('combobox', { name: '导出内容', exact: true });
        await uiExpect(choice).toBeEnabled(); await uiExpect(choice).toContainText('双语');
        await choice.click(); await uiExpect(page.getByRole('option')).toHaveCount(3);
        await page.getByRole('option', { name: mode, exact: true }).click();
        await uiExpect(dialog.getByRole('combobox', { name: '缺失或过期的译文', exact: true })).toContainText('未完成处使用原文');
        await dialog.screenshot({ path: path.join(root, `mixed-${index}.png`), animations: 'disabled' });
        await dialog.getByRole('button', { name: '检查导出', exact: true }).click();
        await dialog.getByRole('button', { name: '确认并导出 2 份', exact: true }).click();
        await uiExpect(page.getByTestId('studio-batch-result')).toHaveAttribute('data-outcome', 'success');
        await page.getByRole('button', { name: '完成', exact: true }).click();
        const paired = await readFile(path.join(root, `paired (${index}).srt`), 'utf8');
        const source = await readFile(path.join(root, `source (${index}).srt`), 'utf8');
        expect(source.match(/Source only/g)).toHaveLength(1);
        expect(paired.match(/Untranslated line/g)).toHaveLength(1);
        expect(paired).toContain('你好');
        expect(paired.includes('Hello')).toBe(mode === '双语');
      }
      for (let i = 0; i < files.length; i++) expect(await readFile(files[i], 'utf8')).toBe(original[i]);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ sourceOnlySingleAndBatch: true, mixedExports: ['target', 'bilingual'], fallbackOnce: true, sourceUnchanged: true }));
    } finally {
      await app?.close();
      if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw Error('Unsafe profile cleanup');
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    }
  }, 120000);
});
