import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createTestRun } from './support/testRun';

const HISTORY = ['第一条历史消息', '请把这一季所有字幕翻译成简体中文，人名按照翻译资料里的写法统一，双语字幕原文在前、译文在后，保存到原视频旁边，同名文件自动编号', '把 D:\\字幕\\第一季 里的字幕翻译成中文'];

/** The capsule keeps the mode selector beside the text; the multi-line layout moves it below. */
async function layout(page: Page) {
  const input = (await page.getByTestId('agent-input').boundingBox())!;
  const mode = (await page.getByTestId('home-agent').getByTestId('agent-execution-mode').boundingBox())!;
  return mode.y >= input.y + input.height - 1 ? 'multi' : 'single';
}

describe.runIf(process.env.FUSIONKIT_HOME_COMPOSER_E2E === '1')('home composer', () => {
  it('turns multi-line when text wraps and shows where a recalled message sits in the history', async () => {
    const artifacts = path.resolve('test-results/home-composer'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page);
      await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(history => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-input-history', JSON.stringify(history));
        location.hash = '/';
      }, HISTORY);
      await page.reload(); await page.getByTestId('home-agent').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const input = page.getByTestId('agent-input');
      const hint = page.getByTestId('home-agent').getByTestId('agent-input-history');
      const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };

      // Short text stays in the capsule.
      await input.click();
      await input.pressSequentially('翻译这个文件');
      expect(await layout(page)).toBe('single');
      await shot('01-single-line-1280-light');

      // Longer text that wraps switches to the multi-line layout without a line break, keeping the caret.
      const long = '请把这一季所有字幕翻译成简体中文，人名按照翻译资料里的写法统一，双语字幕原文在前、译文在后，保存到原视频旁边，同名文件自动编号';
      await input.pressSequentially(`，${long}`);
      await uiExpect.poll(() => layout(page)).toBe('multi');
      expect(await input.inputValue()).not.toContain('\n');
      await uiExpect(input).toBeFocused();
      expect(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe((await input.inputValue()).length);
      await shot('02-wrapped-multi-line-1280-light');
      // Typing in the middle after the switch stays in the middle.
      await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(3, 3); });
      await input.pressSequentially('A');
      expect((await input.inputValue()).slice(0, 4)).toBe('翻译这A');
      expect(await layout(page)).toBe('multi');
      // Deleting back to a short text returns to the capsule; so does clearing the draft.
      await input.fill('翻译这A个文件');
      await uiExpect.poll(() => layout(page)).toBe('single');
      await input.fill('');
      await uiExpect.poll(() => layout(page)).toBe('single');

      // Up and Down show "历史 i/n": the newest of n is n/n; back past the newest restores the draft.
      await input.fill('草稿');
      await input.press('Home');
      await input.press('ArrowUp');
      await uiExpect(input).toHaveValue(HISTORY[2]);
      await uiExpect(hint).toHaveText('历史 3/3');
      await shot('03-history-3-of-3-1280-light');
      await input.press('ArrowUp');
      await uiExpect(input).toHaveValue(HISTORY[1]);
      await uiExpect(hint).toHaveText('历史 2/3');
      // A long recalled message gets the multi-line layout; stepping on keeps working there.
      await uiExpect.poll(() => layout(page)).toBe('multi');
      await shot('03b-history-long-2-of-3-1280-light');
      await input.press('ArrowUp'); await input.press('ArrowUp');
      await uiExpect(hint).toHaveText('历史 1/3');
      await input.press('ArrowDown'); await input.press('ArrowDown');
      await uiExpect(hint).toHaveText('历史 3/3');
      await input.press('ArrowDown');
      await uiExpect(input).toHaveValue('草稿');
      await uiExpect(hint).toHaveCount(0);
      await uiExpect.poll(() => layout(page)).toBe('single');
      // Editing a recalled message hides the hint: it is now a new draft.
      await input.press('Home'); await input.press('ArrowUp');
      await uiExpect(hint).toHaveText('历史 3/3');
      await input.press('End'); await input.pressSequentially('，只要译文');
      await uiExpect(hint).toHaveCount(0);

      // Dark and narrow.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('home-agent').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await input.fill('');
      await input.click(); await input.press('ArrowUp'); await input.press('ArrowUp');
      await uiExpect(hint).toHaveText('历史 2/3');
      await uiExpect.poll(() => layout(page)).toBe('multi');
      await shot('04-history-wrapped-786-dark');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 120_000);
});
