import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { DocumentSnapshot } from '../../src/subtitle-studio/persistence-contract';
import type { TranscriptionTaskSummary } from '../../src/subtitle-studio/transcription/task-contract';
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from '../../src/services/subtitle-studio/transcription-controller';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_I3_QUEUE_UI === '1';
type Fixture = Awaited<ReturnType<typeof buildTranscriptionUiApp>>;
type NativeSnapshot = { tasks: TranscriptionTaskSummary[]; traces: Array<{ operation: string; detail?: { taskId?: string } }> };
const source = '1\n00:00:01,000 --> 00:00:02,000\nA quiet workshop and a clearly confirmed result.\n';
async function control(app: ElectronApplication, command: Record<string, unknown>): Promise<NativeSnapshot> {
  return app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
}
async function settled(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('.studio-workspace-tabs')?.getAnimations({ subtree: true })
    .some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
}
async function capture(page: Page, fixture: Fixture, name: string) {
  await settled(page);
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    elements: [...document.querySelectorAll('.studio-workspace-header, .studio-document-layout, .studio-workspace, .studio-preview-panel, .studio-tabs, .studio-translation-toolbar, .studio-document-heading, .studio-translation-overview, .studio-transcription-queue, .studio-reader, .studio-library, .studio-reader-footer, [role=dialog]')].filter(element => !!element.getClientRects().length).map(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), parent = element.parentElement;
      return { className: element.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        minHeight: style.minHeight, gridTemplateRows: style.gridTemplateRows, parent: parent && { className: parent.className, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight } };
    }), navigationTop: document.querySelector('.fixed.bottom-0')?.getBoundingClientRect().top ?? innerHeight }));
  await writeFile(path.join(fixture.artifacts, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: path.join(fixture.artifacts, `${name}.png`), animations: 'disabled' });
  expect(geometry.overflow).toBe(false);
  for (const element of geometry.elements) {
    expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth + 1);
    expect(element.left).toBeGreaterThanOrEqual(-1); expect(element.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
    if (element.className.split(' ').some(name => ['studio-reader', 'studio-reader-footer', 'studio-library'].includes(name))) expect(element.bottom, element.className).toBeLessThanOrEqual(geometry.navigationTop + 1);
  }
}
async function seedHistory(fixture: Fixture) {
  const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio/documents'));
  const historical: string[] = [];
  for (let index = 0; index < 27; index++) {
    const document = importSubtitleText(source, { format: 'srt', displayName: index < 25 ? `Archive ${String(index).padStart(2, '0')}.srt` : `Fresh ${index - 24} · 独立翻译与字幕任务.srt`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
    await repository.create(document);
    if (index < 25) {
      const taskId = randomUUID(), trackId = randomUUID(); historical.push(taskId);
      const status: DocumentSnapshot['tasks'][number]['status'] = index < 21 ? 'completed' : index === 21 ? 'failed' : index === 22 ? 'cancelled' : index === 23 ? 'interrupted' : 'needs_configuration';
      await repository.transact(document.id, document.revision, snapshot => {
        snapshot.document.translationTracks.push({ id: trackId, revision: 1, language: 'ja', entries: {}, origin: 'ai' });
        snapshot.tasks.push({ id: taskId, trackId, generation: 1, status, completedBatchIds: status === 'completed' ? ['b1', 'b2', 'b3', 'b4'] : ['b1'], uncertainBatchIds: [], attempts: 1,
          translation: { config: { model: { profileId: 'synthetic-history', modelKey: 'Historical model', endpoint: 'http://127.0.0.1:1', apiFormat: 'chat_completions' }, language: 'ja', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 2 }, totalBatches: 4, estimatedInputTokens: 0, outputTokenReserve: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, ...(status === 'failed' ? { error: 'translation_failed' as const } : {}) } });
      });
    }
  }
  return historical;
}

describe.runIf(enabled)('I3 queue maintenance and global translation progress in Electron', () => {
  it('uses actual IPC/repository, snapshot bulk actions and real submitted IDs across pages and SPA navigation', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile('src/locales/zh/studio.json', 'utf8'));
    const historical = await seedHistory(fixture);
    let app: ElectronApplication | undefined, page: Page | undefined, server: Server | undefined, child: ChildProcess | undefined;
    const errors: string[] = [], logs: string[] = [], requests: Array<{ ids: string[] }> = [], releases: Array<() => void> = [];
    let releaseImmediately = false;
    const evidence: Record<string, unknown> = { native: 'controlled exact runtime substitute; no ASR', translation: 'production HTTP executor against a gated loopback response fixture', historicalTasks: historical.length };
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += String(chunk);
        const parsed = JSON.parse(body), payload = JSON.parse(parsed.messages[1].content);
        requests.push({ ids: payload.items.map((item: { id: string }) => item.id) });
        if (!releaseImmediately) await new Promise<void>(resolve => releases.push(resolve));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string }) => ({ id: item.id, text: `确认译文 ${item.id}` })) }) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      env.NODE_ENV = 'test'; delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      child = app.process();
      for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 200) logs.shift(); });
      page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'studio-i3-fixture', name: 'DeepSeek-v4-flash', provider: 'DeepSeek', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'studio-i3-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await settled(page);
      const win = await app.browserWindow(page); await win.evaluate(win => win.setSize(1280, 860));
      await uiExpect(page.getByTestId('studio-translation-overview')).toContainText(locale.translation.needs_configuration);
      const initial = await page.evaluate(() => window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100 }));
      expect(initial.ok && initial.value.total).toBe(25);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await uiExpect(page.getByTestId('studio-queue-clear-completed')).toBeDisabled();
      await page.getByTestId('studio-transcription').waitFor(); await control(app, { operation: 'resources-ready' });
      await page.getByTestId('studio-transcription-manage-resources').click();
      await page.getByRole('dialog').getByRole('button', { name: locale.transcription.check_again, exact: true }).click();
      await page.keyboard.press('Escape');
      const choose = async (names: string[]) => {
        const paths = names.map(name => path.join(fixture.artifacts, name)); await Promise.all(paths.map(file => writeFile(file, Buffer.alloc(44))));
        await app!.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, paths);
        await page!.getByTestId('studio-transcription-picker').getByRole('button', { name: locale.transcription.choose_media, exact: true }).click();
      };
      await choose(['Completed · 已完成且保留文档.wav', 'Failed · 可以清理.wav', 'Cleanup · 尚未退出原生工作.wav', 'Queued · 等待处理.wav', 'Running · 采访长名称与完整尾部检查.wav']);
      await page.getByTestId('studio-transcription-start').click();
      let native = await control(app, { operation: 'snapshot' }); expect(native.tasks).toHaveLength(5);
      const [completed, failed, cleaning, queued, running] = native.tasks;
      await control(app, { operation: 'complete', taskId: completed.taskId });
      await control(app, { operation: 'task-state', taskId: failed.taskId, status: 'failed' });
      await control(app, { operation: 'task-state', taskId: cleaning.taskId, status: 'failed', cleanupPending: true });
      await control(app, { operation: 'task-state', taskId: running.taskId, status: 'transcribing', progress: 47 });
      const rows = page.getByTestId('studio-transcription-task-row');
      await uiExpect(rows.filter({ hasText: 'Completed ·' })).toHaveAttribute('data-state', 'completed');
      await uiExpect(rows.filter({ hasText: 'Cleanup ·' }).getByRole('button', { name: new RegExp(locale.transcription.remove_task) })).toBeDisabled();
      native = await control(app, { operation: 'snapshot' }); const documentId = native.tasks.find(task => task.taskId === completed.taskId)!.documentId!;
      await capture(page, fixture, 'i3-01-light-queue-protection');
      await page.getByTestId('studio-queue-clear-completed').focus(); await page.keyboard.press('Enter');
      await uiExpect(rows).toHaveCount(4);
      const saved = await page.evaluate(id => window.subtitleStudio.readDocumentPage({ documentId: id, revision: 1, offset: 0 }), documentId);
      expect(saved.ok).toBe(true);
      await page.getByRole('button', { name: locale.transcription.queue_actions, exact: true }).click();
      await page.getByRole('menuitem', { name: locale.transcription.clear_terminal, exact: true }).click();
      await uiExpect(rows).toHaveCount(3);
      expect((await control(app, { operation: 'snapshot' })).tasks.map(task => task.taskId)).toEqual([cleaning.taskId, queued.taskId, running.taskId]);
      await page.getByRole('button', { name: locale.transcription.queue_actions, exact: true }).click();
      await page.getByRole('menuitem', { name: locale.transcription.cancel_all, exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('2');
      const addedPath = path.join(fixture.artifacts, 'Later · 确认之后加入.wav'); await writeFile(addedPath, Buffer.alloc(44));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, addedPath);
      const later = await page.evaluate(async config => {
        const selected = await window.subtitleStudio.selectTranscriptionMedia({});
        if (!selected.ok || !selected.value?.items[0].ok) throw new Error('Actual picker admission failed');
        const value = selected.value.items[0];
        return window.subtitleStudio.enqueueTranscription({ files: [{ fileToken: value.media.fileToken, audioStreamId: value.probe.autoSelectedStreamId }], config });
      }, DEFAULT_STUDIO_TRANSCRIPTION_CONFIG);
      expect(later.ok).toBe(true);
      await capture(page, fixture, 'i3-02-light-cancel-confirmation');
      await page.getByTestId('studio-queue-confirm-cancel').focus(); await page.keyboard.press('Enter');
      await uiExpect(rows.filter({ hasText: 'Queued ·' })).toHaveAttribute('data-state', 'cancelled');
      await uiExpect(rows.filter({ hasText: 'Running ·' })).toHaveAttribute('data-state', 'cancelled');
      await uiExpect(rows.filter({ hasText: 'Later ·' })).toHaveAttribute('data-state', 'queued');
      native = await control(app, { operation: 'snapshot' });
      expect(native.traces.filter(trace => trace.operation === 'cancel-task').map(trace => trace.detail?.taskId)).toEqual([queued.taskId, running.taskId]);
      evidence.queue = { cleared: native.traces.filter(trace => trace.operation === 'remove-task'), preservedDocumentId: documentId, remaining: native.tasks };

      await page.getByRole('tab', { name: '文档', exact: true }).click();
      await page.getByTestId('studio-library-search').fill('Fresh');
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(2);
      await page.getByTestId('studio-library-select-all').click();
      await uiExpect(page.getByTestId('studio-library-select-all')).toBeChecked();
      await page.getByTestId('studio-batch-toolbar').getByRole('button', { name: locale.batch.translation, exact: true }).click();
      const batch = page.getByRole('dialog', { name: locale.batch.translation, exact: true });
      await batch.getByRole('button', { name: locale.translation.prepare, exact: true }).click();
      await uiExpect(batch.getByTestId('studio-batch-plan').locator('[data-state=ready]')).toHaveCount(2);
      await batch.getByRole('button', { name: locale.batch.start_ready.replace('{{count}}', '2'), exact: true }).click();
      await uiExpect(batch.getByTestId('studio-batch-result').locator('[data-state=success]')).toHaveCount(2);
      await batch.getByRole('button', { name: locale.batch.close, exact: true }).click();
      await uiExpect(page.getByTestId('studio-translation-round')).toContainText('最近提交 2 项');
      await uiExpect(page.getByTestId('studio-translation-round')).toContainText('0%');
      const all = await page.evaluate(() => window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100 }));
      if (!all.ok) throw new Error('Actual translation overview failed');
      const submitted = all.value.items.filter(item => !historical.includes(item.taskId)); expect(submitted).toHaveLength(2);
      await page.getByTestId('studio-library-search').fill('Archive');
      await page.getByTestId('studio-library-pagination').getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(5);
      await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; }); await page.locator('#cvt-tour-queue').waitFor();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await settled(page);
      await uiExpect(page.getByTestId('studio-translation-round')).toContainText('最近提交 2 项');
      await page.getByTestId('studio-library-search').fill('');
      await page.getByTestId('studio-library-search').fill('Archive');
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(20);
      await page.getByTestId('studio-library-pagination').getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(5);
      await page.getByTestId('studio-translation-overview-details').focus(); await page.keyboard.press('Enter');
      const overview = page.getByRole('dialog', { name: locale.overview.title, exact: true });
      await uiExpect(overview.getByTestId('studio-translation-overview-list').locator(':scope > li')).toHaveCount(20);
      await overview.getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(overview.getByTestId('studio-translation-overview-list').locator(':scope > li')).toHaveCount(7);
      await capture(page, fixture, 'i3-03-light-overview-page-two');
      await overview.getByRole('button', { name: locale.previous, exact: true }).click();
      await overview.locator(`[data-task-id="${submitted[0].taskId}"]`).getByRole('button', { name: locale.overview.open_document, exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      await uiExpect(page.locator('.studio-document-heading')).toContainText('Fresh');
      await uiExpect.poll(() => releases.length).toBeGreaterThan(0); releases.shift()!();
      await uiExpect(page.getByTestId('studio-translation-round')).toContainText('50%', { timeout: 20000 });
      await capture(page, fixture, 'i3-04-light-confirmed-progress');
      await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
      await uiExpect(page.locator('html')).toHaveClass(/dark/); await win.evaluate(win => win.setSize(786, 540));
      await page.getByTestId('studio-translation-overview-details').focus(); await page.keyboard.press('Enter');
      try { await capture(page, fixture, 'i3-05-dark-narrow-overview'); }
      catch (error) {
        await page.keyboard.press('Escape');
        await uiExpect(overview).toHaveCount(0);
        await capture(page, fixture, 'i3-06-dark-narrow-keyboard-reader').catch(() => undefined);
        throw error;
      }
      await page.keyboard.press('Escape'); await uiExpect(page.getByTestId('studio-translation-overview-details')).toBeFocused();
      await uiExpect(overview).toHaveCount(0);
      await capture(page, fixture, 'i3-06-dark-narrow-keyboard-reader');
      releaseImmediately = true; for (const release of releases.splice(0)) release();
      await uiExpect(page.getByTestId('studio-translation-round')).toContainText('100%', { timeout: 20000 });
      const final = await page.evaluate(ids => window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100, taskIds: ids }), submitted.map(task => task.taskId));
      expect(final.ok && final.value.counts.completed).toBe(2);
      expect(final.ok && final.value.completedBatches).toBe(2);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      const queueActions = page.getByRole('button', { name: locale.transcription.queue_actions, exact: true });
      await queueActions.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await queueActions.focus(); await page.keyboard.press('Enter');
      await uiExpect(page.getByRole('menuitem', { name: locale.transcription.clear_terminal, exact: true })).toBeEnabled();
      await capture(page, fixture, 'i3-07-dark-narrow-queue-actions');
      await page.keyboard.press('Escape'); await uiExpect(queueActions).toBeFocused();
      evidence.translation = { submitted, final, requestCount: requests.length, priorHistoryExcluded: true, reopenedFromFilteredPage: true };
      expect(errors).toEqual([]); evidence.passed = true;
    } catch (error) {
      evidence.passed = false; evidence.error = String(error);
      await writeFile(path.join(fixture.artifacts, 'i3-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
      if (page && !page.isClosed()) { await page.screenshot({ path: path.join(fixture.artifacts, 'i3-failure.png') }).catch(() => undefined); await writeFile(path.join(fixture.artifacts, 'i3-failure-dom.txt'), await page.locator('body').innerText()); }
      throw error;
    } finally {
      releaseImmediately = true; for (const release of releases.splice(0)) release();
      await app?.close();
      server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      await writeFile(path.join(fixture.artifacts, 'i3-evidence.json'), JSON.stringify({ ...evidence, errors, cleanup: { electronExited: !child || child.exitCode !== null, serverClosed: !server?.listening } }, null, 2));
      await writeFile(path.join(fixture.artifacts, 'i3-electron.log'), logs.join(''));
      await fixture.cleanup();
    }
  }, 180000);
});
