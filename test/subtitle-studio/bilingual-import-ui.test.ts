import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

/** The opening of the user's file: each timestamp holds a Japanese line, then its Chinese translation. */
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
  ['00:31.000', '先輩', '前辈'],
];

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('bilingual subtitles at import', () => {
  it('separates a bilingual LRC picked with other files, says so, and imports it as it was on request', async () => {
    const artifacts = path.resolve('test-results/studio-bilingual-import'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const bilingual = path.join(root, '01某邮局的工作 - ある郵便局のお仕事.lrc');
    const mono = path.join(root, '02 单语.srt');
    await writeFile(bilingual, PAIRS.map(([time, ja, zh]) => `[${time}]${ja}\n[${time}]${zh}\n`).join(''));
    await writeFile(mono, '1\n00:00:01,000 --> 00:00:02,000\nこんにちは。\n\n2\n00:00:03,000 --> 00:00:04,000\nまたね。\n');
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      const configure = (theme: 'light' | 'dark') => page.evaluate(theme => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      }, theme);
      const ready = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string, target: Parameters<typeof uiExpect>[0] | typeof page = page) => { await page.waitForTimeout(450); await (target as typeof page).screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const pick = (files: string[]) => app!.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      const rows = page.locator('.studio-cue-table tbody tr');

      await configure('light');
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await pick([bilingual, mono]);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const result = page.getByTestId('studio-library-result');
      await result.locator('.studio-selected-documents-header').first().click();
      await uiExpect(result).toContainText('已识别为双语：日语 → 中文');
      await shot('01-import-result-1280-light');
      await page.getByRole('button', { name: '完成', exact: true }).click();

      // Opened on the bilingual file: source and translation side by side, nothing else to do.
      const notice = page.getByTestId('studio-bilingual-notice');
      await uiExpect(notice).toContainText('已识别为双语字幕（日语 → 中文），共 12 条');
      await uiExpect(page.getByTestId('studio-bilingual-label')).toHaveText('双语 · 日语 → 中文');
      await uiExpect(rows).toHaveCount(12);
      await uiExpect(rows.first().locator('[data-field=source]')).toHaveText(PAIRS[0][1]);
      await uiExpect(rows.first().locator('[data-field=target]')).toContainText(PAIRS[0][2]);
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      await uiExpect(page.getByTestId('studio-bilingual-revert')).toBeVisible();
      await shot('02-separated-1280-light');

      // As it was: every line is source text again and the manual step is back.
      await notice.getByTestId('studio-bilingual-notice-revert').click();
      await uiExpect(rows).toHaveCount(24);
      await uiExpect(page.getByTestId('studio-bilingual-label')).toHaveCount(0);
      await uiExpect(page.getByRole('button', { name: '双语整理', exact: true })).toBeEnabled();
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText(PAIRS[0][2]);

      // Narrow and dark: the header action asks first.
      await win.evaluate(window => window.setSize(786, 660));
      await configure('dark');
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await pick([bilingual]);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(notice).toBeVisible();
      await uiExpect(rows).toHaveCount(12);
      await shot('03-separated-786-dark');
      const overflow = await notice.evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.getByTestId('studio-bilingual-revert').click();
      const confirm = page.getByRole('dialog', { name: '按原样导入' });
      await uiExpect(confirm).toContainText('当前按双语导入（日语 → 中文，12 条）');
      await shot('04-revert-confirm-786-dark');
      await confirm.getByTestId('studio-bilingual-revert-confirm').click();
      await uiExpect(confirm).toBeHidden();
      await uiExpect(rows).toHaveCount(24);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
    }
  }, 180000);
});
