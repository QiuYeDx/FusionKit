import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

const enabled = process.env.FUSIONKIT_STUDIO_I6_WORKSPACE_UI === '1';
type MainObservation = {
  bodyReads: number; selectionReads: number; holdNextSelection: boolean; holding: boolean;
  release?: () => void; restore: () => void;
};
type SelectionObservation = { busy: string[]; disabled: string[]; loading: number; observer: MutationObserver };

async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function watchSelection(page: Page) {
  await page.evaluate(() => {
    const host = window as typeof window & { studioSelectionObservation?: SelectionObservation };
    host.studioSelectionObservation?.observer.disconnect();
    const observation: SelectionObservation = { busy: [], disabled: [], loading: 0, observer: new MutationObserver(records => {
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!element) continue;
        if (record.attributeName === 'aria-busy' && element.matches('.studio-preview-region, .studio-library-scroll') && record.oldValue === 'false') observation.busy.push(element.className);
        if (record.attributeName === 'disabled' && element.matches('#studio-delete-trigger, .studio-document, .studio-library-pagination button, button[aria-label="刷新"]') && record.oldValue === null) observation.disabled.push(element.getAttribute('aria-label') ?? element.className);
        if (element.closest('.studio-footer-status') && element.textContent?.includes('正在读取')) observation.loading++;
      }
    }) };
    host.studioSelectionObservation = observation;
    observation.observer.observe(document.querySelector('[data-testid=subtitle-studio]')!, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['aria-busy', 'disabled'], childList: true, characterData: true });
  });
}
async function finishSelectionObservation(page: Page) {
  return page.evaluate(() => {
    const observation = (window as typeof window & { studioSelectionObservation: SelectionObservation }).studioSelectionObservation;
    observation.observer.disconnect();
    return { busy: observation.busy, disabled: observation.disabled, loading: observation.loading };
  });
}
async function geometry(page: Page) {
  await frames(page);
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid=subtitle-studio]')!;
    const measure = (element: Element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }; };
    const active = root.querySelector('.studio-workspace-content[data-state=active]')!;
    return { header: measure(root.querySelector('.studio-workspace-header')!), stage: measure(root.querySelector('.studio-workspace-tabs > [data-slot=clip-path-tabs-stage]')!),
      contentTop: measure(active.querySelector('[data-slot=tool-detail-layout] > .grid')!).top,
      scrollTop: root.closest('[data-radix-scroll-area-viewport]')!.scrollTop,
      viewport: { ...measure(root.closest('[data-radix-scroll-area-viewport]')!), clientHeight: root.closest('[data-radix-scroll-area-viewport]')!.clientHeight, scrollHeight: root.closest('[data-radix-scroll-area-viewport]')!.scrollHeight },
      scrollMinHeight: getComputedStyle(document.querySelector('.app > [data-slot=scroll-area]')!).minHeight,
      spacer: { ...measure(document.querySelector('.app > .h-10:not(.app-region-drag)')!), shrink: getComputedStyle(document.querySelector('.app > .h-10:not(.app-region-drag)')!).flexShrink },
      headerPadding: [...active.querySelectorAll('[data-slot=tool-panel-header], [data-slot=tool-config-header]')].map(header => ({ top: getComputedStyle(header).paddingTop, bottom: getComputedStyle(header).paddingBottom })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

describe.runIf(enabled)('I6 actual Electron workspace layout and selection', () => {
  it('keeps view origins stable and selection local through slow reads, new queries and disposal', async () => {
    const artifacts = path.resolve('test-results/studio-i6-workspace'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const evidence: Record<string, unknown> = {}; const errors: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      const files = await Promise.all(Array.from({ length: 41 }, async (_, index) => {
        const file = path.join(root, `document-${String(index).padStart(2, '0')}-工作区局部选择与当前正文保留.lrc`);
        await writeFile(file, Array.from({ length: 120 }, (_, cue) => `[${String(Math.floor(cue / 60)).padStart(2, '0')}:${String(cue % 60).padStart(2, '0')}.00]Document ${index}, cue ${cue + 1}`).join('\n'));
        return file;
      }));
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
      await page.reload(); await ready(page);
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: chosen }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toBeVisible();
      await uiExpect(page.getByTestId('studio-library-result').locator('li')).toHaveCount(0);
      await page.locator('#studio-result-close').click(); await ready(page);
      await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(20);

      // Observe only the real registered handlers. Delays occur after their authority checks and reads.
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        if (!(handlers instanceof Map)) throw new Error('Registered handler observations are unavailable.');
        const observation: MainObservation = { bodyReads: 0, selectionReads: 0, holdNextSelection: false, holding: false, restore: () => {} };
        const originals = new Map<string, Handler>();
        for (const channel of ['subtitle-studio:list', 'subtitle-studio:read-page']) {
          const original = handlers.get(channel); if (!original) throw new Error(`Missing production handler ${channel}`); originals.set(channel, original);
          handlers.set(channel, async (event, input) => {
            const selection = channel === 'subtitle-studio:list' && (input as { payload?: { pageSize?: number } })?.payload?.pageSize === 100;
            if (channel === 'subtitle-studio:read-page') observation.bodyReads++;
            if (selection) observation.selectionReads++;
            const result = await original(event, input);
            if (selection && observation.holdNextSelection) {
              observation.holdNextSelection = false; observation.holding = true;
              await new Promise<void>(resolve => { observation.release = () => { observation.holding = false; observation.release = undefined; resolve(); }; });
            }
            return result;
          });
        }
        observation.restore = () => { observation.release?.(); for (const [channel, original] of originals) handlers.set(channel, original); };
        (globalThis as typeof globalThis & { studioWorkspaceObservation?: MainObservation }).studioWorkspaceObservation = observation;
      });
      const mainCounts = () => app!.evaluate(() => { const state = (globalThis as typeof globalThis & { studioWorkspaceObservation: MainObservation }).studioWorkspaceObservation; return { bodyReads: state.bodyReads, selectionReads: state.selectionReads }; });
      const holdSelection = () => app!.evaluate(() => { (globalThis as typeof globalThis & { studioWorkspaceObservation: MainObservation }).studioWorkspaceObservation.holdNextSelection = true; });
      const isHolding = () => app!.evaluate(() => (globalThis as typeof globalThis & { studioWorkspaceObservation: MainObservation }).studioWorkspaceObservation.holding);
      const releaseSelection = () => app!.evaluate(() => { (globalThis as typeof globalThis & { studioWorkspaceObservation: MainObservation }).studioWorkspaceObservation.release?.(); });
      const selection = page.getByTestId('studio-library-select-all');
      const selectedCount = page.locator('.studio-library-selected-count');
      const clearSelection = async () => {
        await page.getByRole('button', { name: '选择范围', exact: true }).click();
        await page.getByRole('menuitem', { name: '清空选择', exact: true }).click();
      };
      const switchView = async (value: 'documents' | 'transcription', fromScroll = false) => {
        const target = page.getByRole('tab', { name: value === 'documents' ? '文档' : '转写', exact: true });
        // Radix activates tabs on keyboard/mousedown, not the standalone DOM click() method.
        // Dispatch keyboard activation without scrolling the header into view before the product handles it.
        if (fromScroll) await target.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); else await target.click();
        await uiExpect(page.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', value);
        if (value === 'transcription') await page.getByTestId('studio-transcription').waitFor();
        await frames(page);
      };
      for (const [width, height, theme] of [[1280, 860, 'light'], [786, 540, 'dark']] as const) {
        await nativeWindow.evaluate((win, dimensions) => win.setSize(...dimensions), [width, height] as [number, number]);
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        await frames(page);
        const documents = await geometry(page);
        if (width >= 1024) await uiExpect(page.locator('.studio-library > [data-testid=studio-translation-overview]')).toBeVisible();
        else {
          const overview = page.locator('.studio-mobile-controls [data-testid=studio-translation-overview-details]');
          await overview.focus(); await page.keyboard.press('Enter');
          await uiExpect(page.getByRole('dialog', { name: '翻译任务', exact: true })).toBeVisible();
          await page.getByRole('dialog', { name: '翻译任务', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
          await uiExpect(overview).toBeFocused();
        }
        await page.screenshot({ path: path.join(root, `${width}-documents.png`), animations: 'disabled' });
        await switchView('transcription');
        await uiExpect(page.getByTestId('studio-translation-overview')).toHaveCount(0);
        await uiExpect(page.getByTestId('studio-translation-overview-details')).toHaveCount(0);
        const transcription = await geometry(page);
        console.log(JSON.stringify({ width, documents, transcription }));
        await page.screenshot({ path: path.join(root, `${width}-transcription.png`), animations: 'disabled' });
        expect(transcription.header).toEqual(documents.header); expect(transcription.stage).toEqual(documents.stage); expect(transcription.contentTop).toBe(documents.contentTop);
        expect(transcription.headerPadding.every(item => item.top === '8px' && item.bottom === '8px')).toBe(true);
        expect(documents.headerPadding.every(item => item.top === '8px' && item.bottom === '8px')).toBe(true);
        expect(documents.horizontalOverflow || transcription.horizontalOverflow).toBe(false);
        expect(transcription.scrollMinHeight).toBe('0px'); expect(transcription.spacer.height).toBe(40); expect(transcription.spacer.shrink).toBe('0');
        if (width < 1024) {
          await page.getByTestId('studio-transcription-advanced').click();
          await uiExpect(page.locator('#studio-transcription-beamSize')).toBeVisible();
          // ToolConfigDisclosure has a 200ms grid transition and a 260ms overflow fallback.
          await page.waitForTimeout(300);
          const scrolled = await page.getByTestId('subtitle-studio').evaluate(element => { const viewport = element.closest('[data-radix-scroll-area-viewport]')!; viewport.scrollTop = viewport.scrollHeight; return viewport.scrollTop; });
          expect(scrolled).toBeGreaterThan(100);
          const end = await page.locator('.studio-transcription-settings').evaluate(element => {
            const bounds = element.getBoundingClientRect(); const viewport = element.closest('[data-radix-scroll-area-viewport]')!.getBoundingClientRect();
            const navigation = document.querySelector('.fixed.bottom-0')!.getBoundingClientRect();
            return { bottom: bounds.bottom, viewportBottom: viewport.bottom, navigationTop: navigation.top };
          });
          expect(end.bottom).toBeLessThanOrEqual(end.navigationTop); expect(end.bottom).toBeLessThanOrEqual(end.viewportBottom);
          await page.screenshot({ path: path.join(root, `${width}-transcription-scroll-end.png`), animations: 'disabled' });
          evidence.transcriptionScrollEnd = { scrolled, ...end };
          await switchView('documents', true);
        } else await switchView('documents');
        const returned = await geometry(page);
        expect(returned.header).toEqual(documents.header); expect(returned.contentTop).toBe(documents.contentTop); expect(returned.scrollTop).toBe(0);
        evidence[`${width}Layout`] = { documents, transcription, returned };
      }

      await nativeWindow.evaluate(win => win.setSize(1280, 860)); await frames(page); await ready(page);
      await page.locator('.studio-reader-footer').getByRole('button', { name: '下一页', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101'); await ready(page);
      const currentName = await page.locator('.studio-document-heading h2').innerText();
      const before = await mainCounts(); await watchSelection(page); await holdSelection();
      await selection.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
      await uiExpect.poll(isHolding).toBe(true);
      await uiExpect(page.getByTestId('studio-library-selection-pending')).toBeVisible();
      expect((await mainCounts()).selectionReads - before.selectionReads).toBe(1);
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      await uiExpect(page.locator('#studio-delete-trigger')).toBeEnabled();
      await releaseSelection(); await uiExpect(selectedCount).toHaveText('已选 41 份');
      await uiExpect(page.getByTestId('studio-library-selection-pending')).toHaveCount(0);
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101');
      await uiExpect(page.locator('.studio-document-heading h2')).toHaveText(currentName, { useInnerText: true });
      expect((await mainCounts()).bodyReads).toBe(before.bodyReads);
      evidence.slowRepeatedSelection = await finishSelectionObservation(page);
      expect(evidence.slowRepeatedSelection).toEqual({ busy: [], disabled: [], loading: 0 });

      // A deliberate clear/toggle during a held all-pages request invalidates its late result.
      await clearSelection();
      await holdSelection(); await selection.click(); await uiExpect.poll(isHolding).toBe(true);
      await clearSelection(); await uiExpect(page.getByTestId('studio-library-selection-pending')).toHaveCount(0);
      await releaseSelection(); await frames(page);
      await uiExpect(page.getByTestId('studio-batch-toolbar')).toHaveCount(0);
      await holdSelection(); await selection.click(); await uiExpect.poll(isHolding).toBe(true);
      await page.getByTestId('studio-library-row').first().getByRole('checkbox').check();
      await uiExpect(page.getByTestId('studio-library-selection-pending')).toHaveCount(0);
      await releaseSelection(); await frames(page); await uiExpect(selectedCount).toHaveText('已选 1 份');
      evidence.cancelledSelection = 'clear and individual toggle retained their newer selection';

      await holdSelection(); await selection.click(); await uiExpect.poll(isHolding).toBe(true);
      await page.getByTestId('studio-library-search').fill('document-00-');
      await uiExpect(page.getByTestId('studio-library-selection-pending')).toHaveCount(0);
      await releaseSelection(); await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(1); await ready(page);
      await uiExpect(page.getByTestId('studio-batch-toolbar')).toHaveCount(0);
      const cachedBefore = await mainCounts(); await watchSelection(page);
      await selection.click(); await uiExpect(selectedCount).toHaveText('已选 1 份');
      const cachedAfter = await mainCounts(); expect(cachedAfter).toEqual(cachedBefore);
      evidence.currentPageSelection = await finishSelectionObservation(page); expect(evidence.currentPageSelection).toEqual({ busy: [], disabled: [], loading: 0 });
      await page.getByTestId('studio-library-search').fill(''); await uiExpect(page.getByTestId('studio-library-row')).toHaveCount(20); await ready(page);

      // A newer repository deletion must prevent the old captured summary from being reselected.
      const doomed = await page.evaluate(async () => { const snapshot = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!snapshot.ok) throw new Error(snapshot.error); return snapshot.value.documents[0]; });
      await holdSelection(); await selection.click(); await uiExpect.poll(isHolding).toBe(true);
      const deleted = await page.evaluate(document => window.subtitleStudio.deleteDocument({ documentId: document.id, revision: document.revision }), doomed); expect(deleted.ok).toBe(true);
      await uiExpect(page.locator('.studio-library-selection-scope')).toContainText('40 份');
      await releaseSelection(); await uiExpect(selectedCount).toHaveText('已选 40 份');
      await uiExpect(page.locator(`[data-document-id="${doomed.id}"]`)).toHaveCount(0);
      evidence.deletedDocumentNotReselected = doomed.id;
      await clearSelection();

      // A disposed root cannot update a newly mounted instance after its outstanding IPC returns.
      await holdSelection(); await selection.click(); await uiExpect.poll(isHolding).toBe(true);
      await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; }); await page.locator('#cvt-tour-queue').waitFor();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await releaseSelection(); await frames(page); await uiExpect(page.getByTestId('studio-batch-toolbar')).toHaveCount(0);
      await uiExpect(page.getByTestId('studio-library-selection-pending')).toHaveCount(0);
      evidence.disposedSelectionIgnored = true;

      // Preserve an existing selection when the actual catalog crosses the hard batch limit.
      await page.getByTestId('studio-library-row').first().getByRole('checkbox').check();
      const extraFiles = await Promise.all(Array.from({ length: 61 }, async (_, index) => { const file = path.join(root, `limit-${index}.lrc`); await writeFile(file, '[00:00.00]Limit fixture\n'); return file; }));
      await app.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: chosen }); }, extraFiles);
      const added = await page.evaluate(() => window.subtitleStudio.importSubtitles({ encoding: 'utf-8' })); expect(added.ok && added.value?.items.length).toBe(61);
      await uiExpect(page.locator('.studio-library-selection-scope')).toHaveText('101 份'); await ready(page);
      const limitBefore = await mainCounts(); await selection.click();
      await uiExpect(page.getByTestId('studio-library-selection-limit')).toContainText('100'); await uiExpect(selectedCount).toHaveText('已选 1 份');
      expect(await mainCounts()).toEqual(limitBefore);
      evidence.limit = { total: 101, selected: 1, additionalReads: 0 };
      expect(errors).toEqual([]);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ ...evidence, actualMainPreloadRepository: true, errors }, null, 2));
    } finally {
      try {
        if (app) { try { await app.evaluate(() => { (globalThis as typeof globalThis & { studioWorkspaceObservation?: MainObservation }).studioWorkspaceObservation?.restore(); }); } finally { await app.close(); } }
      } finally {
        if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw new Error('Profile cleanup escaped the isolated test root.');
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }
  }, 240000);
});
