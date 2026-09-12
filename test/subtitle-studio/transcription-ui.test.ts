import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_T06_UI === '1';
const longName = '声音与故事 · Sound and Story · 字幕ワークスペース · 完整访谈与幕后制作记录 · Episode 02 original interview.wav';
type Fixture = Awaited<ReturnType<typeof buildTranscriptionUiApp>>;
type Snapshot = { traces: Array<{ operation: string; detail?: any }>; tasks: Array<{ taskId: string; displayName: string; documentId?: string }>; tokenCount: number };
async function control(app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> {
  return app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
}
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function theme(app: ElectronApplication, page: Page, value: 'light' | 'dark', width: number, height: number) {
  await page.evaluate(theme => {
    localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
    localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 })); location.hash = '/tools/subtitle/studio';
  }, value);
  await page.reload(); await ready(page);
  const window = await app.browserWindow(page);
  await window.evaluate((win, size) => win.setSize(size.width, size.height), { width, height });
  expect(await window.evaluate(win => win.getSize())).toEqual([width, height]);
  await uiExpect(page.locator('html')).toHaveClass(value === 'dark' ? /dark/ : /^(?!.*\bdark\b).*$/);
}
async function capture(page: Page, fixture: Fixture, name: string) {
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('.studio-workspace-tabs')?.getAnimations({ subtree: true })
    .some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
  expect(await page.locator('.studio-transcription-layout, .studio-transcription-workspace, .studio-transcription-settings')
    .evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
  const geometry = await page.evaluate(() => {
    const tabs = document.querySelector('.studio-workspace-tabs')!.getBoundingClientRect();
    const config = document.querySelector('[data-testid=studio-transcription-config]')?.getBoundingClientRect();
    const picker = document.querySelector('[data-testid=studio-transcription-picker]')?.getBoundingClientRect();
    return { viewport: innerWidth, tabs: { left: tabs.left, width: tabs.width }, layout: config && picker ? { left: config.left, right: picker.right } : null };
  });
  expect(geometry.tabs.width).toBeGreaterThan(geometry.viewport - 65);
  if (geometry.viewport >= 1024 && geometry.layout) {
    expect(geometry.layout.left).toBeGreaterThanOrEqual(28);
    expect(geometry.layout.left).toBeLessThanOrEqual(36);
    expect(geometry.layout.right).toBeGreaterThanOrEqual(geometry.viewport - 36);
  }
  await writeFile(path.join(fixture.artifacts, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: path.join(fixture.artifacts, `${name}.png`), animations: 'disabled' });
}
async function chooseFiles(app: ElectronApplication, page: Page, fixture: Fixture, names: string[], picker: string) {
  const files = names.map(name => path.join(fixture.artifacts, name));
  await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
  await page.getByTestId('studio-transcription-picker').getByRole('button', { name: picker, exact: true }).click();
}
async function launch(fixture: Fixture) {
  const app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot,
    env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const logs: string[] = [];
  app.process().stdout?.on('data', data => { logs.push(String(data)); if (logs.length > 120) logs.shift(); });
  app.process().stderr?.on('data', data => { logs.push(String(data)); if (logs.length > 120) logs.shift(); });
  return { app, logs };
}

describe.runIf(enabled)('Subtitle Studio transcription in the actual Electron window', () => {
  it('uses real IPC and repository for resource actions, media choices, retained queues and opening a completed document', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const t = locale.transcription;
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio/documents'));
    for (let index = 0; index < 21; index++) {
      await repository.create(importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nArchived subtitle\n',
        { format: 'srt', displayName: `Archive ${String(index).padStart(2, '0')}.srt`, encoding: 'utf-8', digest: 'b'.repeat(64) }, randomUUID));
    }
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    const errors: string[] = [];
    try {
      running = await launch(fixture); const { app } = running; const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await theme(app, page, 'light', 1280, 860);
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(20);
      await page.getByTestId('studio-library-search').fill('Archive');
      await page.getByTestId('studio-library-pagination').getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(1);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await page.getByTestId('studio-transcription').waitFor();
      const start = page.getByTestId('studio-transcription-start');
      await uiExpect(page.getByTestId('studio-transcription-config')).toContainText(t.runtime_ready);
      await uiExpect(start).toBeDisabled();
      await chooseFiles(app, page, fixture, [longName, 'cancel-queued.wav', 'cancel-running.wav', 'probe-retry · 需要重试的访谈音频.wav'], t.choose_media);
      const media = page.getByTestId('studio-transcription-media-row');
      await uiExpect(media).toHaveCount(4);
      const retryMedia = media.filter({ hasText: 'probe-retry' });
      await uiExpect(retryMedia).toHaveAttribute('data-state', 'error');
      await control(app, { operation: 'probe-recovered' });
      await retryMedia.getByRole('button', { name: new RegExp(t.retry_probe) }).click();
      await uiExpect(retryMedia).toHaveAttribute('data-state', 'ready');
      await media.filter({ hasText: longName }).getByRole('combobox').click();
      await page.getByRole('option').filter({ hasText: 'interpretation' }).click();
      await page.locator('#studio-transcription-language').click(); await page.getByRole('option', { name: t.language_en, exact: true }).click();
      await page.locator('#studio-transcription-task-mode').click(); await page.getByRole('option', { name: t.mode_english, exact: true }).click();

      const manage = page.getByTestId('studio-transcription-manage-resources');
      await manage.focus(); await page.keyboard.press('Enter');
      const resourceDialog = page.getByRole('dialog');
      const resources = page.getByTestId('studio-transcription-resources');
      const model = resources.locator('[data-resource-id="large-v3-q5_0"]');
      await writeFile(path.join(fixture.artifacts, 'model.bin'), Buffer.alloc(64));
      await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, path.join(fixture.artifacts, 'model.bin'));
      await model.getByRole('button', { name: t.import_model, exact: true }).click();
      await uiExpect(model).toHaveAttribute('data-state', 'installing');
      await capture(page, fixture, '01-light-resource-import');
      await control(app, { operation: 'resource-complete', resourceId: 'large-v3-q5_0' });
      await uiExpect(model).toHaveAttribute('data-state', 'ready');
      const vad = resources.locator('[data-resource-id="silero-vad-v6.2.0-ggml"]');
      await vad.getByRole('button', { name: t.download, exact: true }).click();
      await vad.getByRole('button', { name: t.cancel_download, exact: true }).click();
      await uiExpect(vad).toHaveAttribute('data-state', 'not_installed');
      await vad.getByRole('button', { name: t.download, exact: true }).click();
      await control(app, { operation: 'resource-complete', resourceId: 'silero-vad-v6.2.0-ggml' });
      await uiExpect(vad).toHaveAttribute('data-state', 'ready');
      await page.keyboard.press('Escape'); await uiExpect(resourceDialog).toHaveCount(0); await uiExpect(manage).toBeFocused();
      await page.locator('#studio-transcription-device').click(); await page.getByRole('option', { name: t.device_cuda, exact: true }).click();
      await uiExpect(start).toBeDisabled();
      await uiExpect(page.locator('#studio-transcription-readiness')).toHaveText(t.readiness_accelerator);
      await page.locator('#studio-transcription-device').click(); await page.getByRole('option', { name: t.device_cpu, exact: true }).click();
      await uiExpect(start).toBeEnabled();
      await page.getByTestId('studio-transcription-advanced').click();
      const cueDuration = page.locator('#studio-transcription-maxCueDurationMs');
      await cueDuration.fill(''); await uiExpect(start).toBeDisabled(); await uiExpect(cueDuration).toHaveValue('');
      await cueDuration.pressSequentially('1000'); await cueDuration.press('Tab'); await uiExpect(cueDuration).toHaveValue('1000');
      await uiExpect(start).toBeEnabled(); await page.getByTestId('studio-transcription-advanced').click();
      const beforeRoute = await control(app, { operation: 'snapshot' });
      await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; }); await page.locator('#cvt-tour-queue').waitFor();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await uiExpect(media).toHaveCount(4); await uiExpect(page.locator('#studio-transcription-language')).toHaveText(t.language_en);
      expect((await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'inspect-runtime').length)
        .toBe(beforeRoute.traces.filter(trace => trace.operation === 'inspect-runtime').length);
      await capture(page, fixture, '02-light-ready-media');
      await media.filter({ hasText: longName }).locator('.studio-file-name').focus();
      await uiExpect(page.getByRole('tooltip', { name: longName, exact: true })).toBeVisible();
      await capture(page, fixture, '02b-light-media-tooltip'); await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: '文档', exact: true }).click();
      await page.getByTestId('studio-library-search').fill('Archive');
      await page.getByTestId('studio-library-pagination').getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(1);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await control(app, { operation: 'revoke-failures', count: 1 });
      await start.focus(); await page.keyboard.press('Enter');
      const rows = page.getByTestId('studio-transcription-task-row');
      await uiExpect(rows).toHaveCount(4); await uiExpect(media).toHaveCount(0);
      const snapshot = await control(app, { operation: 'snapshot' });
      const enqueue = snapshot.traces.findLast(trace => trace.operation === 'enqueue')!.detail;
      expect(enqueue.config).toMatchObject({ language: 'en', taskMode: 'translate_to_english', devicePreference: 'cpu', vadEnabled: true, advanced: { maxCueDurationMs: 1000 } });
      expect(enqueue.files[0].audioStreamId).toBe('audio-1');
      await uiExpect.poll(async () => (await control(app, { operation: 'snapshot' })).tokenCount).toBe(0);
      const mainTask = snapshot.tasks.find(task => task.displayName === longName)!;
      const cancelledQueued = rows.filter({ hasText: 'cancel-queued.wav' });
      await cancelledQueued.getByRole('button', { name: new RegExp(t.cancel_task) }).click();
      await uiExpect(cancelledQueued).toHaveAttribute('data-state', 'cancelled');
      const runningTask = snapshot.tasks.find(task => task.displayName === 'cancel-running.wav')!;
      for (const status of ['preparing_media', 'loading_model', 'transcribing', 'post_processing']) {
        await control(app, { operation: 'task-state', taskId: mainTask.taskId, status });
        await uiExpect(rows.filter({ hasText: longName })).toHaveAttribute('data-state', status);
      }
      await control(app, { operation: 'task-state', taskId: runningTask.taskId, status: 'transcribing', progress: 58 });
      await uiExpect(rows.filter({ hasText: 'cancel-running.wav' })).toHaveAttribute('data-state', 'transcribing');
      expect(await rows.locator('.studio-file-name-end').evaluateAll(elements => elements.every(element =>
        element.clientWidth > 0 && element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      await capture(page, fixture, '03-light-running-queue');
      await rows.filter({ hasText: 'cancel-running.wav' }).getByRole('button', { name: new RegExp(t.cancel_task) }).click();
      await uiExpect(rows.filter({ hasText: 'cancel-running.wav' })).toHaveAttribute('data-state', 'cancelled');
      await control(app, { operation: 'task-state', taskId: snapshot.tasks.find(task => task.displayName.startsWith('probe-retry'))!.taskId, status: 'failed', cleanupPending: true });
      await control(app, { operation: 'complete', taskId: mainTask.taskId });
      await control(app, { operation: 'seed-newer-documents' });
      const completed = rows.filter({ hasText: longName });
      await uiExpect(completed).toHaveAttribute('data-state', 'completed');
      const documentId = (await control(app, { operation: 'snapshot' })).tasks.find(task => task.taskId === mainTask.taskId)!.documentId;
      expect(await page.evaluate(async id => {
        const listing = await window.subtitleStudio.listDocuments({ offset: 0, pageSize: 20, sort: 'recent' });
        if (!listing.ok) throw new Error(listing.error);
        return listing.value.documents.some(document => document.id === id);
      }, documentId)).toBe(false);
      await writeFile(path.join(fixture.artifacts, 'before-open-document.json'), JSON.stringify(await page.evaluate(() => ({
        libraryBusy: document.querySelector('.studio-library-scroll')?.getAttribute('aria-busy'),
        alert: document.querySelector('[role=alert]')?.textContent,
        query: (document.querySelector('[data-testid=studio-library-search]') as HTMLInputElement)?.value,
      })), null, 2));
      await completed.getByRole('button', { name: t.open_document, exact: true }).click();
      await uiExpect(page.getByRole('tab', { name: '文档', exact: true })).toHaveAttribute('aria-selected', 'true');
      await uiExpect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
      await uiExpect(page.getByTestId('studio-library-search')).toHaveValue('');
      await page.locator('.studio-preview-panel').getByRole('button', { name: locale.next, exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(5);
      await capture(page, fixture, '04-light-completed-document-page-two');

      await theme(app, page, 'dark', 786, 540);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await chooseFiles(app, page, fixture, [longName, '执行失败后的清理仍需完成 · Resource cleanup remains pending after the task has stopped.wav'], t.choose_media);
      await start.click(); await uiExpect(rows).toHaveCount(2);
      const dark = await control(app, { operation: 'snapshot' });
      await control(app, { operation: 'task-state', taskId: dark.tasks[0].taskId, status: 'transcribing', progress: 63 });
      await control(app, { operation: 'task-state', taskId: dark.tasks[1].taskId, status: 'failed', cleanupPending: true });
      await uiExpect(rows.last()).toHaveAttribute('data-state', 'failed');
      await uiExpect(rows.last().getByRole('button', { name: new RegExp(t.remove_task) })).toBeDisabled();
      const activeRoute = await control(app, { operation: 'snapshot' });
      await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; }); await page.locator('#cvt-tour-queue').waitFor();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await uiExpect(rows).toHaveCount(2); await uiExpect(rows.first()).toHaveAttribute('data-state', 'transcribing');
      expect((await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'inspect-runtime').length)
        .toBe(activeRoute.traces.filter(trace => trace.operation === 'inspect-runtime').length);
      await rows.last().evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      expect(await rows.last().locator('.studio-transcription-row-warning').last().evaluate(element => element.getBoundingClientRect().bottom < innerHeight - 64)).toBe(true);
      await capture(page, fixture, '05-dark-narrow-queue-long-warning');
      await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      await page.locator('#studio-transcription-vad').focus(); await page.keyboard.press('Space');
      await uiExpect(page.locator('#studio-transcription-vad')).toHaveAttribute('aria-checked', 'false');
      await capture(page, fixture, '06-dark-narrow-configuration-keyboard');
      await page.getByTestId('studio-transcription-advanced').click();
      await page.waitForFunction(() => !document.querySelector('.studio-workspace-tabs')?.getAnimations({ subtree: true })
        .some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
      await page.locator('#studio-transcription-maxCueDurationMs').evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      expect(await page.locator('#studio-transcription-maxCueDurationMs').evaluate(element => {
        const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom < innerHeight - 64;
      })).toBe(true);
      await capture(page, fixture, '06b-dark-narrow-advanced');
      await page.getByTestId('studio-transcription-advanced').click();
      await manage.click(); await uiExpect(resourceDialog).toBeVisible();
      await capture(page, fixture, '07-dark-narrow-resources');
      await page.keyboard.press('Escape'); await uiExpect(manage).toBeFocused();
      await writeFile(path.join(fixture.artifacts, 'fixture-trace.json'), JSON.stringify(await control(app, { operation: 'snapshot' }), null, 2));
      expect(errors).toEqual([]);
    } finally {
      const page = running?.app.windows()[0];
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(fixture.artifacts, 'final-window.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(fixture.artifacts, 'final-ui-state.json'), JSON.stringify(await page.evaluate(() => ({
          alerts: [...document.querySelectorAll('[role=alert]')].map(element => element.textContent),
          libraryBusy: document.querySelector('.studio-library-scroll')?.getAttribute('aria-busy'),
          query: (document.querySelector('[data-testid=studio-library-search]') as HTMLInputElement)?.value,
        })).catch(() => null), null, 2));
      }
      await writeFile(path.join(fixture.artifacts, 'renderer-errors.json'), JSON.stringify(errors));
      await writeFile(path.join(fixture.artifacts, 'electron.log'), running?.logs.join('') ?? 'Launch did not complete.');
      try { await running?.app.close(); } finally { await fixture.cleanup(); }
    }
  }, 240000);

  it('shows unavailable runtime from the unmodified production native implementation in an empty isolated app', async () => {
    const fixture = await buildTranscriptionUiApp('actual-missing');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    const errors: string[] = [];
    try {
      running = await launch(fixture); const page = await running.app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await theme(running.app, page, 'light', 1280, 860);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await uiExpect(page.getByTestId('studio-transcription-config')).toContainText(locale.transcription.runtime_unavailable);
      await uiExpect(page.getByTestId('studio-transcription-start')).toBeDisabled();
      const runtime = await page.evaluate(() => window.subtitleStudio.inspectTranscriptionRuntime({}));
      expect(runtime.ok && runtime.value.status).toBe('missing');
      expect(await running.app.evaluate(() => typeof (globalThis as any).__studioT06Control)).toBe('undefined');
      await writeFile(path.join(fixture.artifacts, 'actual-runtime.json'), JSON.stringify(runtime, null, 2));
      await capture(page, fixture, 'actual-missing-runtime-light');
      expect(errors).toEqual([]);
    } finally {
      await writeFile(path.join(fixture.artifacts, 'renderer-errors.json'), JSON.stringify(errors));
      await writeFile(path.join(fixture.artifacts, 'electron.log'), running?.logs.join('') ?? 'Launch did not complete.');
      try { await running?.app.close(); } finally { await fixture.cleanup(); }
    }
  }, 90000);
});
