import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

const enabled = process.env.FUSIONKIT_PRELOAD_LOADING_UI === '1';
const artifacts = path.resolve('test-results/preload-loading');

async function loaderState(page: Page) {
  return page.evaluate(() => ({
    visibility: document.visibilityState,
    loader: !!document.querySelector('.app-loading-wrap'),
    style: !!document.querySelector('#app-loading-style'),
    progress: document.querySelector('.app-loading-wrap')?.getAttribute('aria-valuenow') ?? null,
    exit: document.querySelector('.app-loading-wrap')?.classList.contains('fk-exiting') ?? false,
    rendered: !!document.querySelector('[data-testid="subtitle-studio"]'),
    language: localStorage.getItem('lang'),
    dark: document.documentElement.classList.contains('dark'),
    frameCount: (window as typeof window & { loadingProbe?: { frames: number; starts: number } }).loadingProbe?.frames ?? 0,
    startSignals: (window as typeof window & { loadingProbe?: { frames: number; starts: number } }).loadingProbe?.starts ?? 0,
  }));
}

async function waitForExit(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'), undefined, { timeout: 8000 });
  await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
}

describe.runIf(enabled)('production preload loading lifecycle in real Electron', () => {
  it('restarts after a hidden reload, recovers a missing start notification, and reloads each theme and language', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    const errors: string[] = [];
    const stages: unknown[] = [];
    let nativeState: (() => Promise<unknown>) | undefined;
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await waitForExit(page);
      const win = await app.browserWindow(page);
      await win.evaluate(window => window.setSize(1280, 860));
      type NativeProbe = { hides: number; shows: number; focuses: number };
      await win.evaluate(window => {
        const state = { hides: 0, shows: 0, focuses: 0 };
        (window as typeof window & { loadingNativeProbe: NativeProbe }).loadingNativeProbe = state;
        window.on('hide', () => { state.hides++; });
        window.on('show', () => { state.shows++; });
        window.on('focus', () => { state.focuses++; });
      });
      nativeState = () => win.evaluate(window => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
        events: (window as typeof window & { loadingNativeProbe: NativeProbe }).loadingNativeProbe,
        showListeners: window.listeners('show').map((listener: (...args: unknown[]) => void) => listener.toString()),
      }));
      stages.push({ stage: 'initial', state: await loaderState(page) });

      await page.addInitScript(() => {
        const state = { frames: 0, starts: 0 };
        (window as typeof window & { loadingProbe: typeof state }).loadingProbe = state;
        window.ipcRenderer.on('fusionkit-start-loading-progress', () => { state.starts++; });
        const countFrame = () => { state.frames++; requestAnimationFrame(countFrame); };
        requestAnimationFrame(countFrame);
      });

      // Return from the inspector evaluation before waiting for native events;
      // awaiting show inside that evaluation can stall AppKit event delivery.
      await win.evaluate(window => window.hide());
      await uiExpect.poll(() => win.evaluate(window => (window as typeof window & { loadingNativeProbe: NativeProbe }).loadingNativeProbe.hides), { timeout: 2000 }).toBe(1);
      expect(await win.evaluate(window => window.isVisible())).toBe(false);
      await page.reload();
      await page.getByTestId('subtitle-studio').waitFor();
      stages.push({ stage: 'hidden-reload', state: await loaderState(page) });
      // DevTools can keep document.visibilityState visible while the native
      // window is hidden, so native visibility is the authority in this case.
      expect(await win.evaluate(window => window.isVisible())).toBe(false);
      expect(await loaderState(page)).toMatchObject({ loader: true, style: true, progress: '0', rendered: true });
      await win.evaluate(window => window.show());
      expect(await win.evaluate(window => window.isVisible())).toBe(true);
      // Visibility recovery must start the normal animation, rather than relying
      // on the deadline to remove a loader whose progress never started.
      await uiExpect.poll(async () => Number((await loaderState(page!)).progress), { timeout: 2000 }).toBeGreaterThan(0);
      await waitForExit(page);
      stages.push({ stage: 'shown-after-hidden-reload', state: await loaderState(page) });
      await page.screenshot({ path: path.join(root, 'hidden-reload-recovered.png') });
      stages.push({ stage: 'native-show', state: await nativeState() });

      // Drop only this internal notification for one navigation. The renderer,
      // all bridges, and the actual loading animation remain production code.
      await win.evaluate(window => {
        const original = window.webContents.send;
        const send = original.bind(window.webContents);
        window.webContents.once('did-finish-load', () => { window.webContents.send = original; });
        window.webContents.send = (channel: string, ...args: unknown[]) => {
          if (channel !== 'fusionkit-start-loading-progress') send(channel, ...args);
        };
      });
      const missingStartAt = Date.now();
      await page.reload();
      await page.getByTestId('subtitle-studio').waitFor();
      stages.push({ stage: 'missing-start-notification', state: await loaderState(page) });
      await waitForExit(page);
      stages.push({ stage: 'missing-start-recovered', elapsedMs: Date.now() - missingStartAt, state: await loaderState(page) });
      await page.screenshot({ path: path.join(root, 'missing-start-recovered.png') });

      await win.evaluate(window => {
        const original = window.webContents.send;
        const send = original.bind(window.webContents);
        window.webContents.once('did-finish-load', () => { window.webContents.send = original; });
        window.webContents.send = (channel: string, ...args: unknown[]) => {
          if (channel === 'fusionkit-start-loading-progress') {
            setTimeout(() => { if (!window.webContents.isDestroyed()) send(channel, ...args); }, 800);
          } else send(channel, ...args);
        };
      });
      await page.reload();
      await page.getByTestId('subtitle-studio').waitFor();
      expect(await loaderState(page)).toMatchObject({ loader: true, progress: '0' });
      stages.push({ stage: 'delayed-start-notification', state: await loaderState(page) });
      await uiExpect.poll(async () => Number((await loaderState(page!)).progress), { timeout: 2000 }).toBeGreaterThan(0);
      await waitForExit(page);
      stages.push({ stage: 'delayed-start-recovered', state: await loaderState(page) });

      for (const [language, theme] of [['zh', 'light'], ['zh', 'dark'], ['en', 'dark'], ['en', 'light']] as const) {
        await page.evaluate(({ language, theme }) => {
          localStorage.setItem('lang', language);
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        }, { language, theme });
        const startedAt = Date.now();
        await page.reload();
        await waitForExit(page);
        expect((await loaderState(page)).dark).toBe(theme === 'dark');
        stages.push({ stage: `${language}-${theme}`, elapsedMs: Date.now() - startedAt, state: await loaderState(page) });
        await page.screenshot({ path: path.join(root, `${language}-${theme}.png`) });
      }

      // Hold the real renderer-ready notification beyond the former deadline.
      // A slow renderer must keep its overlay even when progress reaches 92%.
      await page.addInitScript(() => {
        const original = window.postMessage.bind(window);
        const state = window as typeof window & { releaseLoadingReady?: () => void };
        window.postMessage = (message: unknown, targetOrigin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
          const send = () => {
            if (typeof targetOrigin === 'string') original(message, targetOrigin, transfer);
            else original(message, targetOrigin);
          };
          if (message && typeof message === 'object' && 'payload' in message && message.payload === 'removeLoading') {
            state.releaseLoadingReady = send;
          } else send();
        };
      });
      await page.reload();
      await page.waitForFunction(() => typeof (window as typeof window & { releaseLoadingReady?: () => void }).releaseLoadingReady === 'function');
      await new Promise(resolve => setTimeout(resolve, 5200));
      expect(await loaderState(page)).toMatchObject({ loader: true, style: true, progress: '92', exit: false });
      stages.push({ stage: 'renderer-ready-held-beyond-deadline', state: await loaderState(page) });
      await page.screenshot({ path: path.join(root, 'renderer-ready-held.png') });
      await page.evaluate(() => (window as typeof window & { releaseLoadingReady: () => void }).releaseLoadingReady());
      await waitForExit(page);
      stages.push({ stage: 'renderer-ready-released', state: await loaderState(page) });
      expect(errors).toEqual([]);
      const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ stages, errors, main: await sha256('dist-electron/main/index.js'), preload: await sha256('dist-electron/preload/index.mjs') }, null, 2));
    } catch (error) {
      await writeFile(path.join(root, 'failure.json'), JSON.stringify({ error: String(error), stages, errors, state: page ? await loaderState(page).catch(() => null) : null, native: await nativeState?.().catch(() => null) }, null, 2));
      await page?.screenshot({ path: path.join(root, 'failure.png'), timeout: 3000 }).catch(() => {});
      throw error;
    } finally {
      await app?.close();
      if (path.dirname(profile) !== root || path.dirname(root) !== artifacts) throw new Error('Profile escaped owned root');
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, profileRemoved: true }));
    }
  }, 90000);
});
