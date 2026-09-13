import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

describe.runIf(process.env.FUSIONKIT_STUDIO_CONFLICT_UI === '1')('export conflict policy in real Electron', () => {
  it('aligns the footer menu and publishes indexed and native overwrite exports', async () => {
    const artifacts = path.resolve('test-results/studio-export-conflict'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')), profile = path.join(root, 'profile');
    const raw = '1\n00:00:01,000 --> 00:00:02,000\nSource text\n';
    const files: string[] = [];
    for (const folder of ['a', 'b']) { await mkdir(path.join(root, folder)); const file = path.join(root, folder, 'sample.srt'); await writeFile(file, raw); files.push(file); }
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow();
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); location.hash = '/tools/subtitle/studio'; });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await (await app.browserWindow(page)).evaluate(win => win.setSize(1280, 860));
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByTestId('studio-library-select-all').click();
      const trigger = page.getByRole('button', { name: '批量下载', exact: true });
      const triggerBox = await trigger.boundingBox();
      await trigger.click();
      const menu = page.getByTestId('studio-download-menu');
      await uiExpect(menu).toHaveAttribute('data-side', 'top'); await uiExpect(menu).toHaveAttribute('data-align', 'start');
      await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      const geometry = { trigger: triggerBox, menu: await menu.boundingBox() };
      expect(geometry.menu!.y + geometry.menu!.height).toBeLessThan(geometry.trigger!.y);
      expect(Math.abs(geometry.menu!.x - geometry.trigger!.x)).toBeLessThan(2);
      await page.screenshot({ path: path.join(root, 'menu.png'), animations: 'disabled' });
      await page.getByRole('menuitem', { name: '批量导出字幕', exact: true }).click();
      await uiExpect(page.getByRole('combobox', { name: '同名文件', exact: true })).toHaveText('自动添加序号');
      await page.screenshot({ path: path.join(root, 'settings.png'), animations: 'disabled' });
      await page.getByRole('button', { name: '检查导出', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-plan')).toContainText('自动添加序号');
      await page.getByRole('button', { name: '确认并导出 2 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-result')).toHaveAttribute('data-outcome', 'success');
      for (const file of files) { expect(await readFile(file, 'utf8')).toBe(raw); expect(await readFile(file.replace('.srt', ' (1).srt'), 'utf8')).toContain('Source text'); }
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await trigger.click(); await page.getByRole('menuitem', { name: '批量导出字幕', exact: true }).click();
      await page.getByRole('combobox', { name: '同名文件', exact: true }).click();
      await page.getByRole('option', { name: '覆盖同名文件', exact: true }).click();
      await page.getByRole('button', { name: '检查导出', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-plan')).toContainText('覆盖同名文件');
      await page.screenshot({ path: path.join(root, 'overwrite-review.png'), animations: 'disabled' });
      await page.getByRole('button', { name: '确认并导出 2 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-result')).toHaveAttribute('data-outcome', 'success');
      for (const file of files) { expect(await readFile(file, 'utf8')).not.toBe(raw); expect(await readFile(file, 'utf8')).toContain('Source text'); }
      const refs = await page.evaluate(async () => { const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw Error(list.error); return list.value.documents.map(doc => ({ documentId: doc.id, revision: doc.revision })); });
      for (const ref of refs) expect(await page.evaluate(async documentId => window.subtitleStudio.getSourceLocation({ documentId }), ref.documentId)).toMatchObject({ ok: true, value: { status: 'ready' } });
      // An explicitly selected existing SaveDialog path still respects the policy.
      const firstRef = refs[0];
      // Map opaque document IDs to fixture paths using their distinct private source receipt.
      const userData = await app.evaluate(({ app }) => app.getPath('userData'));
      const receipt = JSON.parse(await readFile(path.join(userData, 'subtitle-studio', 'documents', firstRef.documentId, 'source-location.private.json'), 'utf8'));
      const selectedPath: string = receipt.capture.inputPath;
      const savedBefore = await readFile(selectedPath);
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, selectedPath);
      for (const [index, policy] of (['indexed', 'overwrite', 'indexed'] as const).entries()) {
        const single = await page.evaluate(async ({ ref, policy, source }) => {
          const plan = await window.subtitleStudio.planExport({ ...ref, options: { mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'crlf', incomplete: 'block', missingEnd: { mode: 'block' }, conflictPolicy: policy } });
          if (!plan.ok || !plan.value.planId) throw Error(JSON.stringify(plan));
          return window.subtitleStudio.exportDocument({ ...ref, planId: plan.value.planId, acceptedLosses: plan.value.issues.filter(issue => issue.confirmation).map(issue => issue.code), destination: source ? 'source-directory' : 'choose-location' });
        }, { ref: firstRef, policy, source: index === 2 });
        expect(single).toMatchObject({ ok: true });
        if (policy === 'overwrite') expect(await readFile(selectedPath, 'utf8')).toContain('\r\n');
        else if (index === 0) { expect(await readFile(selectedPath)).toEqual(savedBefore); expect(single).toMatchObject({ value: { fileName: 'sample (2).srt' } }); }
      }
      const output = path.join(root, 'output'); await mkdir(output); await writeFile(path.join(output, 'sample.srt'), 'old target');
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, output);
      const result = await page.evaluate(async documents => {
        const plan = await window.subtitleStudio.planExportBatch({ documents, options: { mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'crlf', incomplete: 'block', missingEnd: { mode: 'block' }, conflictPolicy: 'overwrite' } });
        if (!plan.ok) throw Error(plan.error);
        return window.subtitleStudio.exportBatch({ batchId: plan.value.batchId, destination: 'choose-location', acceptedLosses: plan.value.items.filter(item => item.ok).map(item => ({ documentId: item.documentId, codes: item.ok ? item.plan.issues.filter(issue => issue.confirmation).map(issue => issue.code) : [] })) });
      }, refs);
      expect(result).toMatchObject({ ok: true, value: { items: [{ ok: true }, { ok: true }] } });
      expect((await readdir(output)).sort()).toEqual(['sample (1).srt', 'sample.srt']);
      expect(await readFile(path.join(output, 'sample.srt'), 'utf8')).toContain('\r\n');
      const blocked = path.join(root, 'blocked'); await mkdir(path.join(blocked, 'sample.srt'), { recursive: true });
      await writeFile(path.join(blocked, 'sample.srt', 'keep.txt'), 'keep');
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, blocked);
      const denied = await page.evaluate(async ref => {
        const plan = await window.subtitleStudio.planExportBatch({ documents: [ref], options: { mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, conflictPolicy: 'overwrite' } });
        if (!plan.ok) throw Error(plan.error);
        return window.subtitleStudio.exportBatch({ batchId: plan.value.batchId, acceptedLosses: [], destination: 'choose-location' });
      }, firstRef);
      expect(denied).toMatchObject({ ok: true, value: { items: [{ ok: false, error: 'output_write_failed' }] } });
      expect(await readFile(path.join(blocked, 'sample.srt', 'keep.txt'), 'utf8')).toBe('keep');
      for (const directory of [output, blocked, ...files.map(file => path.dirname(file))]) expect((await readdir(directory)).some(name => name.startsWith('.fusionkit-') || name.startsWith('.subtitle-studio-'))).toBe(false);
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await (await app.browserWindow(page)).evaluate(win => win.setSize(786, 540));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByRole('button', { name: '下载', exact: true }).click();
      await uiExpect(menu).toHaveAttribute('data-side', 'bottom'); await uiExpect(menu).toHaveAttribute('data-align', 'end');
      await page.getByRole('menuitem', { name: '导出字幕', exact: true }).click();
      await uiExpect(page.getByRole('combobox', { name: '同名文件', exact: true })).toHaveText('自动添加序号');
      await page.getByRole('combobox', { name: '同名文件', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(root, 'settings-dark-narrow.png'), animations: 'disabled' });
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ geometry, indexedPreservesSource: true, nativeOverwrite: true, sourceBindingRefreshed: true, batchDuplicatesIndexed: true, result }, null, 2));
    } finally {
      if (app) await app.close();
      if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw Error('unexpected test root');
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, profileRemoved: true }));
    }
  }, 120000);
});
