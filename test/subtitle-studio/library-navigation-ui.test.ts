import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

describe.runIf(process.env.FUSIONKIT_STUDIO_DENSITY_UI === '1')('responsive document navigation in real Electron', () => {
  it('selects immediately, ignores superseded reads and isolates loading and errors', async () => {
    const artifacts = path.resolve('test-results/studio-density'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')), profile = path.join(root, 'profile');
    const files: string[] = [];
    for (let i = 1; i <= 22; i++) { const file = path.join(root, `${String(i).padStart(2, '0')}-字幕文档.srt`); await writeFile(file, `1\n00:00:01,000 --> 00:00:02,000\nSource ${i}\n`); files.push(file); }
    let app: ElectronApplication | undefined, page: Page | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success', { timeout: 30000 });
      await page.getByRole('button', { name: '完成', exact: true }).click();

      const rows = page.getByTestId('studio-library-row');
      const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-document-id')!));
      const names = await rows.locator('.studio-file-name > .sr-only').allTextContents();
      type DelayState = { hold: string; holding: boolean; fail: boolean; reads: string[]; release?: () => void; restore: () => void };
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const original = handlers.get('subtitle-studio:read-page')!;
        const state: DelayState = { hold: '', holding: false, fail: false, reads: [], restore: () => { state.release?.(); handlers.set('subtitle-studio:read-page', original); } };
        (globalThis as typeof globalThis & { density: DelayState }).density = state;
        handlers.set('subtitle-studio:read-page', async (event, input) => {
          const id = (input as { payload: { documentId: string } }).payload.documentId;
          state.reads.push(id);
          const result = await original(event, input);
          if (state.hold === id) { state.hold = ''; state.holding = true; await new Promise<void>(resolve => { state.release = () => { state.holding = false; resolve(); }; }); }
          if (state.fail) { state.fail = false; throw Error('Controlled navigation transport failure'); }
          return result;
        });
      });
      const hold = async (id: string) => app!.evaluate((_, id) => { (globalThis as typeof globalThis & { density: DelayState }).density.hold = id; }, id);
      const release = async () => app!.evaluate(() => { (globalThis as typeof globalThis & { density: DelayState }).density.release?.(); });
      const loading = page.getByTestId('studio-preview-loading');
      const settleLoading = async () => {
        await uiExpect.poll(() => loading.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
        await page!.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
      };
      await rows.nth(0).getByRole('checkbox').click();
      await hold(ids[1]);
      await rows.nth(1).locator('.studio-document').click();
      await uiExpect(rows.nth(1)).toHaveAttribute('data-current', 'true');
      await uiExpect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { density: DelayState }).density.holding)).toBe(true);
      await uiExpect(loading).toHaveAttribute('data-visible', 'true');
      await uiExpect(page.locator('.studio-library-scroll')).toHaveAttribute('aria-busy', 'false');
      await uiExpect(page.getByRole('button', { name: '打开字幕文件', exact: true })).toBeEnabled();
      expect(await rows.locator('.studio-document:disabled').count()).toBe(0);
      expect(await page.locator('.studio-preview-surface').getAttribute('inert')).not.toBeNull();
      expect(await loading.evaluate(element => getComputedStyle(element).transitionDuration)).toContain('0.16s');
      await settleLoading();
      await page.screenshot({ path: path.join(root, 'loading-light.png') });
      await rows.nth(2).locator('.studio-document').click();
      await uiExpect(rows.nth(2)).toHaveAttribute('data-current', 'true');
      await rows.nth(3).locator('.studio-document').click();
      await uiExpect(rows.nth(3)).toHaveAttribute('data-current', 'true');
      await release();
      await uiExpect(page.getByRole('heading', { name: names[3], exact: true })).toBeVisible();
      await uiExpect(loading).toHaveAttribute('data-visible', 'false');
      const reads = await app.evaluate(() => (globalThis as typeof globalThis & { density: DelayState }).density.reads);
      expect(reads).not.toContain(ids[2]);
      await uiExpect(rows.nth(0)).toHaveAttribute('data-selected', 'true');
      await app.evaluate(() => { (globalThis as typeof globalThis & { density: DelayState }).density.fail = true; });
      await rows.nth(4).locator('.studio-document').click();
      await uiExpect(loading.getByRole('alert')).toBeVisible();
      await uiExpect(rows.nth(4)).toHaveAttribute('data-current', 'true');
      await uiExpect(page.locator('.studio-library-scroll')).toHaveAttribute('aria-busy', 'false');
      await loading.getByRole('button', { name: '重试', exact: true }).click();
      await uiExpect(page.getByRole('heading', { name: names[4], exact: true })).toBeVisible();
      await uiExpect(loading).toHaveAttribute('data-visible', 'false');
      await page.getByTestId('studio-library-search').fill('字幕');
      await uiExpect(page.locator('.studio-library-filter-summary')).toContainText('22');
      await uiExpect(page.locator('.studio-library-scroll')).toHaveAttribute('aria-busy', 'false');
      const geometry = await page.evaluate(() => {
        const height = (s: string) => document.querySelector(s)!.getBoundingClientRect().height;
        return { search: height('.studio-library-tools'), selection: height('.studio-library-selection'), footer: height('.studio-library-footer'), list: height('.studio-library-scroll'), panel: height('.studio-library-panel'), row: height('.studio-library-row') };
      });
      expect(geometry.search).toBeLessThanOrEqual(40); expect(geometry.selection).toBeLessThanOrEqual(34); expect(geometry.footer).toBeLessThanOrEqual(38);
      expect(geometry.list / geometry.panel).toBeGreaterThan(.65);
      await page.screenshot({ path: path.join(root, 'compact-filtered-light.png'), animations: 'disabled' });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await hold(ids[5]); await rows.nth(5).locator('.studio-document').click();
      await uiExpect(loading).toHaveAttribute('data-visible', 'true');
      await win.evaluate(window => window.setSize(786, 540));
      await settleLoading();
      await page.screenshot({ path: path.join(root, 'loading-dark-narrow.png') });
      await release(); await uiExpect(loading).toHaveAttribute('data-visible', 'false');
      await page.locator('#studio-library-trigger').click();
      await uiExpect(page.getByTestId('studio-library')).toBeVisible();
      await page.screenshot({ path: path.join(root, 'compact-dark-narrow.png'), animations: 'disabled' });
      expect(errors).toEqual([]);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ geometry, reads, immediateSelection: true, latestClickWins: true, retryRecovered: true, pageErrors: errors }, null, 2));
    } catch (error) { if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error; }
    finally {
      if (app) { await app.evaluate(() => { (globalThis as typeof globalThis & { density?: { restore: () => void } }).density?.restore(); }).catch(() => {}); await app.close(); }
      if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw Error('unexpected test root');
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, profileRemoved: true }));
    }
  }, 180000);
});
