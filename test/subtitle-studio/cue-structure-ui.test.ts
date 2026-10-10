import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

/** The user's file around the reported repetition (19–22 in the flat import, 9–10 once separated). */
const PAIRS: [string, string, string][] = [
  ['00:02.420', '先輩、おはようございます。', '前辈，早上好。'],
  ['00:08.020', 'って、もう眠そうじゃないですか。', '话说，你看起来已经很困了嘛。'],
  ['00:11.020', 'まだ朝なのに。', '明明还是早上。'],
  ['00:13.020', 'ん?なんですか?', '嗯？怎么了？'],
  ['00:15.970', '君は白鸽だから?', '因为你是白鸽吗？'],
  ['00:18.770', '朝元気なだけ?', '只是早上比较有精神？'],
  ['00:20.770', 'そんなことないです。', '才不是那样。'],
  ['00:22.770', '私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '我认识的人里，同族的居民白鸽和麻雀当中，'],
  ['00:26.780', '先輩みたいに朝から眠そうにしてる方、', '像前辈这样一大早就犯困的，'],
  ['00:27.500', '先輩みたいに朝から眠そうにしてる方', '像前辈这样一大早就犯困的'],
  ['00:29.860', 'いますもん', '也是有的。'],
];

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('merging cues and editing times', () => {
  it('merges the reported repetition, edits and shifts times, and undoes each', async () => {
    const artifacts = path.resolve('test-results/studio-cue-structure'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const file = path.join(root, '01某邮局的工作 - ある郵便局のお仕事.lrc');
    await writeFile(file, PAIRS.map(([time, ja, zh]) => `[${time}]${ja}\n[${time}]${zh}\n`).join(''));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const source = (index: number) => rows.nth(index).locator('[data-field=source]');
      const target = (index: number) => rows.nth(index).locator('[data-field=target]');
      const time = (index: number) => rows.nth(index).locator('.studio-cue-time');
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, file);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(rows).toHaveCount(PAIRS.length);

      // Non-adjacent cues cannot merge.
      await rows.nth(0).locator('.studio-cue-number').click();
      await rows.nth(2).locator('.studio-cue-number').click({ modifiers: ['Control'] });
      await uiExpect(page.getByTestId('studio-cue-toolbar-merge')).toBeDisabled();
      await uiExpect(page.getByTestId('studio-cue-toolbar-merge')).toHaveAccessibleName('只能合并相邻的字幕');

      // The repetition: select both, merge, one cue with the fuller wording and its translation.
      await rows.nth(8).locator('.studio-cue-number').click();
      await rows.nth(9).locator('.studio-cue-number').click({ modifiers: ['Shift'] });
      const merge = page.getByTestId('studio-cue-toolbar-merge');
      await uiExpect(merge).toBeEnabled();
      await uiExpect(merge).toHaveAccessibleName('合并为一条');
      await shot('01-selected-repetition-1280-light');
      await merge.click();
      await uiExpect(rows).toHaveCount(PAIRS.length - 1);
      await uiExpect(source(8)).toHaveText('先輩みたいに朝から眠そうにしてる方、');
      await uiExpect(target(8)).toContainText('像前辈这样一大早就犯困的，');
      await uiExpect(time(8)).toHaveText(/00:00:26\.780.*结束时间未知/);
      await uiExpect(source(9)).toHaveText('いますもん');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：合并 2 条字幕');
      await shot('02-merged-1280-light');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows).toHaveCount(PAIRS.length);
      await uiExpect(source(9)).toHaveText('先輩みたいに朝から眠そうにしてる方');
      await page.keyboard.press('Control+y');
      await uiExpect(rows).toHaveCount(PAIRS.length - 1);

      // Times in place: a start after the next cue is refused where it is typed; an end is saved.
      await time(0).dblclick();
      const start = page.getByTestId('studio-cue-time-start'), end = page.getByTestId('studio-cue-time-end');
      await uiExpect(start).toBeFocused();
      await uiExpect(start).toHaveValue('00:00:02.420');
      await start.fill('00:00:30.000');
      await start.press('Enter');
      await uiExpect(time(0).getByRole('alert')).toHaveText('开始时间不能晚于下一条字幕');
      await shot('03-time-error-1280-light');
      await start.fill('2.42');
      await end.fill('00:00:05.000');
      await end.press('Enter');
      await uiExpect(start).toHaveCount(0);
      await uiExpect(time(0)).toHaveText(/00:00:02\.420.*00:00:05\.000/);
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：调整 1 条字幕的时间');

      // Shifting two cues later together, from the menu.
      await rows.nth(1).locator('.studio-cue-number').click();
      await rows.nth(2).locator('.studio-cue-number').click({ modifiers: ['Shift'] });
      await rows.nth(1).click({ button: 'right' });
      await page.getByTestId('studio-cue-context-menu').getByRole('menuitem', { name: '平移时间…' }).click();
      const shift = page.getByRole('dialog', { name: '平移时间' });
      await shift.getByTestId('studio-cue-shift-delta').fill('500');
      await uiExpect(shift.getByTestId('studio-cue-shift-preview')).toHaveText('第一条从 00:00:08.020 移到 00:00:08.520，共 2 条。');
      await shot('04-shift-1280-light');
      await shift.getByTestId('studio-cue-shift-apply').click();
      await uiExpect(shift).toBeHidden();
      await uiExpect(time(1)).toHaveText(/00:00:08\.520/);
      await uiExpect(time(2)).toHaveText(/00:00:11\.520/);
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(time(1)).toHaveText(/00:00:08\.020/);

      // Narrow and dark: the time editor stacks inside the column.
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await time(3).dblclick();
      await uiExpect(start).toBeFocused();
      // Editing a time selects that cue alone.
      await uiExpect(rows.nth(3)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(page.locator('.studio-cue-table tbody tr[aria-selected=true]')).toHaveCount(1);
      const fits = await time(3).evaluate(cell => cell.scrollWidth <= cell.clientWidth + 1);
      expect(fits).toBe(true);
      await shot('05-time-editor-786-dark');
      await page.keyboard.press('Escape');
      await uiExpect(start).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 180000);
});
