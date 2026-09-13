import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';

describe.runIf(process.env.FUSIONKIT_STUDIO_CONTEXT_UI === '1')('document context actions in real Electron', () => {
  it('keeps selection and preview independent, freezes cross-page scope and reuses batch workflows', async () => {
    const artifacts = path.resolve('test-results/studio-context'); await mkdir(artifacts, { recursive: true });
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
      const rows = page.getByTestId('studio-library-row'), menu = page.getByTestId('studio-library-context-menu');
      const selectedIds = () => page!.locator('[data-testid="studio-library-row"][data-selected]').evaluateAll(elements => elements.map(element => element.getAttribute('data-document-id')));
      const checkScope = async (count: number) => { await uiExpect(menu).toBeVisible(); await uiExpect(menu).toContainText(`处理 ${count} 份文档`); };
      const closeDialog = async () => { await page!.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await uiExpect(page!.getByRole('dialog')).toHaveCount(0); };
      await rows.nth(0).getByRole('checkbox').click(); await rows.nth(1).getByRole('checkbox').click();
      const initialSelected = await selectedIds();
      await rows.nth(3).locator('.studio-document').click();
      await uiExpect(rows.nth(3).locator('.studio-document')).toHaveAttribute('aria-current', 'true');
      const preview = await rows.nth(3).getAttribute('data-document-id');
      await rows.nth(0).click({ button: 'right' }); await checkScope(2);
      expect(await selectedIds()).toEqual(initialSelected); await uiExpect(page!.locator('[data-current]')).toHaveAttribute('data-document-id', preview!);
      await uiExpect(menu.getByRole('menuitem', { name: '继续翻译', exact: true })).toBeDisabled();
      await page.screenshot({ path: path.join(root, 'selected-light.png'), animations: 'disabled' });
      await menu.getByRole('menuitem', { name: '翻译', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('本次处理 2 份文档');
      await closeDialog(); await uiExpect(rows.nth(0).locator('.studio-document')).toBeFocused();
      expect(await selectedIds()).toEqual(initialSelected);
      await rows.nth(3).click({ button: 'right' }); await checkScope(1);
      await menu.getByRole('menuitem', { name: '导出字幕', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('本次处理 1 份文档');
      const sourceName = (await rows.nth(3).locator('.studio-file-name > .sr-only').textContent())!;
      await page.getByRole('button', { name: '检查导出', exact: true }).click();
      await page.getByRole('button', { name: '确认并导出 1 份', exact: true }).click();
      await uiExpect(page.getByTestId('studio-batch-result')).toHaveAttribute('data-outcome', 'success');
      expect((await readdir(root)).filter(file => file.includes(' (1).srt'))).toEqual([sourceName.replace('.srt', ' (1).srt')]);
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(rows.nth(3).locator('.studio-document')).toBeFocused(); expect(await selectedIds()).toEqual(initialSelected);
      // The footer has no batch controls when nothing is selected; the context path still works.
      await rows.nth(0).getByRole('checkbox').click(); await rows.nth(1).getByRole('checkbox').click();
      await rows.nth(4).click({ button: 'right' }); await checkScope(1);
      await menu.getByRole('menuitem', { name: '翻译', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('本次处理 1 份文档'); await closeDialog();
      await rows.nth(0).getByRole('checkbox').click(); await rows.nth(1).getByRole('checkbox').click();
      await page.getByTestId('studio-library-pagination').getByRole('button', { name: '下一页', exact: true }).click();
      await uiExpect(rows).toHaveCount(2); await rows.nth(0).getByRole('checkbox').click();
      await rows.nth(0).locator('.studio-document').focus(); await page.keyboard.press('Shift+F10'); await checkScope(3);
      await uiExpect(menu.getByRole('menuitem', { name: '翻译', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown'); await uiExpect(menu.getByRole('menuitem', { name: '导出字幕', exact: true })).toBeFocused();
      await page.keyboard.press('Escape'); await uiExpect(menu).toHaveCount(0); await uiExpect(rows.nth(0).locator('.studio-document')).toBeFocused();
      await rows.nth(0).click({ button: 'right' }); await checkScope(3);
      await menu.getByRole('menuitem', { name: '导出字幕', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toContainText('本次处理 3 份文档');
      await win.evaluate(window => window.setSize(786, 540));
      await uiExpect(page.getByRole('dialog')).toContainText('本次处理 3 份文档'); await closeDialog();
      await page.locator('#studio-library-trigger').click(); await uiExpect(rows).toHaveCount(2);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await rows.nth(1).click({ button: 'right' }); await checkScope(1);
      await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      const geometry = await menu.evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
      expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.y).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      await page.screenshot({ path: path.join(root, 'single-dark-narrow.png'), animations: 'disabled' });
      await menu.getByRole('menuitem', { name: '删除文档', exact: true }).click();
      const confirm = page.locator('.studio-batch-confirm-dialog');
      await uiExpect(confirm.locator('[data-document-id]')).toHaveCount(1); await uiExpect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await confirm.getByRole('button', { name: '确认删除', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await page.getByTestId('studio-library-result').getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(rows).toHaveCount(1); await uiExpect(page.getByTestId('studio-batch-toolbar')).toContainText('已选 3 份');
      await rows.nth(0).click({ button: 'right' }); await checkScope(3);
      await page.getByTestId('studio-library-search').click(); await uiExpect(menu).toHaveCount(0);
      await uiExpect(page.getByTestId('studio-library-search')).toBeFocused();
      expect(errors).toEqual([]);
      await writeFile(path.join(root, 'result.json'), JSON.stringify({ selectedScope: 2, unselectedScope: 1, crossPageScope: 3, preservedSelection: true, geometry, pageErrors: errors }, null, 2));
    } catch (error) { if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error; }
    finally {
      if (app) await app.close();
      if (path.dirname(profile) !== root || !root.startsWith(artifacts + path.sep)) throw Error('unexpected test root');
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, profileRemoved: true }));
    }
  }, 180000);
});
