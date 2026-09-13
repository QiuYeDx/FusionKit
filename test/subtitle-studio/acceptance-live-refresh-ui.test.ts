import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

const enabled = process.env.FUSIONKIT_STUDIO_I5_REFRESH_UI === '1';
type MainEvidence = {
  reads: Record<string, number>; lists: number; holdNextList: boolean; holding: boolean;
  failNextList: boolean; drops: string[][]; release?: () => void; restore: () => void;
};
type RendererEvidence = { busy: string[]; disabled: string[]; observer: MutationObserver };

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}
async function watchRefresh(page: Page) {
  await page.evaluate(() => {
    const host = window as typeof window & { studioRefreshEvidence?: RendererEvidence };
    host.studioRefreshEvidence?.observer.disconnect();
    const evidence: RendererEvidence = { busy: [], disabled: [], observer: new MutationObserver(records => {
      for (const record of records) {
        const element = record.target as Element;
        if (record.attributeName === 'aria-busy' && element.matches('.studio-preview-region, .studio-library-scroll') && record.oldValue === 'false') evidence.busy.push(element.className);
        if (record.attributeName === 'disabled' && element.matches('#studio-delete-trigger, .studio-document, button[aria-label="刷新"]') && record.oldValue === null) evidence.disabled.push(element.getAttribute('aria-label') ?? element.className);
      }
    }) };
    host.studioRefreshEvidence = evidence;
    evidence.observer.observe(document.querySelector('[data-testid=subtitle-studio]')!, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['aria-busy', 'disabled'] });
  });
}
async function stopWatching(page: Page) {
  return page.evaluate(() => {
    const evidence = (window as typeof window & { studioRefreshEvidence?: RendererEvidence }).studioRefreshEvidence!;
    evidence.observer.disconnect(); return { busy: evidence.busy, disabled: evidence.disabled };
  });
}
async function toolbarGeometry(page: Page) {
  return page.locator('.studio-translation-toolbar').evaluate(toolbar => {
    const left = toolbar.querySelector('.studio-translation-track-controls')!;
    const selector = left.querySelector('[role=combobox]')!.getBoundingClientRect();
    const clear = left.querySelector('button[aria-label]:not([role=combobox])')!.getBoundingClientRect();
    const firstStatus = toolbar.querySelector('.studio-translation-status > span:first-child')!.getBoundingClientRect();
    const bounds = toolbar.getBoundingClientRect();
    return { gap: clear.left - selector.right, centerDifference: Math.abs((selector.top + selector.height / 2) - (clear.top + clear.height / 2)),
      firstStatusCenterDifference: Math.abs((selector.top + selector.height / 2) - (firstStatus.top + firstStatus.height / 2)),
      within: Array.from(toolbar.querySelectorAll('.studio-translation-track-controls, .studio-translation-progress-controls, .studio-translation-task-controls')).every(element => { const rect = element.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right + 1; }),
      emptyTaskControls: Array.from(toolbar.querySelectorAll('.studio-translation-task-controls')).some(element => !element.textContent?.trim() && !element.querySelector('button')) };
  });
}

