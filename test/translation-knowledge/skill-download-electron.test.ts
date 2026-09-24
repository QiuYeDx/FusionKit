import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { skillArchiveBase64 } from '../../electron/main/translation-knowledge/skill-archive.generated';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('save authoring skill in native Electron', () => {
  it('saves an offline ZIP from an empty library, handles cancel and existing files, and fits wide/narrow layouts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-skill-ui-'));
    const artifacts = path.resolve('test-results/knowledge-skill');
    await mkdir(artifacts, { recursive: true });
    const destination = path.join(root, 'fusionkit-translation-knowledge.zip');
    const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    try {
      const page = await app.firstWindow(), win = await app.browserWindow(page);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const configure = async (locale: 'zh' | 'en', width: number) => {
        await win.evaluate((w, width) => { w.webContents.setBackgroundThrottling(false); w.setSize(width, 860); }, width);
        await page.evaluate(locale => {
          localStorage.setItem('lang', locale);
          localStorage.setItem('translation-knowledge-tour-done', '1');
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: locale === 'zh' ? 'light' : 'dark' }, version: 0 }));
          location.hash = '/tools/translation-knowledge';
        }, locale);
        await page.reload();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
        await uiExpect(page.getByTestId('knowledge-save-skill')).toBeEnabled();
        expect(await page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(locale === 'en');
      };
      const capture = async (name: string) => {
        const button = page.getByTestId('knowledge-save-skill');
        await button.scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        expect(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.scrollWidth <= el.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })).toBe(true);
        await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
      };
      await configure('zh', 1280);
      const before = await page.evaluate(() => window.translationKnowledge.read());
      await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
      await page.getByTestId('knowledge-save-skill').click();
      await uiExpect(page.getByTestId('knowledge-save-skill')).toBeEnabled();
      await uiExpect(page.getByText(zh.skill_export.help, { exact: true })).toBeVisible();
      expect((await readdir(root)).filter(name => name.endsWith('.zip'))).toEqual([]);
      await app.evaluate(({ dialog }, destination) => {
        dialog.showSaveDialog = async () => { await new Promise(resolve => setTimeout(resolve, 200)); return { canceled: false, filePath: destination }; };
      }, destination);
      await page.getByTestId('knowledge-save-skill').click();
      await uiExpect(page.getByTestId('knowledge-save-skill')).toBeDisabled();
      await uiExpect(page.getByText(zh.skill_export.saved.replace('{{fileName}}', path.basename(destination)), { exact: true })).toBeVisible();
      expect(await readFile(destination)).toEqual(Buffer.from(skillArchiveBase64, 'base64'));
      expect(await page.evaluate(() => window.translationKnowledge.read())).toEqual(before);
      await capture('01-wide-zh-light-saved');
      await page.getByTestId('knowledge-save-skill').click();
      await uiExpect(page.getByText(zh.errors.file_exists, { exact: true })).toBeVisible();
      expect(await readFile(destination)).toEqual(Buffer.from(skillArchiveBase64, 'base64'));
      await capture('02-wide-existing-file');
      await configure('en', 820);
      await uiExpect(page.getByRole('button', { name: en.skill_export.save, exact: true })).toBeEnabled();
      await capture('03-narrow-en-dark');
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
