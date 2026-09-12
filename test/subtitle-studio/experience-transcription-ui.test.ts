import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_I5_TRANSCRIPTION_UI === '1';
type Snapshot = { tasks: { taskId: string; documentId?: string; status: string; automaticTranslation?: { taskId?: string } }[]; traces: { operation: string; detail?: any }[] };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function drop(page: Page, filePaths: string[]) {
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.dataset.studioMediaDrop = ''; document.body.append(input); });
  await page.locator('[data-studio-media-drop]').setInputFiles(filePaths);
  await page.evaluate(() => {
    const input = document.querySelector('[data-studio-media-drop]') as HTMLInputElement;
    const transfer = new DataTransfer(); Array.from(input.files!).forEach(file => transfer.items.add(file));
    const target = document.querySelector('[data-testid=studio-transcription-picker]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    // Production preload must already have captured these OS-backed File paths.
    input.remove();
  });
}

describe.runIf(enabled)('I5 actual Electron transcription experience', () => {
  it('persists settings, captures native drop and hands committed documents to real automatic translation once', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')), t = locale.transcription;
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio/documents'));
    const pageErrors: string[] = [], logs: string[] = [], releases: (() => void)[] = [];
    const requests: { itemCount: number; targetLanguage: string }[] = [];
    const evidence: Record<string, unknown> = { boundary: 'Only native transcription runtime is controlled; production IPC/preload, document sink/repository, automatic coordinator, TranslationService and HTTP executor stay real.' };
    let respond = false, passed = false, server: Server | undefined, app: ElectronApplication | undefined, page: Page | undefined;
    const launch = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      const instance = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [instance.process().stdout, instance.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      const window = await instance.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => pageErrors.push(error.message));
      return { app: instance, page: window };
    };
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        requests.push({ itemCount: payload.items.length, targetLanguage: payload.targetLanguage });
        if (!respond) await new Promise<void>(resolve => releases.push(resolve));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string; text: string }) => ({ ...item, text: `受控翻译 ${item.text}` })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      ({ app, page } = await launch());
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'i5-auto', name: 'Controlled automatic translator', provider: 'OpenAI', apiKey: 'synthetic-automatic-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-auto', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'i5-auto', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await ready(page);
      const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      await control(app, { operation: 'resources-ready' });
      await page.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await uiExpect(page.locator('#studio-transcription-auto-translation')).toHaveAttribute('aria-checked', 'false');
      await uiExpect(page.getByTestId('studio-transcription-auto-configuration')).toHaveCount(0);
      await page.locator('#studio-transcription-language').click(); await page.getByRole('option', { name: t.language_ja, exact: true }).click();
      await page.locator('#studio-transcription-device').click(); await page.getByRole('option', { name: t.device_cpu, exact: true }).click();
      await page.getByRole('button', { name: t.advanced, exact: true }).click();
      await page.locator('#studio-transcription-beamSize').fill('7');
      const files = ['01-cancel.wav', '02-default-off.wav', '03-auto-翻译访谈.wav'].map(name => path.join(fixture.artifacts, name));
      await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
      await drop(page, [files[0]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      let snapshot = await control(app, { operation: 'snapshot' });
      await control(app, { operation: 'task-state', taskId: snapshot.tasks[0].taskId, status: 'transcribing' });
      const stop = page.locator('.studio-transcription-stop'); await uiExpect(stop).toBeEnabled();
      await page.getByTestId('studio-transcription-task-row').hover();
      const before = await stop.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
      await stop.hover(); await stop.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
      const hover = await stop.evaluate(element => {
        const style = getComputedStyle(element), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!; context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
        return { background: style.backgroundColor, color: style.color, rgba: Array.from(context.getImageData(0, 0, 1, 1).data) };
      });
      expect(hover.rgba[3]).toBeGreaterThan(20); expect(hover.rgba[0] - hover.rgba[1]).toBeGreaterThan(30); evidence.stopHover = { before, hover };
      await page.screenshot({ path: path.join(fixture.artifacts, 'i5-transcription-stop-hover-light.png'), animations: 'disabled' });
      await stop.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      evidence.stopFocus = await stop.evaluate(element => getComputedStyle(element).outlineStyle);
      await stop.click(); await uiExpect(page.getByTestId('studio-transcription-task-row')).toHaveAttribute('data-state', 'cancelled');
      await drop(page, [files[1]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1); await page.getByTestId('studio-transcription-start').click();
      snapshot = await control(app, { operation: 'snapshot' });
      await control(app, { operation: 'complete', taskId: snapshot.tasks[1].taskId, cueCount: 1 });
      snapshot = await control(app, { operation: 'snapshot' });
      const plain = await repository.readSnapshot(snapshot.tasks[1].documentId!); expect(plain.tasks).toEqual([]); expect(plain.automaticTranslation).toBeUndefined(); expect(requests).toEqual([]);
      evidence.defaultOffRequests = requests.length;
      await page.locator('#studio-transcription-auto-translation').click();
      await page.locator('#studio-transcription-translation-language').click(); await page.getByRole('option', { name: t.language_ja, exact: true }).click();
      await drop(page, [files[2]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1); await page.getByTestId('studio-transcription-start').click();
      snapshot = await control(app, { operation: 'snapshot' }); const nativeTask = snapshot.tasks[2];
      await page.getByRole('tab', { name: locale.workspace_documents, exact: true }).click();
      await control(app, { operation: 'complete', taskId: nativeTask.taskId, cueCount: 1 });
      await uiExpect.poll(() => requests.length).toBe(1);
      snapshot = await control(app, { operation: 'snapshot' }); const automaticDocumentId = snapshot.tasks[2].documentId!;
      const pending = await repository.readSnapshot(automaticDocumentId);
      expect(pending.automaticTranslation).toMatchObject({ state: 'admitted', sourceTaskId: nativeTask.taskId }); expect(pending.tasks).toHaveLength(1);
      respond = true; releases.splice(0).forEach(release => release());
      await uiExpect.poll(async () => (await repository.readSnapshot(automaticDocumentId)).tasks[0].status).toBe('completed');
      const completed = await repository.readSnapshot(automaticDocumentId);
      expect(completed.document.translationTracks[0].entries[completed.document.cues[0].id].text.plain).toContain('受控翻译');
      expect(JSON.stringify(completed)).not.toContain('synthetic-automatic-key');
      await control(app, { operation: 'complete', taskId: nativeTask.taskId, cueCount: 1 }); expect(requests).toHaveLength(1);
      evidence.automatic = { documentId: automaticDocumentId, taskId: completed.tasks[0].id, sourceTaskId: nativeTask.taskId, requests, status: completed.tasks[0].status, reopenedTrackCount: completed.document.translationTracks.length };
      await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      await uiExpect(page.locator('#studio-transcription-auto-translation')).toHaveAttribute('aria-checked', 'true');
      const geometry = await page.getByTestId('studio-transcription-runtime-row').evaluate(row => {
        const notice = row.querySelector('.studio-transcription-runtime')!.getBoundingClientRect(), button = row.querySelector('button')!.getBoundingClientRect();
        return { aligned: Math.abs(notice.top + notice.height / 2 - button.top - button.height / 2), sameRow: Math.abs(notice.top - button.top) < button.height };
      }); expect(geometry.sameRow).toBe(true); expect(geometry.aligned).toBeLessThan(2); evidence.runtimeRow = geometry;
      await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'i5-transcription-light.png'), animations: 'disabled' });
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1')!));
      expect(persisted.state.transcription.config).toMatchObject({ language: 'ja', devicePreference: 'cpu', advanced: { beamSize: 7 } });
      expect(persisted.state.transcription.autoTranslation).toMatchObject({ enabled: true, language: 'ja' }); expect(JSON.stringify(persisted)).not.toContain('synthetic-automatic-key');
      evidence.persisted = persisted.state.transcription;
      await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await app.close(); app = undefined; ({ app, page } = await launch());
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      await uiExpect(page.locator('#studio-transcription-language')).toHaveText(t.language_ja);
      await uiExpect(page.locator('#studio-transcription-device')).toHaveText(t.device_cpu);
      await uiExpect(page.locator('#studio-transcription-auto-translation')).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('button', { name: t.advanced, exact: true }).click(); await uiExpect(page.locator('#studio-transcription-beamSize')).toHaveValue('7');
      await uiExpect(page.locator('html')).toHaveClass(/dark/); expect(requests).toHaveLength(1);
      const small = await app.browserWindow(page); await small.evaluate(window => window.setSize(740, 860));
      await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      expect(await page.locator('.studio-transcription-layout, .studio-transcription-settings, .studio-transcription-workspace').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      await page.screenshot({ path: path.join(fixture.artifacts, 'i5-transcription-dark-narrow-restart.png'), animations: 'disabled' });
      await control(app, { operation: 'resources-ready' }); await page.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await drop(page, [files[0]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1); await page.getByTestId('studio-transcription-start').click();
      const darkStop = page.locator('.studio-transcription-stop'); await darkStop.hover();
      await darkStop.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
      const darkHover = await darkStop.evaluate(element => {
        const style = getComputedStyle(element), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!; context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
        return { background: style.backgroundColor, color: style.color, rgba: Array.from(context.getImageData(0, 0, 1, 1).data) };
      });
      expect(darkHover.rgba[3]).toBeGreaterThan(20); expect(darkHover.rgba[0] - darkHover.rgba[1]).toBeGreaterThan(30); evidence.stopHoverDark = darkHover;
      await page.screenshot({ path: path.join(fixture.artifacts, 'i5-transcription-stop-hover-dark.png'), animations: 'disabled' });
      await darkStop.click(); await uiExpect(page.getByTestId('studio-transcription-task-row')).toHaveAttribute('data-state', 'cancelled');
      await small.evaluate(window => window.setSize(787, 540));
      await page.getByTestId('studio-transcription-runtime-row').scrollIntoViewIfNeeded();
      await uiExpect(page.getByTestId('studio-transcription-runtime-row')).toBeInViewport({ ratio: 1 });
      const compact = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
        noHorizontalOverflow: Array.from(document.querySelectorAll('.studio-transcription-layout, .studio-transcription-settings, .studio-transcription-workspace')).every(element => element.scrollWidth <= element.clientWidth + 1),
        runtimeRowVisible: (() => { const bounds = document.querySelector('[data-testid=studio-transcription-runtime-row]')!.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight; })() }));
      expect(compact.width).toBe(786); expect(compact.height).toBe(540);
      expect(compact.noHorizontalOverflow).toBe(true); expect(compact.runtimeRowVisible).toBe(true); evidence.compactWindow = compact;
      await page.screenshot({ path: path.join(fixture.artifacts, 'i5-transcription-dark-small-runtime.png'), animations: 'disabled' });
      evidence.restart = { settingsRestored: true, completedTaskNotRepeated: true, requests: requests.length };
      expect(pageErrors).toEqual([]);
      passed = true;
    } finally {
      respond = true; releases.splice(0).forEach(release => release());
      await writeFile(path.join(fixture.artifacts, 'i5-transcription-result.json'), JSON.stringify({ outcome: passed ? 'passed' : 'failed', ...evidence, pageErrors }, null, 2));
      await writeFile(path.join(fixture.artifacts, 'i5-transcription-electron.log'), logs.join(''));
      try { await app?.close(); } finally {
        if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
        await fixture.cleanup();
      }
    }
  }, 180000);
});
