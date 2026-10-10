import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

const srt = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => {
  const second = String(index).padStart(2, '0');
  return `${index + 1}\n00:00:${second},000 --> 00:00:${second},800\n${prefix} line ${index + 1}\n`;
}).join('\n');

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('expanded subtitle preview', () => {
  it('covers the window in place, keeps the list state and tools, and leaves with Escape after inner layers', async () => {
    const artifacts = path.resolve('test-results/studio-preview-expansion'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const first = path.join(root, 'alpha.srt'), second = path.join(root, 'beta.srt');
    await writeFile(first, srt('Alpha', 40)); await writeFile(second, srt('Beta', 12));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.show(); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      for (const file of [second, first]) {
        await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
        await page.getByRole('button', { name: '打开字幕文件', exact: true }).first().click();
        await uiExpect(page.locator('.studio-document-heading')).toContainText(path.basename(file));
      }
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows.first()).toContainText('Alpha line 1');
      const main = page.locator('.studio-main');
      const expand = page.getByTestId('studio-preview-expand');
      const regionWidth = () => page.locator('.studio-preview-region').evaluate(element => element.getBoundingClientRect().width);
      // Pauses the preview view transition part way, measures and captures it, then lets it finish.
      const midTransition = async (file: string) => {
        await page.waitForFunction(() => document.getAnimations().some(animation => (animation.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-group(studio-preview)'));
        const width = await page.evaluate(() => {
          for (const animation of document.getAnimations()) {
            if (!(animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')) continue;
            animation.pause(); animation.currentTime = 70;
          }
          return parseFloat(getComputedStyle(document.documentElement, '::view-transition-group(studio-preview)').width);
        });
        await page.screenshot({ path: path.join(artifacts, `${file}-a.png`) });
        await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.currentTime = 220; });
        await page.screenshot({ path: path.join(artifacts, `${file}-b.png`) });
        await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play(); });
        await page.waitForFunction(() => !document.documentElement.classList.contains('studio-preview-transition'));
        return width;
      };

      // Select a cue and scroll, then expand: the same list keeps both.
      await rows.nth(1).locator('.studio-cue-number').click();
      await page.locator('.studio-reader').evaluate(element => { element.scrollTop = 120; });
      const inlineWidth = await regionWidth();
      await expand.click();
      // The panel grows from its place in the page into the expanded view.
      const growing = await midTransition('00-expanding');
      await uiExpect(main).toHaveClass(/studio-main-expanded/);
      expect(growing).toBeGreaterThan(inlineWidth + 20);
      expect(growing).toBeLessThan(await regionWidth() - 20);
      await uiExpect(expand).toHaveAttribute('aria-pressed', 'true');
      await uiExpect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      expect(await page.locator('.studio-reader').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      const box = await page.locator('.studio-preview-panel').boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(box!.width).toBeGreaterThan(viewport.width - 40);
      expect(box!.height).toBeGreaterThan(viewport.height - 110);
      // The covered library and workspace tabs leave the tab order.
      expect(await page.locator('.studio-library').evaluate(element => !!element.closest('[inert]'))).toBe(true);
      expect(await page.getByRole('tab', { name: '转写', exact: true }).evaluate(element => !!element.closest('[inert]'))).toBe(true);
      expect(await main.evaluate(element => !!element.closest('[inert]'))).toBe(false);
      // Above the bottom navigation, below the title bar.
      const covering = await page.evaluate(() => {
        const at = (x: number, y: number) => document.elementFromPoint(x, y);
        return { bottom: !!at(innerWidth / 2, innerHeight - 24)?.closest('.studio-main'), title: !!at(innerWidth / 2, 20)?.closest('.app-region-drag') };
      });
      expect(covering).toEqual({ bottom: true, title: true });
      // The floating assistant button stays clear of the footer.
      const footer = await page.locator('.studio-preview-panel [data-slot=tool-panel-footer]').boundingBox();
      const dock = await page.getByTestId('agent-dock-launcher').boundingBox().catch(() => null);
      if (dock) expect(dock.x + dock.width <= footer!.x + 12 || dock.y >= footer!.y + footer!.height - 1).toBe(true);
      await page.screenshot({ path: path.join(artifacts, '01-expanded.png') });

      // Reading size steps change the cue text and persist.
      const size = () => rows.first().locator('.studio-cue-text').evaluate(element => getComputedStyle(element).fontSize);
      expect(await size()).toBe('15px');
      await page.getByTestId('studio-preview-text-larger').click();
      expect(await size()).toBe('17px');
      await page.getByTestId('studio-preview-text-larger').click();
      await uiExpect(page.getByTestId('studio-preview-text-larger')).toBeDisabled();
      expect(await page.evaluate(() => localStorage.getItem('fusionkit-studio-reader-size'))).toBe('3');
      await page.screenshot({ path: path.join(artifacts, '02-larger-text.png') });
      await page.getByTestId('studio-preview-text-smaller').click(); await page.getByTestId('studio-preview-text-smaller').click();

      // Editing works in place; Escape in the editor only cancels the editor.
      await rows.nth(2).locator('[data-field=source]').dblclick();
      const editor = rows.nth(2).locator('.studio-cue-editor textarea');
      await editor.fill('Alpha line 3, revised'); await editor.press('Enter');
      await uiExpect(rows.nth(2).locator('[data-field=source]')).toHaveText('Alpha line 3, revised');
      await rows.nth(3).locator('[data-field=source]').dblclick();
      await rows.nth(3).locator('.studio-cue-editor textarea').press('Escape');
      await uiExpect(rows.nth(3).locator('.studio-cue-editor')).toHaveCount(0);
      await uiExpect(main).toHaveClass(/studio-main-expanded/);

      // A context menu closes first; then the selection clears; only then does the view collapse.
      await rows.nth(4).click({ button: 'right' });
      await uiExpect(page.getByTestId('studio-cue-context-menu')).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '03-menu-over-expanded.png') });
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('studio-cue-context-menu')).toBeHidden();
      await uiExpect(main).toHaveClass(/studio-main-expanded/);
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('studio-cue-selected-count')).toHaveText('');
      await uiExpect(main).toHaveClass(/studio-main-expanded/);

      // Full screen leaves on the first Escape and the view on the next. Real
      // full screen is stubbed so test windows never cover the screen.
      await page.evaluate(() => {
        let element: Element | null = null;
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
        document.documentElement.requestFullscreen = async () => { element = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); };
        document.exitFullscreen = async () => { element = null; document.dispatchEvent(new Event('fullscreenchange')); };
      });
      // The view fades out and back in around each window resize.
      await main.evaluate(element => {
        const fades: string[] = (window as unknown as { __fades: string[] }).__fades = [];
        const animate = element.animate.bind(element);
        element.animate = (keyframes, options) => { fades.push((keyframes as Keyframe[]).map(frame => frame.opacity).join('>')); return animate(keyframes, options); };
      });
      await page.getByTestId('studio-preview-fullscreen').click();
      await uiExpect(page.getByTestId('studio-preview-fullscreen')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('studio-preview-fullscreen')).toHaveAttribute('aria-pressed', 'false');
      await page.waitForFunction(() => (window as unknown as { __fades: string[] }).__fades.length === 4);
      expect(await page.evaluate(() => (window as unknown as { __fades: string[] }).__fades)).toEqual(['1>0', '0>1', '1>0', '0>1']);
      await main.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      expect(await main.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
      await uiExpect(main).toHaveClass(/studio-main-expanded/);

      // Switching documents stays expanded.
      await uiExpect(page.getByTestId('studio-preview-previous-document')).toBeDisabled();
      await page.getByTestId('studio-preview-next-document').click();
      await uiExpect(page.locator('.studio-document-heading')).toContainText('beta.srt');
      await uiExpect(rows.first()).toContainText('Beta line 1');
      await uiExpect(page.getByTestId('studio-preview-next-document')).toBeDisabled();
      await page.getByTestId('studio-preview-previous-document').click();
      await uiExpect(page.locator('.studio-document-heading')).toContainText('alpha.srt');

      // Escape collapses without leaving the tool page; the library is usable again.
      await page.getByTestId('studio-cue-list').focus();
      const expandedWidth = await regionWidth();
      await page.keyboard.press('Escape');
      // And shrinks back into the page.
      const shrinking = await midTransition('05-collapsing');
      await uiExpect(main).not.toHaveClass(/studio-main-expanded/);
      expect(shrinking).toBeLessThan(expandedWidth - 20);
      expect(shrinking).toBeGreaterThan(await regionWidth() + 20);
      await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toContain('/tools/subtitle/studio');
      expect(await page.locator('.studio-library').evaluate(element => !!element.closest('[inert]'))).toBe(false);
      await uiExpect(rows.nth(2).locator('[data-field=source]')).toHaveText('Alpha line 3, revised');
      expect(await size()).toBe('13px');
      await page.screenshot({ path: path.join(artifacts, '04-collapsed.png') });
      expect(errors).toEqual([]);
    } finally { await app?.close(); }
  }, 120000);
});
