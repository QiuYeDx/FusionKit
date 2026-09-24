import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('knowledge workspace list layout', () => {
  it('keeps primary management visible, tabs alongside New, and long lists inside fading viewports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'knowledge-workspace-layout-'));
    const artifacts = path.resolve('test-results/knowledge-workspace-layout');
    await mkdir(artifacts, { recursive: true });
    const fixture = knowledgeFixture(), term = fixture.entries.find(item => item.kind === 'term')!;
    fixture.entries.push(...Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(term), id: randomUUID(), title: `Fixture ${index}`, state: 'candidate' as const })));
    fixture.recipes = Array.from({ length: 25 }, (_, index) => ({ ...structuredClone(fixture.recipes[0]), id: randomUUID(), name: `翻译方案 ${index + 1} · 自然对白与作品用语`, description: '保持称呼、人物口吻与上下文一致，供长列表滚动和边缘留白验收。' }));
    fixture.collections.push(...Array.from({ length: 18 }, (_, index) => ({ ...structuredClone(fixture.collections[0]), id: randomUUID(), name: `资料集 ${index + 1} · 长名称与日中翻译术语` })));
    const file = path.join(root, 'fixture.fktk.json'); await writeFile(file, JSON.stringify(fixture));
    const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow(), win = await app.browserWindow(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    const capture = async (name: string, target: Locator) => { await target.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' }); };
    const checkScroll = async (wrapper: Locator, name: string) => {
      const fade = wrapper.locator('.studio-scroll-fade'), viewport = wrapper.locator('.studio-scroll-fade-viewport');
      await viewport.scrollIntoViewIfNeeded();
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'false');
      await uiExpect(fade).toHaveAttribute('data-fade-bottom', 'true');
      const box = (await viewport.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(512);
      expect(await viewport.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 150);
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'true');
      await uiExpect(fade).toHaveAttribute('data-fade-bottom', 'true');
      expect(await fade.locator('[data-edge]').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).pointerEvents === 'none' && node.getAttribute('aria-hidden') === 'true'))).toBe(true);
      await capture(`${name}-middle`, wrapper);
      await page.mouse.wheel(0, 10000);
      await uiExpect(fade).toHaveAttribute('data-fade-bottom', 'false');
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'true');
      expect(await viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await capture(`${name}-bottom`, wrapper);
      await page.mouse.wheel(0, -10000);
      await uiExpect(fade).toHaveAttribute('data-fade-top', 'false');
    };
    try {
      await win.evaluate(w => { w.setSize(1280, 860); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('translation-knowledge-tour-done', '1'); location.hash = '/tools/translation-knowledge'; });
      await page.reload(); await ready();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
      await page.getByTestId('knowledge-import').click();
      await page.getByRole('button', { name: zh.actions.confirm_import, exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      for (const [locale, width, height] of [['zh', 1280, 860], ['en', 820, 700]] as const) {
        const labels = locale === 'zh' ? zh : en;
        await win.evaluate((w, size) => w.setSize(...size), [width, height] as [number, number]);
        await page.evaluate(locale => { localStorage.setItem('lang', locale); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: locale === 'zh' ? 'light' : 'dark' }, version: 0 })); }, locale);
        await page.reload(); await ready();
        const more = page.locator('#knowledge-more-management');
        await uiExpect(more.locator('[data-slot=accordion-trigger]').first()).toHaveAttribute('aria-expanded', 'false');
        await uiExpect(page.getByTestId('knowledge-plans')).toBeVisible();
        await uiExpect(page.locator('#knowledge-subjects')).toBeVisible();
        expect(await more.locator('#knowledge-subjects, #knowledge-plans').count()).toBe(0);
        expect(await page.getByText(locale === 'zh' ? '其他已存资料' : 'Other saved materials', { exact: true }).count()).toBe(0);
        await checkScroll(page.getByTestId('knowledge-collections-scroll'), `${locale}-collections`);
        await page.getByTestId('knowledge-all').click();
        await checkScroll(page.getByTestId('knowledge-results-scroll'), `${locale}-materials`);
        await page.getByTestId('knowledge-plans').click();
        const tabs = page.getByTestId('knowledge-plan-tabs'), create = page.getByTestId('knowledge-new-entry');
        await tabs.scrollIntoViewIfNeeded();
        await uiExpect(tabs.getByRole('tab')).toHaveCount(3);
        const a = (await tabs.boundingBox())!, b = (await create.boundingBox())!;
        expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(3);
        expect(a.x + a.width).toBeLessThan(b.x);
        await capture(`${locale}-plan-header`, tabs);
        await checkScroll(page.getByTestId('knowledge-results-scroll'), `${locale}-plans`);
        for (const label of [labels.plans.styles, labels.plans.preferenceTemplates, labels.plans.recipes]) {
          await tabs.getByRole('tab', { name: label, exact: true }).click();
          await uiExpect(tabs.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
          await create.click(); await uiExpect(page.getByTestId('knowledge-catalog-editor')).toBeVisible();
          await page.keyboard.press('Escape'); await uiExpect(page.getByRole('dialog')).toHaveCount(0);
        }
        await page.getByRole('textbox', { name: labels.filters.search, exact: true }).fill('no-matching-result-123');
        const emptyFade = page.getByTestId('knowledge-results-scroll').locator('.studio-scroll-fade');
        await uiExpect(emptyFade).toHaveAttribute('data-fade-top', 'false');
        await uiExpect(emptyFade).toHaveAttribute('data-fade-bottom', 'false');
        await more.locator('[data-slot=accordion-trigger]').first().click();
        await uiExpect(more.getByTestId('knowledge-archive')).toBeVisible();
        await more.getByTestId('knowledge-archive').click();
        await uiExpect(page.getByTestId('knowledge-archive-help')).toBeVisible();
      }
      expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined); throw error;
    } finally {
      await app.close();
      expect(path.dirname(root)).toBe(path.resolve(tmpdir())); expect(path.basename(root)).toMatch(/^knowledge-workspace-layout-/);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120000);
});
