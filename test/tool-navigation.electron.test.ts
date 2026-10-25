import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolNameMap } from '../src/constants/router';

describe.runIf(process.env.FUSIONKIT_TOOL_UI_E2E === '1')('Tool navigation in native Electron', () => {
  let app: ElectronApplication | undefined;
  let root = '';
  afterAll(async () => {
    try { await app?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });

  it('aligns every tool with Studio and reserves Escape for the innermost interaction', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-tool-navigation-'));
    const artifacts = path.resolve('test-results/tool-navigation');
    await mkdir(artifacts, { recursive: true });
    app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' },
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      for (const tool of ['translation-knowledge', 'subtitle-translator', 'subtitle-converter', 'subtitle-extractor', 'local-subtitle-transcriber', 'name-translator']) {
        localStorage.setItem(`${tool}-tour-done`, '1');
      }
    });
    const nativeWindow = await app.browserWindow(page);
    const openTool = async (route: string) => {
      await page.evaluate(route => { location.hash = route; }, route);
      await page.locator('[data-slot=tool-detail-layout]').first().waitFor();
      await uiExpect(page.locator('h1')).toHaveCount(1);
      await page.waitForTimeout(700);
      await page.locator('.app > [data-slot=scroll-area] [data-slot=scroll-area-viewport]').first().evaluate(element => { element.scrollTop = 0; });
      await page.mouse.move(4, 200);
    };
    const staysOn = async (route: string) => {
      await page.waitForTimeout(150);
      expect(new URL(page.url()).hash).toBe(`#${route}`);
    };
    const evidence: unknown[] = [];
    const routes = ['/tools/subtitle/studio', ...Object.keys(ToolNameMap).filter(route => route !== '/tools/subtitle/studio')];
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']]) {
      await page.evaluate(({ theme, language }) => {
        localStorage.setItem('lang', language);
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        location.hash = '/tools';
      }, { theme, language });
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      expect(await page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark');
      for (const [width, height] of [[1280, 860], [786, 660], [786, 540]]) {
        await nativeWindow.evaluate((win, size) => win.setSize(...size), [width, height] as [number, number]);
        let studioTop = 0;
        for (const route of routes) {
          // The external agent activity page shares the tool layout but is not a
          // tool: Escape navigation belongs to /tools/ pages, and its Back button
          // returns to the previous page, or to Settings on direct entry like this.
          const isTool = route.startsWith('/tools/');
          const parent = isTool ? '/tools' : '/setting?tab=external';
          await openTool(route);
          const label = `${route.replace(/^\/(tools\/)?/, '').replaceAll('/', '-')}-${theme}-${width}x${height}`;
          const geometry = await page.locator('h1').evaluate(element => ({
            top: element.getBoundingClientRect().top,
            expectedTop: 40 + (innerHeight <= 650 ? 20 : 24),
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          }));
          if (route === '/tools/subtitle/studio') studioTop = geometry.top;
          expect(geometry.top, label).toBeCloseTo(studioTop, 0);
          expect(geometry.top, label).toBeCloseTo(geometry.expectedTop, 0);
          expect(geometry.horizontalOverflow, label).toBe(false);
          await page.screenshot({ path: path.join(artifacts, `${label}.png`) });
          evidence.push({ label, ...geometry });

          // Track the actual outgoing header, including AnimatePresence's exit.
          await page.locator('h1').click();
          const departure = page.locator('h1').evaluate(element => new Promise<number[]>(resolve => {
            const tops: number[] = [];
            const sample = () => {
              if (!element.isConnected) { resolve(tops); return; }
              tops.push(element.getBoundingClientRect().top);
              requestAnimationFrame(sample);
            };
            sample();
          }));
          if (route === '/tools/subtitle/studio') {
            // A heavy editing page asks for a second Escape, so a stray one cannot leave it.
            await page.keyboard.press('Escape');
            await uiExpect(page.getByText(/再按一次 Esc|Press Esc again/)).toBeVisible();
            await staysOn(route);
          }
          if (isTool) await page.keyboard.press('Escape');
          else await page.getByRole('button', { name: /^(返回|Back)$/ }).click();
          await uiExpect(page).toHaveURL(isTool ? /#\/tools$/ : /#\/setting\?tab=external$/);
          const tops = await departure;
          expect(Math.max(...tops) - Math.min(...tops), `${label} exit jump`).toBeLessThan(1);
          await uiExpect(page.locator('[data-slot=tool-detail-layout]')).toHaveCount(0);
          // Holding Escape must not continue out of the parent page.
          await page.keyboard.press('Escape');
          await staysOn(parent);
        }
      }
    }
    await writeFile(path.join(artifacts, 'geometry.json'), JSON.stringify(evidence, null, 2));

    await nativeWindow.evaluate(win => win.setSize(1280, 860));
    const knowledge = '/tools/translation-knowledge';
    await openTool(knowledge);
    // The empty library has no collection workspace; create one through the UI first.
    const dialog = page.getByRole('dialog');
    await page.getByTestId('knowledge-new-collection').click();
    await uiExpect(dialog).toBeVisible();
    await dialog.getByRole('textbox').first().fill('Escape QA');
    await page.getByTestId('knowledge-collection-save').click();
    await uiExpect(dialog).toHaveCount(0);
    await uiExpect(page.getByTestId('knowledge-collection-header').locator('h2')).toHaveText('Escape QA');
    await staysOn(knowledge);

    const search = page.getByTestId('knowledge-collection-search');
    await search.fill('unsaved search');
    await page.keyboard.press('Escape');
    await staysOn(knowledge);
    await uiExpect(search).toHaveValue('unsaved search');
    await search.fill('');
    await page.locator('h1').click();
    // IME/repeat/modified Escape is never page navigation.
    await page.evaluate(() => {
      for (const options of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }]) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options }));
      }
    });
    await staysOn(knowledge);
    // A window handler mounted later still gets to consume the same event.
    await page.evaluate(() => window.addEventListener('keydown', event => event.preventDefault(), { once: true }));
    await page.keyboard.press('Escape');
    await staysOn(knowledge);

    await page.getByTestId('knowledge-new-collection').click();
    await uiExpect(dialog).toBeVisible();
    const choice = dialog.getByRole('combobox').first();
    await choice.click();
    await uiExpect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(page.getByRole('listbox')).toHaveCount(0);
    await uiExpect(dialog).toBeVisible();
    await staysOn(knowledge);
    await page.keyboard.press('Escape');
    await uiExpect(dialog).toHaveCount(0);
    await staysOn(knowledge);

    await page.getByTestId('knowledge-tour-trigger').click();
    await uiExpect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(dialog).toHaveCount(0);
    await staysOn(knowledge);

    await page.getByTestId('knowledge-collection-actions').click();
    await uiExpect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(page.getByRole('menu')).toHaveCount(0);
    await staysOn(knowledge);
    await page.keyboard.press('Escape');
    await uiExpect(page).toHaveURL(/#\/tools$/);

    await openTool('/tools/subtitle/converter');
    await page.locator('h1').click();
    await page.locator('[data-slot=tool-file-drop-scope]').evaluate(element => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['[00:00.00]Escape'], 'escape.lrc'));
      element.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }));
    });
    await uiExpect(page.getByTestId('tool-page-drop-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(page.getByTestId('tool-page-drop-overlay')).toHaveCount(0);
    await staysOn('/tools/subtitle/converter');
    await page.keyboard.press('Escape');
    await uiExpect(page).toHaveURL(/#\/tools$/);

    // Direct entry/reload and the visible Back button use the same safe parent.
    await openTool(knowledge);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await page.locator('h1').click();
    await page.keyboard.press('Escape');
    await uiExpect(page).toHaveURL(/#\/tools$/);
    await openTool(knowledge);
    await page.getByRole('button', { name: /^(返回|Back)$/ }).click();
    await uiExpect(page).toHaveURL(/#\/tools$/);
    expect(errors).toEqual([]);
  }, 240000);
});
