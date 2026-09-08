import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio vertical workspace', () => {
  let app: ElectronApplication | undefined;
  let root: string;
  afterAll(async () => {
    try { await app?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  it('uses the space between the title bar and navigation for the reader', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-height-'));
    const artifacts = path.resolve('test-results/subtitle-studio-height');
    await mkdir(artifacts, { recursive: true });
    const name = 'Long-interview-字幕工作台-完整字幕-September-2026.lrc';
    await writeFile(path.join(root, name), Array.from({ length: 205 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00]${i % 5 === 0 ? 'A longer subtitle with details and line wrapping. '.repeat(4) : 'Short subtitle.'}`).join('\n'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1'); location.hash = '/tools/subtitle/studio'; });
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    const window = await app.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 860));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.join(root, name));
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
    await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    for (const [width, height] of [[1280, 860], [1106, 756], [786, 540], [786, 900], [1440, 1100]]) {
      await window.evaluate((win, size) => win.setSize(...size), [width, height] as [number, number]);
      await page.locator('.studio').evaluate(element => {
        const viewport = element.closest('[data-radix-scroll-area-viewport]')!;
        viewport.scrollTop = 0;
      });
      await page.waitForTimeout(350);
      const measurements = await page.evaluate(() => {
        const title = document.querySelector('.app-region-drag')!.getBoundingClientRect();
        const heading = document.querySelector('.studio h1')!.getBoundingClientRect();
        const panel = document.querySelector('.studio-preview-panel')!.getBoundingClientRect();
        const reader = document.querySelector('.studio-reader')!.getBoundingClientRect();
        const nav = document.querySelector('.fixed.bottom-0')!.getBoundingClientRect();
        const viewport = document.querySelector('.studio')!.closest('[data-radix-scroll-area-viewport]')!;
        return { width: innerWidth, height: innerHeight, topGap: heading.top - title.bottom, bottomGap: nav.top - panel.bottom, readerHeight: reader.height, pageOverflow: viewport.scrollHeight - viewport.clientHeight };
      });
      console.log(JSON.stringify(measurements));
      await page.screenshot({ path: path.join(artifacts, `${width}-${height}.png`), animations: 'disabled' });
      expect(measurements.topGap).toBeLessThanOrEqual(25);
      expect(measurements.topGap).toBeGreaterThanOrEqual(12);
      expect(measurements.bottomGap).toBeGreaterThanOrEqual(6);
      expect(measurements.bottomGap).toBeLessThanOrEqual(20);
      expect(measurements.pageOverflow).toBeLessThanOrEqual(1);
      expect(measurements.readerHeight).toBeGreaterThanOrEqual(width < 1024 ? 128 : 300);
    }
    await page.getByRole('tab', { name: '原始内容' }).click();
    await uiExpect(page.locator('.studio-raw pre').first()).toContainText('[00:00.00]');
    const before = await page.locator('.studio-reader').evaluate(element => element.clientHeight);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(page.locator('.studio-raw li > span').first()).toHaveText('101');
    expect(await page.locator('.studio-reader').evaluate(element => element.clientHeight)).toBe(before);
    await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) {
        const result = await window.subtitleStudio.importSubtitle({ encoding: 'utf-8' });
        if (!result.ok) throw new Error('Fixture import failed');
      }
    });
    await uiExpect(page.locator('.studio-document')).toHaveCount(13);
    await window.evaluate(win => win.setSize(1280, 650));
    await page.waitForTimeout(350);
    expect(await page.locator('.studio').evaluate(element => {
      const viewport = element.closest('[data-radix-scroll-area-viewport]')!;
      return viewport.scrollHeight - viewport.clientHeight;
    })).toBeLessThanOrEqual(1);
    expect(await page.locator('.studio-library').evaluate(element => {
      const panel = element.querySelector('[data-slot=tool-panel]')!.getBoundingClientRect();
      const nav = document.querySelector('.fixed.bottom-0')!.getBoundingClientRect();
      return panel.bottom <= nav.top - 6;
    })).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'long-library.png'), animations: 'disabled' });
    await writeFile(path.join(root, name), '[offset:-1500]\n[00:01.00]A <00:00.10>word\nUntimed text\n');
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.locator('.studio-diagnostics')).toBeVisible();
    await window.evaluate(win => win.setSize(786, 540));
    await page.locator('.studio-diagnostics summary').click();
    await page.waitForTimeout(350);
    expect(await page.locator('.studio-reader').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(120);
    expect(await page.locator('.studio-reader-footer').evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.fixed.bottom-0')!.getBoundingClientRect().top)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'narrow-diagnostics.png'), animations: 'disabled' });
    await page.locator('.studio-preview-panel > [data-slot=tool-panel-body]').evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await page.locator('.studio-cue-text').evaluate(element => {
      const body = element.closest('[data-slot=tool-panel-body]')!.getBoundingClientRect();
      const cue = element.getBoundingClientRect();
      return cue.top >= body.top && cue.bottom <= body.bottom;
    })).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'narrow-diagnostics-reader.png'), animations: 'disabled' });
    await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; });
    await page.locator('#cvt-tour-queue').waitFor();
    await page.locator('h1').evaluate(element => { element.closest('[data-radix-scroll-area-viewport]')!.scrollTop = 0; });
    await page.waitForTimeout(350);
    await uiExpect(page.locator('.w-screen.overflow-x-clip')).toHaveCSS('padding-top', '40px');
    await page.screenshot({ path: path.join(artifacts, 'reference-converter.png'), animations: 'disabled' });
    expect(errors).toEqual([]);
  }, 60000);
});