describe.runIf(enabled)('I5 real Electron reader refresh and toolbar', () => {
  it('keeps progress silent, joins foreground clicks and rejects obsolete query results', async () => {
    const artifacts = path.resolve('test-results/studio-i5-refresh'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const firstName = 'A-long-live-translation-工作台进度与焦点保留.lrc', secondName = 'B-other-document-另一个正在翻译的文档.lrc';
    const source = Array.from({ length: 120 }, (_, index) => `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.00]Workshop sentence ${index + 1}.`).join('\n') + '\n';
    const firstPath = path.join(root, firstName), secondPath = path.join(root, secondName);
    await writeFile(firstPath, source); await writeFile(secondPath, source);
    const replies: Array<(limited?: boolean) => void> = []; let requestCount = 0;
    const pageErrors: string[] = []; const evidence: Record<string, unknown> = {};
    let app: ElectronApplication | undefined; let server: Server | undefined;
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk.toString();
        const parsed = JSON.parse(body); const payload = JSON.parse(parsed.messages[1].content) as { items: { id: string }[] }; requestCount++;
        replies.push((limited = false) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ finish_reason: limited ? 'length' : 'stop', message: { content: limited ? '{"items":[' : JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `受控译文 ${item.id}` })) }) } }], usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 } }));
        });
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'i5-reader', name: 'Controlled reader test', provider: 'OpenAI', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-reader', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'i5-reader', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await ready(page);
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      // These wrappers preserve the registered production handlers and all their authority checks.
      // Only a deliberate one-response delay / transport failure is injected for reader-race tests.
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        if (!(handlers instanceof Map)) throw new Error('Electron invoke handler observations are unavailable.');
        const main = globalThis as typeof globalThis & { studioReaderEvidence?: MainEvidence };
        const state: MainEvidence = { reads: {}, lists: 0, holdNextList: false, holding: false, failNextList: false, drops: [], restore: () => {} };
        const originals = new Map<string, Handler>();
        for (const channel of ['subtitle-studio:list', 'subtitle-studio:read-page', 'subtitle-studio:internal:import-dropped-subtitles']) {
          const original = handlers.get(channel); if (!original) throw new Error(`Missing production handler ${channel}`); originals.set(channel, original);
          handlers.set(channel, async (event, input) => {
            if (channel === 'subtitle-studio:read-page') {
              const payload = (input as { payload?: { documentId?: unknown } })?.payload;
              if (typeof payload?.documentId === 'string') state.reads[payload.documentId] = (state.reads[payload.documentId] ?? 0) + 1;
            } else if (channel === 'subtitle-studio:list') state.lists++;
            else state.drops.push((input as { payload: { paths: string[] } }).payload.paths);
            const result = await original(event, input);
            if (channel === 'subtitle-studio:list' && state.failNextList) { state.failNextList = false; throw new Error('Controlled list transport failure.'); }
            if (channel === 'subtitle-studio:list' && state.holdNextList) {
              state.holdNextList = false; state.holding = true;
              await new Promise<void>(resolve => { state.release = () => { state.holding = false; state.release = undefined; resolve(); }; });
            }
            return result;
          });
        }
        state.restore = () => { state.release?.(); for (const [channel, handler] of originals) handlers.set(channel, handler); };
        main.studioReaderEvidence = state;
      });
      const importFile = async (file: string) => {
        await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
        await page.getByRole('button', { name: '打开字幕文件', exact: true }).click(); await ready(page);
      };
      await importFile(firstPath); await importFile(secondPath);
      const documents = await page.evaluate(async () => { const result = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!result.ok) throw new Error(result.error); return result.value.documents; });
      const first = documents.find(document => document.origin.displayName === firstName)!, second = documents.find(document => document.origin.displayName === secondName)!;
      const start = async (documentId: string) => page.evaluate(async ({ documentId, port }) => {
        const library = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!library.ok) throw new Error(library.error);
        const document = library.value.documents.find(item => item.id === documentId)!;
        const reference = { documentId, revision: document.revision };
        const planned = await window.subtitleStudio.planTranslation({ ...reference, config: { model: { profileId: 'i5-reader', modelKey: 'controlled-reader', endpoint: `http://127.0.0.1:${port}/v1`, apiFormat: 'chat_completions' }, language: 'zh', instructions: '', contextWindow: 65536, maxOutputTokens: 8192, maxBatchCues: 40 } });
        if (!planned.ok) throw new Error(planned.error);
        const started = await window.subtitleStudio.createTranslation({ ...reference, planId: planned.value.planId, apiKey: 'synthetic-key' }); if (!started.ok) throw new Error(started.error);
      }, { documentId, port });
      const reply = async (limited = false) => { await uiExpect.poll(() => replies.length).toBeGreaterThan(0); replies.shift()!(limited); };
      await page.locator('.studio-document').filter({ hasText: firstName }).click(); await start(first.id);
      await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'running');
      await page.locator('.studio-reader-footer').getByRole('button', { name: '下一页', exact: true }).click(); await ready(page);
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101');
      await watchRefresh(page);
      await page.locator('.studio-copy').first().click();
      await page.getByTestId('studio-copy-menu').getByRole('menuitem', { name: '复制原文', exact: true }).click();
      await uiExpect(page.locator('.studio-copy.is-copied')).toHaveCount(1);
      await reply(); await uiExpect(page.locator('.studio-translation-status')).toContainText('1 / 3');
      await uiExpect(page.locator('.studio-copy.is-copied')).toHaveCount(1);
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101');
      await page.getByRole('tab', { name: '原始内容', exact: true }).click();
      const rawScroll = await page.locator('.studio-reader').evaluate(element => { element.scrollTop = 180; return element.scrollTop; }); expect(rawScroll).toBeGreaterThan(0);
      const trackSelector = page.locator('.studio-translation-track-controls [role=combobox]'); await trackSelector.focus();
      await reply(); await uiExpect(page.locator('.studio-translation-status')).toContainText('2 / 3');
      await uiExpect(trackSelector).toBeFocused(); await uiExpect(page.getByRole('tab', { name: '原始内容', exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(await page.locator('.studio-reader').evaluate(element => element.scrollTop)).toBe(rawScroll);
      evidence.wide = await toolbarGeometry(page);
      await page.screenshot({ path: path.join(root, '01-running-light-stable-toolbar.png'), animations: 'disabled' });
      expect(evidence.wide).toMatchObject({ gap: 6, centerDifference: 0, firstStatusCenterDifference: 0, within: true, emptyTaskControls: false });
      await page.getByRole('button', { name: '下载', exact: true }).click(); await page.getByRole('menuitem', { name: '导出字幕', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toBeVisible(); await reply();
      await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed'); await uiExpect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      evidence.liveProgress = await stopWatching(page); expect(evidence.liveProgress).toEqual({ busy: [], disabled: [] });

      // A saved notice is not cleared by another document's background progress.
      await page.getByRole('button', { name: '下载', exact: true }).click(); await page.getByRole('menuitem', { name: '下载原文件', exact: true }).click();
      const destination = page.getByRole('dialog').getByRole('combobox', { name: '保存位置', exact: true }); await destination.click(); await page.getByRole('option', { name: '来源文件所在目录', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '保存到来源目录', exact: true }).click();
      await uiExpect(page.getByTestId('studio-export-result')).toBeVisible();
      await uiExpect(page.getByTestId('studio-export-result').locator('[data-result-id][data-state="success"]')).toHaveCount(1);
      await uiExpect(page.getByTestId('studio-export-result').locator('[data-result-details]')).toHaveCount(0);
      await page.getByRole('dialog', { name: '原文件已保存', exact: true }).getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      await uiExpect(page.locator('.studio-notice').filter({ hasText: '已下载' })).toBeVisible();
      await start(second.id); await uiExpect.poll(() => replies.length).toBeGreaterThan(0);
      const readsBefore = await app.evaluate((_, id) => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.reads[id] ?? 0, first.id);
      await watchRefresh(page); await reply();
      await uiExpect.poll(() => replies.length).toBeGreaterThan(0);
      await uiExpect(page.locator('.studio-notice').filter({ hasText: '已下载' })).toBeVisible();
      const readsAfter = await app.evaluate((_, id) => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.reads[id] ?? 0, first.id);
      expect(readsAfter).toBe(readsBefore); evidence.otherDocumentReads = { readsBefore, readsAfter };
      evidence.otherDocumentProgress = await stopWatching(page); expect(evidence.otherDocumentProgress).toEqual({ busy: [], disabled: [] });

      // The next event read is held after the real main handler produced its snapshot.
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holdNextList = true; });
      await reply();
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holding)).toBe(true);
      await page.locator('.studio-document').filter({ hasText: secondName }).click();
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'true');
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.release?.(); });
      await uiExpect(page.getByRole('heading', { name: secondName, exact: true })).toBeVisible(); await ready(page); evidence.foregroundClick = 'one click joined the held background reader';
      await reply(true); await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed');
      await nativeWindow.evaluate(win => win.setSize(786, 540));
      await page.evaluate(() => { document.documentElement.classList.add('dark'); });
      evidence.narrow = await toolbarGeometry(page);
      await page.screenshot({ path: path.join(root, '02-failed-dark-narrow-toolbar.png'), animations: 'disabled' });
      expect(evidence.narrow).toMatchObject({ gap: 6, centerDifference: 0, firstStatusCenterDifference: 0, within: true, emptyTaskControls: false });
      await nativeWindow.evaluate(win => win.setSize(1280, 860));

      // Query scope changes while a read is pending cannot commit the prior query's rows.
      await app.evaluate(({ BrowserWindow }) => {
        const state = (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence;
        state.holdNextList = true;
        const sender = BrowserWindow.getAllWindows()[0].webContents;
        // Request a real read through the UI's refresh action below; this block only arms observation.
        if (sender.isDestroyed()) throw new Error('The test window disappeared.');
      });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holding)).toBe(true);
      await page.getByTestId('studio-library-search').fill('no-match-in-this-library');
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.release?.(); });
      await ready(page); await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(0);
      await page.getByTestId('studio-library-search').fill(''); await ready(page); await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(2);

      // A genuine read failure stays visible and the existing retry action recovers it.
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.failNextList = true; });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await uiExpect(page.getByRole('alert')).toBeVisible(); await page.getByRole('button', { name: '重试', exact: true }).click(); await ready(page); await uiExpect(page.getByRole('alert')).toHaveCount(0);
      await page.locator('.studio-document').filter({ hasText: firstName }).click(); await ready(page);
      expect(await page.locator('.studio-translation-task-controls').count()).toBe(0);
      await page.screenshot({ path: path.join(root, '03-completed-empty-controls.png'), animations: 'disabled' });

      // The File bridge must run in the drop event even while a quiet read is held.
      const droppedPath = path.join(root, 'C-native-drop-during-background-read.lrc'); await writeFile(droppedPath, '[00:01]Native drop preserved.\n');
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holdNextList = true; });
      await page.evaluate(async documentId => {
        const list = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 100 }); if (!list.ok) throw new Error(list.error);
        const task = list.value.items.find(item => item.documentId === documentId && item.status === 'failed'); if (!task) throw new Error('The failed task was not available.');
        const removed = await window.subtitleStudio.removeTask({ documentId, revision: task.revision, taskId: task.taskId }); if (!removed.ok) throw new Error(removed.error);
      }, second.id);
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holding)).toBe(true);
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.hidden = true; input.dataset.studioReaderDrop = ''; document.body.append(input); });
      await page.locator('[data-studio-reader-drop]').setInputFiles(droppedPath);
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-studio-reader-drop]')!;
        const transfer = new DataTransfer(); Array.from(input.files!).forEach(file => transfer.items.add(file));
        document.querySelector('[data-testid=subtitle-studio]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        input.value = ''; input.remove();
      });
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.drops.length)).toBe(1);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.holding)).toBe(true);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.drops[0])).toEqual([droppedPath]);
      await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence: MainEvidence }).studioReaderEvidence.release?.(); });
      await uiExpect(page.getByRole('heading', { name: path.basename(droppedPath), exact: true })).toBeVisible(); await ready(page);
      evidence.nativeDrop = 'native path captured before held background read settled; input cleared synchronously';
      expect(pageErrors).toEqual([]); expect(requestCount).toBe(6);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ ...evidence, requestCount, controlledProvider: true, actualMainPreloadRepository: true, pageErrors }, null, 2));
    } finally {
      try {
        if (app) { try { await app.evaluate(() => { (globalThis as typeof globalThis & { studioReaderEvidence?: MainEvidence }).studioReaderEvidence?.restore(); }); } finally { await app.close(); } }
      } finally {
        try { await new Promise<void>(resolve => { if (!server) resolve(); else { server.closeAllConnections(); server.close(() => resolve()); } }); }
        finally {
          if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped the isolated test root.');
          await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        }
      }
    }
  }, 240000);
});
