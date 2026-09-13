import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import zh from '../../src/locales/zh/studio.json';
import en from '../../src/locales/en/studio.json';

type Payload = { items: { id: string; text: string }[] };
const text = (key: string, language: 'zh' | 'en' = 'zh', values: Record<string, string | number> = {}) => {
  let value: unknown = language === 'zh' ? zh : en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
  if (typeof value !== 'string') throw new Error(`Missing fixture translation: ${language}/${key}`);
  for (const [name, replacement] of Object.entries(values)) value = (value as string).replaceAll(`{{${name}}}`, String(replacement));
  return value as string;
};
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}
async function settled(page: Page) {
  // Active translation spinners are intentionally infinite. Geometry requires
  // finite entry/exit transitions to settle, not the running work to finish.
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity));
}

describe.runIf(process.env.FUSIONKIT_STUDIO_I7_RESULT_UI === '1')('I7 consistent operation feedback', () => {
  it('shows actual receipts and action-specific outcomes with one optional detail list and honest request semantics', async () => {
    const artifacts = path.resolve('test-results/studio-i7-results'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const source = '1\n00:00:01,000 --> 00:00:03,000\nA controlled source line.\n';
    const names = ['01-导出后的文件名称应直接可识别-September-Workshop.srt', '02-跨语言研讨会与较长文件名称-用于完整提示和换行检查-International-Research.srt', '03-请求取消的任务.srt', '04-没有待取消任务.srt'];
    const files = names.map(name => path.join(root, name));
    for (const file of files) await writeFile(file, source);
    const invalidNames = ['05-无法解析的字幕文件-保留完整名称用于失败详情-Workshop.srt', '06-Unsupported-subtitle-content-for-English-error-details.srt'];
    const invalidFiles = invalidNames.map(name => path.join(root, name));
    for (const file of invalidFiles) await writeFile(file, 'This file has no subtitle timing or cues.');
    const inputHashes = await Promise.all([...files, ...invalidFiles].map(async file => ({ name: path.basename(file), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
    let app: ElectronApplication | undefined; let server: Server | undefined; let page: Page | undefined;
    let language: 'zh' | 'en' = 'zh'; let hold = true; let requestCount = 0;
    const held: { response: ServerResponse; payload: Payload }[] = [];
    const errors: string[] = []; const geometry: unknown[] = []; const actions: unknown[] = [];
    const respond = (response: ServerResponse, payload: Payload) => {
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: 'Controlled translated line.' })) }) } }] }));
    };
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content) as Payload; requestCount++;
        if (hold) held.push({ response, payload }); else respond(response, payload);
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'i7-feedback-model', name: 'Controlled translation', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-translation', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'i7-feedback-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await ready(page);
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1281, 860));
      const importFiles = async (paths: string[]) => {
        await app!.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
        await page!.getByRole('button', { name: text('open_file', language), exact: true }).click();
      };
      const result = (testId = 'studio-library-result') => page!.getByTestId(testId);
      const assertResult = async (operation: string, outcome: string, count: number, testId = 'studio-library-result') => {
        const surface = result(testId); await uiExpect(surface).toHaveAttribute('data-operation', operation); await uiExpect(surface).toHaveAttribute('data-outcome', outcome);
        const dialog = page!.getByRole('dialog'); await uiExpect(dialog).toHaveClass(/studio-result-dialog/);
        await uiExpect(dialog.getByRole('heading')).toBeFocused();
        await uiExpect(surface.locator('[data-result-id]')).toHaveCount(outcome === 'success' && count === 1 ? 1 : 0);
        const details = surface.locator('[data-result-details]');
        await uiExpect(details).toHaveCount(outcome === 'success' && count === 1 ? 0 : 1);
        if (await details.count()) expect(await details.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
        await settled(page!);
        expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(420.5);
        actions.push({ operation, outcome, count, defaultDetailsClosed: true });
      };
      const closeResult = async (testId = 'studio-library-result', keyboard = false) => {
        await settled(page!);
        const closing = await page!.getByRole('dialog').evaluateHandle(dialog => {
          const samples: { state: string | null; hasResult: boolean; title: string; hasSettings: boolean; hasContent: boolean }[] = [];
          let frame = 0;
          const sample = () => {
            if (!dialog.isConnected) return;
            const next = { state: dialog.getAttribute('data-state'), hasResult: !!dialog.querySelector('.studio-operation-result'), title: dialog.querySelector('[data-slot="dialog-title"]')?.textContent ?? '', hasSettings: !!dialog.querySelector('[data-step="settings"]'), hasContent: !!dialog.querySelector('.studio-result-content')?.textContent?.trim() };
            samples.push(next);
          };
          const observer = new MutationObserver(sample); observer.observe(dialog, { attributes: true, childList: true, subtree: true });
          const tick = () => { sample(); if (dialog.isConnected) frame = requestAnimationFrame(tick); };
          tick();
          return { stop: () => { observer.disconnect(); cancelAnimationFrame(frame); return samples; } };
        });
        const close = result(testId).locator('button[id$="-close"]');
        try {
          if (keyboard) { await close.focus(); await page!.keyboard.press('Enter'); } else await close.click();
          await uiExpect(page!.locator('[role="dialog"]')).toHaveCount(0);
          const samples = await closing.evaluate(probe => probe.stop());
          const closed = samples.filter(sample => sample.state === 'closed');
          actions.push({ testId, closeFrames: closed.length, closingStates: [...new Set(closed.map(sample => JSON.stringify(sample)))].map(sample => JSON.parse(sample)) });
          expect(closed.length).toBeGreaterThan(0);
          for (const sample of closed) { expect(sample.hasResult).toBe(true); expect(sample.title).toBe(samples[0].title); expect(sample.hasSettings).toBe(false); expect(sample.hasContent).toBe(true); }
          actions.push({ testId, closeFrames: closed.length, titleRetainedThroughExit: true, noSettingsOrBlankDuringExit: true });
        } finally { await closing.evaluate(probe => probe.stop()); await closing.dispose(); }
      };
      const capture = async (name: string) => {
        await settled(page!);
        const data = await page!.getByRole('dialog').evaluate(dialog => {
          const bounds = dialog.getBoundingClientRect(); const close = dialog.querySelector('button[id$="-close"]')!;
          const closeBounds = close.getBoundingClientRect();
          const innerScrollWidths = [...dialog.querySelectorAll('.studio-result-content [data-slot="scroll-area-viewport"], .studio-result-content [data-slot="scroll-area-viewport"] > div')].map(element => ({ slot: element.getAttribute('data-slot') ?? 'inner-wrapper', scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, display: getComputedStyle(element).display }));
          return { width: bounds.width, height: bounds.height, x: bounds.x, right: bounds.right, bottom: bounds.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: dialog.scrollWidth - dialog.clientWidth, closeBottom: closeBounds.bottom, closeHeight: closeBounds.height, innerScrollWidths };
        });
        geometry.push({ name, ...data });
        expect(data.x).toBeGreaterThanOrEqual(0); expect(data.right).toBeLessThanOrEqual(data.viewportWidth + 1); expect(data.bottom).toBeLessThanOrEqual(data.viewportHeight + 1); expect(data.closeBottom).toBeLessThanOrEqual(data.viewportHeight + 1); expect(data.overflow).toBeLessThanOrEqual(1); expect(data.closeHeight).toBe(36);
        expect(data.innerScrollWidths).toHaveLength(2);
        for (const inner of data.innerScrollWidths) { expect(inner.clientWidth).toBeGreaterThan(0); expect(inner.scrollWidth).toBeLessThanOrEqual(inner.clientWidth + 1); }
        await page!.screenshot({ path: path.join(root, `${name}.png`), animations: 'disabled' });
      };
      const documents = () => page!.evaluate(async () => { const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error); return list.value.documents; });
      const clearSelection = async () => {
        const rows = page!.getByTestId('studio-library-row');
        for (const checkbox of await rows.getByRole('checkbox').all()) if (await checkbox.isChecked()) await checkbox.uncheck();
      };
      const choose = async (selectedNames: string[]) => {
        await clearSelection();
        for (const name of selectedNames) await page!.getByTestId('studio-library-row').filter({ hasText: name }).getByRole('checkbox').check();
      };
      const batchAction = async (key: string) => { await page!.locator('#studio-library-batch-actions').click(); await page!.getByRole('menuitem', { name: text(key, language), exact: true }).click(); };

      await importFiles([files[0]]); await uiExpect(page!.locator('.studio-cue-table tbody tr')).toHaveCount(1);
      await uiExpect(page!.getByRole('dialog')).toHaveCount(0);
      await page!.getByRole('button', { name: text('batch.download_single'), exact: true }).click(); await page!.getByRole('menuitem', { name: text('export.action'), exact: true }).click();
      await page!.getByRole('button', { name: text('export.prepare'), exact: true }).click(); await page!.getByRole('button', { name: text('export.review_confirm', 'zh', { count: 1 }), exact: true }).click();
      await assertResult('export', 'success', 1, 'studio-export-result');
      const output = files[0].replace(/\.srt$/, ' (1).srt');
      await uiExpect(result('studio-export-result').locator('[data-result-id]')).toContainText(path.basename(output)); expect(await readFile(output, 'utf8')).toBe(source + '\n');
      await capture('01-single-export-receipt-light'); await closeResult('studio-export-result', true);
      await uiExpect(page!.getByRole('button', { name: text('batch.download_single'), exact: true })).toBeFocused();
      await page!.getByRole('button', { name: text('batch.download_single'), exact: true }).click(); await page!.getByRole('menuitem', { name: text('export_source'), exact: true }).click();
      await page!.getByRole('button', { name: text('export.save_to_source'), exact: true }).click();
      await assertResult('source', 'success', 1, 'studio-export-result'); expect(await readFile(files[0].replace(/\.srt$/, ' (2).srt'), 'utf8')).toBe(source);
      await capture('02-original-file-receipt-light'); await closeResult('studio-export-result');

      await importFiles([...files.slice(1), invalidFiles[0]]); await assertResult('import', 'partial', 4);
      await capture('03-partial-import-overview-light');
      await result().locator('[data-result-details] > summary').focus(); await page!.keyboard.press('Space');
      await uiExpect(result().locator('[data-result-id]')).toHaveCount(4); await uiExpect(result().locator('[data-result-id]').first()).toHaveAttribute('data-state', 'failed');
      const longName = result().locator('[data-result-id]').filter({ hasText: names[1] }).locator('.studio-file-name');
      await longName.focus(); await uiExpect(page!.getByRole('tooltip')).toContainText(names[1]);
      await capture('04-partial-import-long-name-details-light'); await page!.keyboard.press('Escape');
      await uiExpect(page!.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
      await settled(page!);
      if (await result().count()) { await page!.keyboard.press('Escape'); await uiExpect(page!.getByRole('dialog')).toHaveCount(0); }
      expect(await page!.evaluate(() => !!document.activeElement && document.activeElement.getBoundingClientRect().width > 0)).toBe(true);
      expect(await documents()).toHaveLength(4);
      await importFiles([invalidFiles[1]]);
      // A single import failure keeps the existing inline error/retry flow; only
      // multi-file import completion enters the shared result surface.
      await uiExpect(page!.getByRole('alert')).toContainText('字幕结构无效'); await uiExpect(page!.getByRole('dialog')).toHaveCount(0);
      actions.push({ singleImportFailureUsesInlineRetry: true });
      await importFiles(invalidFiles); await assertResult('import', 'failed', 2); await capture('05-all-failed-import-light'); await closeResult();

      await page!.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await page!.reload(); await ready(page!); await uiExpect(page!.locator('html')).toHaveClass(/dark/);
      const runningDocument = (await documents()).find(item => item.origin.displayName === names[2])!;
      const admittedTask = await page!.evaluate(async ({ document, port }) => {
        const config = { model: { profileId: 'i7-feedback-model', modelKey: 'controlled-translation', endpoint: `http://127.0.0.1:${port}/v1`, apiFormat: 'chat_completions' as const }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 20 };
        const plan = await window.subtitleStudio.planTranslationBatch({ documents: [{ documentId: document.id, revision: document.revision }], config }); if (!plan.ok) throw new Error(plan.error);
        const started = await window.subtitleStudio.createTranslationBatch({ batchId: plan.value.batchId, apiKey: 'synthetic-test-key' }); if (!started.ok) throw new Error(started.error);
        const item = started.value.items[0]; if (!item.ok) throw new Error(item.error); return item.taskId;
      }, { document: runningDocument, port });
      await uiExpect.poll(() => requestCount).toBe(1);
      await uiExpect.poll(async () => (await documents()).find(item => item.id === runningDocument.id)?.task?.status).toBe('running');
      await choose([names[2], names[3]]); await batchAction('library.cancel_selected');
      await assertResult('cancel', 'partial', 2);
      await uiExpect(result().getByRole('heading')).toContainText('取消'); await uiExpect(result().getByRole('heading')).not.toContainText('已完成');
      await nativeWindow.evaluate(win => win.setSize(787, 540)); await capture('06-cancel-request-and-skipped-narrow-dark');
      await result().locator('[data-result-details] > summary').click();
      await uiExpect(result().locator('[data-result-id][data-state="success"]')).toHaveCount(1); await uiExpect(result().locator('[data-result-id][data-state="skipped"]')).toHaveCount(1);
      await uiExpect(result().locator('[data-result-id]').first()).toHaveAttribute('data-state', 'skipped');
      await capture('07-cancel-request-details-narrow-dark'); await closeResult();
      await uiExpect.poll(async () => (await documents()).find(item => item.id === runningDocument.id)?.task?.status).toBe('cancelled'); actions.push({ cancelledTaskId: admittedTask, oneNoTaskDocumentSkipped: true });
      await nativeWindow.evaluate(win => win.setSize(1281, 860));
      await choose([names[1], names[3]]); await page!.getByRole('button', { name: text('batch.translation'), exact: true }).click();
      await page!.getByRole('button', { name: text('translation.prepare'), exact: true }).click();
      const planDetails = page!.locator('.studio-translation-plan-details');
      await planDetails.locator('summary').click();
      const padding = await planDetails.evaluate(element => {
        const box = element.querySelector('.studio-batch-results')!.getBoundingClientRect();
        const list = element.querySelector('.studio-document-list')!.getBoundingClientRect();
        return [list.top-box.top, list.left-box.left, box.right-list.right, box.bottom-list.bottom];
      });
      padding.forEach(value => expect(value).toBe(8));
      await page!.screenshot({ path: path.join(root, 'i8-plan-details-padding-dark.png'), animations: 'disabled' });
      await page!.getByRole('button', { name: text('batch.start_ready', 'zh', { count: 2 }), exact: true }).click();
      await assertResult('translation', 'success', 2, 'studio-batch-result');
      await uiExpect(result('studio-batch-result').getByRole('heading')).toContainText('已提交');
      const snapshot = await page!.evaluate(async () => { const list = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100 }); if (!list.ok) throw new Error(list.error); return list.value; });
      expect(snapshot.counts.completed).toBe(0); expect(snapshot.items.filter(item => ['queued', 'running'].includes(item.status))).toHaveLength(2);
      actions.push({ submittedTaskIds: snapshot.items.filter(item => ['queued', 'running'].includes(item.status)).map(item => item.taskId), completedAtSubmission: 0 });
      await nativeWindow.evaluate(win => win.setSize(787, 540)); await capture('08-translation-submitted-narrow-dark');
      await result('studio-batch-result').getByRole('button', { name: text('overview.view_progress'), exact: true }).click();
      await uiExpect(result('studio-batch-result')).toHaveCount(0); await uiExpect(page!.getByTestId('studio-translation-overview-list')).toBeVisible();
      await settled(page!); expect(await page!.getByRole('dialog').evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
      await page!.screenshot({ path: path.join(root, '09-open-live-progress-narrow-dark.png'), animations: 'disabled' });
      await page!.keyboard.press('Escape'); await uiExpect(page!.getByRole('dialog')).toHaveCount(0);
      hold = false; for (const item of held.splice(0)) respond(item.response, item.payload);
      await uiExpect.poll(async () => { const list = await page!.evaluate(() => window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100 })); return list.ok ? list.value.counts.completed : -1; }, { timeout: 20000 }).toBe(2);
      await nativeWindow.evaluate(win => win.setSize(1281, 860));
      await uiExpect(page!.getByTestId('studio-overview-board')).toBeVisible();
      await uiExpect(page!.getByTestId('studio-translation-round')).toHaveCount(0);
      const measuredUsage = await page!.evaluate(async () => { const list = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 1 }); if (!list.ok) throw Error(list.error); return list.value.usage; });
      expect(measuredUsage).toMatchObject({ inputTokens: 200, outputTokens: 80, totalTokens: 280, unknownInput: 1, unknownOutput: 1, unknownTotal: 1 });
      await uiExpect(page!.getByTestId('studio-overview-usage')).toContainText(measuredUsage.inputTokens.toLocaleString());
      actions.push({ measuredUsage });
      await page!.screenshot({ path: path.join(root, 'i8-usage-dashboard-dark.png'), animations: 'disabled' });
      await page!.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })));
      await page!.reload(); await ready(page!);
      await uiExpect(page!.getByTestId('studio-overview-board')).toBeVisible();
      await page!.screenshot({ path: path.join(root, 'i8-usage-dashboard-light.png'), animations: 'disabled' });
      await app!.evaluate(({ shell }) => { (globalThis as any).__i8Folders = []; shell.openPath = async folder => { (globalThis as any).__i8Folders.push(folder); return ''; }; });
      await page!.getByTestId('studio-reveal-source').click();
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as any).__i8Folders)).toEqual([root]);
      await choose([names[1], names[3]]); await batchAction('library.delete_selected');
      await page!.getByRole('button', { name: text('library.confirm_delete'), exact: true }).click(); await assertResult('delete', 'success', 2);
      await capture('10-delete-completed-dark'); await closeResult(); expect(await documents()).toHaveLength(2);
      await importFiles([files[1], files[3]]); await assertResult('import', 'success', 2); await capture('11-multiple-import-completed-dark'); await closeResult();
      language = 'en'; await page!.evaluate(() => localStorage.setItem('lang', 'en')); await page!.reload(); await ready(page!); await nativeWindow.evaluate(win => win.setSize(787, 540));
      await importFiles(invalidFiles); await assertResult('import', 'failed', 2); await capture('12-failed-overview-English-narrow-dark');
      await result().locator('[data-result-details] > summary').focus(); await page!.keyboard.press('Enter'); await uiExpect(result().locator('[data-result-id][data-state="failed"]')).toHaveCount(2);
      await capture('13-failed-details-English-narrow-dark'); await closeResult(undefined, true);
      expect(errors).toEqual([]);
      const sourcesAfter = await Promise.all([...files, ...invalidFiles].map(async file => ({ name: path.basename(file), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
      expect(sourcesAfter).toEqual(inputHashes);
      const hashFile = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ actions, geometry, pageErrors: errors, controlledTranslationRequests: requestCount, sourcesBefore: inputHashes, sourcesAfter, realMainPreloadRepository: true, noRealAsr: true, productionMainSha256: await hashFile('dist-electron/main/index.js'), preloadSha256: await hashFile('dist-electron/preload/index.mjs'), rendererHtmlSha256: await hashFile('dist/index.html') }, null, 2));
    } catch (failure) { await writeFile(path.join(root, 'failure.json'), JSON.stringify({ error: failure instanceof Error ? failure.message : String(failure), actions, geometry, pageErrors: errors }, null, 2)); await page?.screenshot({ path: path.join(root, 'failure.png'), animations: 'disabled' }).catch(() => {}); throw failure; }
    finally {
      try { await app?.close(); } finally {
        server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
        if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped owned root');
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, serverClosed: true, profileRemoved: true }));
      }
    }
  }, 240000);
});
