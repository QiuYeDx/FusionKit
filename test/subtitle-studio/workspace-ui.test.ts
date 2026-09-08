import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio workspace interactions', () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let root: string;
  const artifacts = path.resolve('test-results/subtitle-studio-ui');
  const errors: string[] = [];
  async function ready() {
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(350);
  }
  async function capture(name: string) {
    await ready();
    expect(await page.locator('.studio, .studio-main, .studio-reader').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  }
  async function importFile(name: string) {
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.join(root, name));
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  afterAll(async () => {
    try { await app?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  it('supports native import, page navigation, copy, raw view, error recovery, export and responsive themes', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-ui-'));
    await mkdir(artifacts, { recursive: true });
    const lines = ['每一段声音，都有值得被听见的故事。', 'A quieter workspace. A clearer story.', '让时间、文字与表达，在这里相遇。', 'Keep the details that matter.', '文字里的停顿，也是故事的一部分。'];
    const source = Array.from({ length: 205 }, (_, i) => {
      const stamp = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
      const text = i === 2 ? lines[2].repeat(6) : i === 3 ? `${lines[3]}\n${lines[4]}` : lines[i % lines.length];
      return `${i + 1}\n${stamp(i * 3)} --> ${stamp(i * 3 + 2)}\n${text}\n`;
    }).join('\n');
    const name = '声音与故事 · Sound and Story · 字幕ワークスペース · 完整访谈与幕后制作记录 · Episode 02.zh-CN.srt';
    await writeFile(path.join(root, name), source);
    await writeFile(path.join(root, 'timing-review.lrc'), '[ar:Studio QA]\n[offset:-1500]\n[00:01.00]A line before zero\n[00:03.00]A second line\n');
    await writeFile(path.join(root, 'invalid.srt'), '1\n00:00:03,000 --> 00:00:01,000\nInvalid timing\n');
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
    await page.reload();
    await ready();
    const window = await app.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 860));
    const visualSignature = async (selector: string) => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, cornerShape: style.getPropertyValue('corner-shape'), border: style.borderTopWidth, background: style.backgroundColor, shadow: style.boxShadow, padding: style.padding };
    });
    const pickerStyle = await visualSignature('.studio-import');
    const panelStyle = await visualSignature('.studio-preview-panel');
    await page.evaluate(() => { localStorage.setItem('subtitle-converter-tour-done', '1'); location.hash = '/tools/subtitle/converter'; });
    await page.locator('#cvt-tour-queue').waitFor();
    expect(await visualSignature('#cvt-tour-upload')).toEqual(pickerStyle);
    expect(await visualSignature('#cvt-tour-queue')).toEqual(panelStyle);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(artifacts, 'baseline-converter.png') });
    await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
    await ready();
    await capture('empty-light');
    await importFile(name);
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
    await uiExpect(page.locator('[data-slot=clip-path-tabs]')).toHaveAttribute('data-shape', 'rounded');
    const density = await page.locator('.studio-cue-table tbody').evaluate(body => {
      const rows = [...body.querySelectorAll('tr')];
      const short = rows[0];
      const wrapped = rows[2];
      const timeSpans = short.querySelectorAll('.studio-time-range > span');
      const firstLineOffset = (row: Element, selector: string) => {
        const element = row.querySelector(selector)!;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects()[0].top - row.getBoundingClientRect().top;
      };
      return {
        shortHeight: short.getBoundingClientRect().height,
        wrappedHeight: wrapped.getBoundingClientRect().height,
        multilineHeight: rows[3].getBoundingClientRect().height,
        timeDelta: Math.abs(timeSpans[0].getBoundingClientRect().top - timeSpans[1].getBoundingClientRect().top),
        aligned: [...wrapped.children].every(cell => getComputedStyle(cell).verticalAlign === 'top'),
        offsets: ['.studio-cue-number', '.studio-time-range', '.studio-cue-text'].map(selector => Math.abs(firstLineOffset(short, selector) - firstLineOffset(wrapped, selector))),
      };
    });
    expect(density.shortHeight).toBeLessThanOrEqual(34);
    expect(density.wrappedHeight).toBeGreaterThan(density.shortHeight);
    expect(density.multilineHeight).toBeGreaterThan(density.shortHeight);
    expect(density.timeDelta).toBeLessThan(1);
    expect(density.aligned).toBe(true);
    expect(density.offsets.every(offset => offset < 1)).toBe(true);
    const toolbar = await page.locator('.studio-tabs').evaluate(element => {
      const heading = element.querySelector('.studio-document-heading')!.getBoundingClientRect();
      const tabs = element.querySelector('[data-slot=clip-path-tabs-stage]')!.getBoundingClientRect();
      const reader = element.querySelector('.studio-reader')!.getBoundingClientRect();
      return { height: reader.top - element.getBoundingClientRect().top, sharedRow: heading.top < tabs.bottom && tabs.top < heading.bottom, separateColumns: heading.right <= tabs.left };
    });
    expect(toolbar.height).toBeLessThanOrEqual(60);
    expect(toolbar.sharedRow).toBe(true);
    expect(toolbar.separateColumns).toBe(true);
    const assertFilename = async (selector: string) => {
      const filename = page.locator(selector);
      const layout = await filename.evaluate(element => {
        const start = element.querySelector('.studio-file-name-start')!;
        const end = element.querySelector('.studio-file-name-end')!;
        return {
          truncated: start.scrollWidth > start.clientWidth,
          ellipsis: getComputedStyle(start).textOverflow,
          endVisible: end.scrollWidth <= end.clientWidth + 1,
          fits: end.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1,
          sameLine: Math.abs(start.getBoundingClientRect().top - end.getBoundingClientRect().top) < 1,
        };
      });
      expect(layout).toEqual({ truncated: true, ellipsis: 'ellipsis', endVisible: true, fits: true, sameLine: true });
      await uiExpect(filename.locator('.studio-file-name-end')).toHaveText(name.slice(-12));
      await filename.hover();
      await uiExpect(page.getByRole('tooltip', { name, exact: true })).toBeVisible();
      const tooltipLayout = await page.locator('[data-slot=tooltip-content]').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element.firstChild!);
        const bounds = element.getBoundingClientRect();
        const textRight = Math.max(...[...range.getClientRects()].map(rect => rect.right));
        return { width: bounds.width, unused: bounds.right - parseFloat(getComputedStyle(element).paddingRight) - textRight };
      });
      expect(tooltipLayout.width).toBeLessThanOrEqual(320);
      expect(tooltipLayout.unused).toBeLessThan(40);
      await page.locator('.studio-cue-table th').first().hover();
      await page.locator('.studio-cue-table th').nth(1).hover();
      await uiExpect(page.getByRole('tooltip')).toHaveCount(0);
    };
    await assertFilename('.studio-document-heading .studio-file-name');
    await assertFilename('.studio-document[aria-current=true] .studio-file-name');
    await page.locator('.studio-document-heading .studio-file-name').focus();
    await uiExpect(page.getByRole('tooltip', { name, exact: true })).toBeVisible();
    await page.locator('[data-slot=tooltip-content]').screenshot({ path: path.join(artifacts, 'filename-tooltip.png') });
    await page.keyboard.press('Escape');
    await page.locator('.studio-document-heading .studio-file-name').blur();
    expect(await page.locator('.studio-reader-footer').evaluate(element => element.parentElement!.getBoundingClientRect().height)).toBeLessThanOrEqual(42);
    await capture('workspace-light');
    await page.locator('.studio-cue-table tbody tr').first().hover();
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { document.documentElement.dataset.copiedText = text; } });
    });
    await page.getByRole('button', { name: '复制字幕', exact: true }).first().click();
    await uiExpect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    expect(await page.locator('html').getAttribute('data-copied-text')).toBe(lines[0]);

    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101');
    const jump = page.getByRole('spinbutton', { name: '页码' });
    await jump.fill('3'); await jump.press('Enter');
    await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('201');
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(5);
    await uiExpect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await jump.fill('999'); await jump.press('Enter');
    await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('201');
    await jump.fill('1'); await jump.press('Enter');
    await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('1');

    await page.getByRole('tab', { name: '原始内容' }).click();
    await page.waitForTimeout(250);
    expect(await page.locator('[data-slot=clip-path-tabs-active-layer]').evaluate(element => getComputedStyle(element).clipPath)).toMatch(/^inset\(/);
    await uiExpect(page.locator('.studio-raw pre').first()).toContainText('00:00:00,000');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await uiExpect(page.locator('.studio-raw li > span').first()).toHaveText('101');
    await capture('original-content');
    await page.getByRole('tab', { name: '字幕预览' }).focus();
    await page.keyboard.press('ArrowRight');
    await uiExpect(page.getByRole('tab', { name: '原始内容' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await uiExpect(page.getByRole('tab', { name: '字幕预览' })).toHaveAttribute('aria-selected', 'true');

    await app.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, path.join(root, 'export.srt'));
    await page.getByRole('button', { name: '下载原文', exact: true }).click();
    await uiExpect(page.getByRole('status').filter({ hasText: '已下载' })).toBeVisible();
    expect(await readFile(path.join(root, 'export.srt'), 'utf8')).toBe(source);
    await page.getByRole('button', { name: '关闭提示' }).click();

    await importFile('timing-review.lrc');
    await page.locator('.studio-document-heading .studio-file-name').focus();
    await uiExpect(page.getByRole('tooltip', { name: 'timing-review.lrc', exact: true })).toBeVisible();
    expect(await page.locator('[data-slot=tooltip-content]').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(180);
    await page.keyboard.press('Escape');
    await page.locator('.studio-document-heading .studio-file-name').blur();
    await page.locator('.studio-document:not([aria-current=true])').hover();
    expect(await page.locator('.studio-document').evaluateAll(elements => {
      const first = elements[0].getBoundingClientRect();
      const second = elements[1].getBoundingClientRect();
      return second.top - first.bottom;
    })).toBeGreaterThanOrEqual(4);
    await capture('adjacent-document-hover');
    await page.locator('.studio-diagnostics summary').click();
    await uiExpect(page.locator('.studio-diagnostics')).toContainText('负起始时间');
    await capture('document-checks');
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.join(root, 'invalid.srt'));
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.getByRole('alert')).toContainText('字幕结构无效');
    await capture('import-error');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    await uiExpect(page.getByRole('heading', { name: 'timing-review.lrc' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();

    for (const [theme, lang, width, height] of [['dark', 'en', 1280, 860], ['light', 'ja', 786, 540], ['dark', 'zh-Hant', 786, 660]] as const) {
      await page.evaluate(({ theme, lang }) => { localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 })); }, { theme, lang });
      await page.reload(); await ready();
      await window.evaluate((win, size) => win.setSize(...size), [width, height] as [number, number]);
      await ready();
      expect(await page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(theme === 'dark');
      if (width < 860) {
        const picker = page.locator('.studio-mobile-picker [role=combobox]');
        await picker.click();
        await page.getByRole('option', { name, exact: true }).click();
        await assertFilename('.studio-mobile-picker .studio-file-name');
      }
      await capture(`${theme}-${lang}-${width}`);
    }
    // The desktop application has a 786px minimum, but the view also survives a smaller renderer.
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('mobile-layout');
    expect(errors).toEqual([]);
  }, 120000);
});
