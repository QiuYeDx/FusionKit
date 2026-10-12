import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type Locator } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

// Entries named by AC-PAGE-01-1 that the one-level navigation no longer has.
const removedLabels = ['方案与风格', '内容对象', '全部资料', '待确认', '待审核', '更多管理', '维护与导入记录'];
const removedTestIds = ['knowledge-all', 'knowledge-plans', 'knowledge-review', 'knowledge-history', 'knowledge-archive', 'knowledge-new-entry', 'knowledge-plan-tabs', 'knowledge-batch-toolbar', 'knowledge-inline-term'];
const removedIds = ['knowledge-more-management', 'knowledge-subjects', 'knowledge-plans', 'knowledge-content-heading'];

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('knowledge workspace layout', () => {
  it('has one navigation level, a three-step skippable tour, and a narrow collection bar without horizontal scroll', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'knowledge-workspace-layout-'));
    const artifacts = path.resolve('test-results/knowledge-workspace-layout');
    await mkdir(artifacts, { recursive: true });
    const fixture = knowledgeFixture();
    const [first, second] = fixture.collections.filter(item => !item.archived).sort((a, b) => a.name.localeCompare(b.name));
    const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow(), win = await app.browserWindow(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    // Native capture: Playwright's screenshot viewport does not follow webContents zoom.
    const capture = async (name: string) => {
      await page.waitForTimeout(250);
      const png = await win.evaluate(async w => (await w.webContents.capturePage()).toPNG().toString('base64'));
      await writeFile(path.join(artifacts, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const heading = page.getByTestId('knowledge-collection-header').locator('h2');
    const noHorizontalScroll = () => page.evaluate(() => {
      const viewports = [...document.querySelectorAll<HTMLElement>('.app > [data-slot=scroll-area] > [data-slot=scroll-area-viewport]')];
      return {
        document: document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1,
        app: viewports.every(viewport => viewport.scrollWidth <= viewport.clientWidth + 1),
        page: (() => { const node = document.querySelector<HTMLElement>('[data-testid=translation-knowledge]')!; return node.getBoundingClientRect().right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1; })(),
      };
    });
    const settle = (target: Locator) => target.evaluate(element => new Promise<void>((resolve, reject) => {
      const started = performance.now(); let previous: number[] = [], stable = 0;
      const sample = () => {
        const nodes = [element, ...document.querySelectorAll('.knowledge-tour-spotlight')];
        const values = nodes.flatMap(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
        stable = values.length === previous.length && values.every((value, i) => Math.abs(value - previous[i]) < 0.1) ? stable + 1 : 0;
        previous = values;
        if (stable >= 10 && performance.now() - started > 500) { resolve(); return; }
        if (performance.now() - started > 5000) { reject(new Error('Tour layout did not settle')); return; }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    try {
      await win.evaluate(w => { w.setSize(1280, 860); w.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('translation-knowledge-tour-done', '1'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/translation-knowledge'; });
      await page.reload(); await ready();
      await page.evaluate(async data => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [
          ...data.collections.map(record => ({ group: 'collections' as const, record })),
          ...data.entries.map(record => ({ group: 'entries' as const, record })),
          ...data.presets.map(record => ({ group: 'presets' as const, record })),
        ] });
        if (!saved.ok) throw new Error(`${saved.error}: ${JSON.stringify(saved.diagnostics)}`);
      }, fixture);
      await page.reload(); await ready();
      await uiExpect(heading).toHaveText(first.name);

      // AC-PAGE-01-1: none of the old navigation entries remain.
      for (const key of ['workspace', 'subjects', 'plans', 'review', 'recipes', 'styles']) expect(zh).not.toHaveProperty(key);
      const knowledge = page.getByTestId('translation-knowledge');
      for (const label of removedLabels) await uiExpect(knowledge.getByText(label, { exact: true })).toHaveCount(0);
      for (const testId of removedTestIds) await uiExpect(page.getByTestId(testId)).toHaveCount(0);
      for (const id of removedIds) await uiExpect(page.locator(`#${id}`)).toHaveCount(0);
      await uiExpect(page.locator('#knowledge-collection-list')).toBeVisible();
      await uiExpect(page.getByTestId('knowledge-narrow-bar')).toBeHidden();
      await capture('01-wide-zh-light');

      // AC-PAGE-07-1: three steps on the collections, the add-term row and the Studio link; skippable.
      const tour = page.locator('.knowledge-tour-popover');
      const steps = [
        ['#knowledge-tour-collections', zh.tour.collections_title],
        ['#knowledge-tour-add-term', zh.tour.entries_title],
        ['#knowledge-tour-studio', zh.tour.studio_title],
      ] as const;
      await page.getByTestId('knowledge-tour-trigger').click();
      for (const [index, [target, title]] of steps.entries()) {
        await uiExpect(tour).toBeVisible();
        await uiExpect(tour.getByRole('heading', { name: title, exact: true })).toBeVisible();
        await uiExpect(tour).toContainText(`${index + 1} / ${steps.length}`);
        await settle(tour);
        const placement = await page.evaluate(selector => {
          const target = document.querySelector(selector)!.getBoundingClientRect();
          const spotlight = document.querySelector('.knowledge-tour-spotlight')!.getBoundingClientRect();
          return {
            centered: Math.abs(target.x + target.width / 2 - spotlight.x - spotlight.width / 2) < 2 && Math.abs(target.y + target.height / 2 - spotlight.y - spotlight.height / 2) < 2,
            covers: spotlight.width >= target.width - 1 && spotlight.height >= target.height - 1,
          };
        }, target);
        expect(placement, target).toEqual({ centered: true, covers: true });
        await capture(`02-tour-step-${index + 1}`);
        if (index < steps.length - 1) await page.getByTestId('knowledge-tour-next').click();
      }
      await uiExpect(page.getByTestId('knowledge-tour-next')).toHaveText(zh.tour.finish);
      await page.getByTestId('knowledge-tour-previous').click();
      await uiExpect(tour.getByRole('heading', { name: zh.tour.entries_title, exact: true })).toBeVisible();
      await page.getByTestId('knowledge-tour-skip').click();
      await uiExpect(tour).toHaveCount(0);
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('translation-knowledge-tour-done'))).toBe('1');
      await uiExpect(page.getByTestId('knowledge-tour-trigger')).toBeEnabled();

      // AC-PAGE-01-5: at the minimum window the sidebar still fits; at a CSS width under 768 it becomes the narrow bar.
      // The window's minimum width (786 outer) clamps the requested content size.
      await win.evaluate(w => w.setContentSize(786, 700));
      expect(await win.evaluate(w => w.getSize()[0])).toBe(786);
      await uiExpect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(800);
      await uiExpect(page.locator('#knowledge-collection-list')).toBeVisible();
      expect(await noHorizontalScroll()).toEqual({ document: true, app: true, page: true });
      await capture('03-minimum-window');
      for (const [locale, labels] of [['zh', zh], ['en', en]] as const) {
        await page.evaluate(locale => { localStorage.setItem('lang', locale); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: locale === 'zh' ? 'light' : 'dark' }, version: 0 })); }, locale);
        await page.reload(); await ready();
        await win.evaluate(w => w.webContents.setZoomFactor(2));
        await uiExpect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(768);
        const bar = page.getByTestId('knowledge-narrow-bar');
        await uiExpect(bar).toBeVisible();
        await uiExpect(page.locator('#knowledge-collection-list')).toBeHidden();
        const select = page.getByTestId('knowledge-collection-select');
        await uiExpect(select).toBeVisible();
        await uiExpect(select).toHaveAccessibleName(labels.sidebar.collections);
        await uiExpect(select).toContainText(first.name);
        await uiExpect(page.getByTestId('knowledge-global-search-narrow')).toBeVisible();
        expect(await noHorizontalScroll()).toEqual({ document: true, app: true, page: true });
        // The main area takes the full width under the bar.
        const widths = await page.evaluate(() => ({
          bar: document.querySelector('[data-testid=knowledge-narrow-bar]')!.getBoundingClientRect().width,
          content: document.querySelector('#knowledge-content')!.getBoundingClientRect().width,
          viewport: innerWidth,
        }));
        expect(Math.abs(widths.bar - widths.content)).toBeLessThan(2);
        expect(widths.content).toBeGreaterThan(widths.viewport * 0.8);
        await capture(`04-narrow-${locale}`);
        await select.click();
        await page.getByRole('option', { name: second.name, exact: true }).click();
        await uiExpect(heading).toHaveText(second.name);
        await uiExpect(select).toContainText(second.name);
        expect(await noHorizontalScroll()).toEqual({ document: true, app: true, page: true });
        await capture(`05-narrow-${locale}-switched`);
        await win.evaluate(w => w.webContents.setZoomFactor(1));
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
