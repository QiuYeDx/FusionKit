import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';

const time = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
/** Lines 3, 120 and 240 mention 法尔童 (line 120 twice). */
const srt = () => importSubtitleText(Array.from({ length: 250 }, (_, index) =>
  `${index + 1}\n${time(index * 1000)} --> ${time(index * 1000 + 500)}\n${[2, 119, 239].includes(index) ? (index === 119 ? '法尔童和法尔童' : '这是法尔童') : `第 ${index + 1} 句`}\n`).join('\n'),
{ format: 'srt', displayName: 'Myth.srt', encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('finding and replacing in the list', () => {
  it('finds across pages, moves between matches, replaces one or all and undoes', async () => {
    const artifacts = path.resolve('test-results/studio-cue-find'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    await new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents')).create(srt());
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const row = (number: number) => rows.filter({ has: page.locator('.studio-cue-number-text', { hasText: new RegExp(`^${number}$`) }) });
      const list = page.getByTestId('studio-cue-list');
      const bar = page.getByTestId('studio-cue-find');
      const query = bar.getByTestId('studio-cue-find-query');
      const count = bar.getByTestId('studio-cue-find-count');
      await page.getByTestId('studio-library-row').filter({ hasText: 'Myth.srt' }).locator('button.studio-document').click();
      await uiExpect(rows).toHaveCount(100);

      // Ctrl+F in the list: the first match is selected and marked.
      await rows.nth(0).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press('Control+f');
      await uiExpect(query).toBeFocused();
      await query.fill('法尔童');
      await uiExpect(count).toHaveText('第 1 / 3 条 · 共 4 处');
      await uiExpect(row(3)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(row(3)).toHaveAttribute('data-find-current', 'true');
      await uiExpect(row(3).locator('mark')).toHaveText('法尔童');
      await shot('studio-cue-find--01-found-1280-light');

      // Enter moves to line 120 on the second page; Shift+Enter comes back.
      await query.press('Enter');
      await uiExpect(count).toHaveText('第 2 / 3 条 · 共 4 处');
      await uiExpect(row(120)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(row(120).locator('mark')).toHaveCount(2);
      await query.press('Shift+Enter');
      await uiExpect(row(3)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(count).toHaveText('第 1 / 3 条 · 共 4 处');

      // Replace everywhere, then undo: the search runs again on its own.
      await bar.getByTestId('studio-cue-find-toggle-replace').click();
      await bar.getByTestId('studio-cue-find-replacement').fill('法厄同');
      await bar.getByTestId('studio-cue-find-replace-all').click();
      await uiExpect(count).toHaveText('无匹配');
      await uiExpect(row(3).locator('[data-field=source]')).toHaveText('这是法厄同');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：替换 3 条字幕');
      await page.getByTestId('studio-cue-undo').click();
      await uiExpect(count).toHaveText('第 1 / 3 条 · 共 4 处');
      await uiExpect(row(3).locator('[data-field=source]')).toHaveText('这是法尔童');

      // Replace in the current cue only, which then moves on to the next match.
      await bar.getByTestId('studio-cue-find-replacement').press('Enter');
      await uiExpect(count).toHaveText('第 1 / 2 条 · 共 3 处');
      await uiExpect(row(120)).toHaveAttribute('aria-selected', 'true');
      await page.locator('.studio-reader-footer').getByRole('button', { name: '上一页', exact: true }).click();
      await uiExpect(row(3).locator('[data-field=source]')).toHaveText('这是法厄同');

      // Narrow and dark.
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await query.fill('句');
      await uiExpect(count).toContainText('共 247 处');
      expect(await bar.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      await shot('studio-cue-find--02-found-786-dark');

      // Esc closes the bar, clears the marks and returns to the list.
      await query.press('Escape');
      await uiExpect(bar).toHaveCount(0);
      await uiExpect(page.locator('mark.studio-cue-find-mark')).toHaveCount(0);
      await uiExpect(list).toBeFocused();
      await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 180_000);
});
