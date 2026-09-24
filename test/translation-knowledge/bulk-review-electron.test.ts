import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeFixture } from './fixtures';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('bulk review of imported materials in native Electron', () => {
  it('reviews across pages, freezes selection, recovers stale versions and preserves skipped entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-bulk-review-'));
    const artifacts = path.resolve('test-results/knowledge-bulk-review');
    await mkdir(artifacts, { recursive: true });
    const fixture = knowledgeFixture(), template = fixture.entries.find(e => e.kind === 'term')!;
    const strong = structuredClone(fixture.entries.find(e => e.kind === 'rule')!);
    if (strong.kind === 'rule') strong.payload.strength = 'required';
    fixture.subjects = []; fixture.styles = []; fixture.recipes = []; fixture.preferenceTemplates = [];
    fixture.collections[0].aboutSubjectIds = [];
    fixture.collections[0].defaultLanguagePair = { source: 'ja', target: 'zh-Hans' };
    fixture.collections[0].name = 'ASMR 日语到简体中文 · 护理与陪伴候选资料';
    fixture.collections.push({ ...fixture.collections[0], id: randomUUID(), name: '制作说明与其他资料' });
    fixture.entries = Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(template), id: randomUUID(),
      title: `术语 ${index + 1}`, state: 'candidate' as const, aboutSubjectIds: [],
      collectionId: fixture.collections[index < 80 ? 0 : 1].id,
      scope: { languagePair: { source: 'ja', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } },
      payload: template.kind === 'term' ? { ...template.payload, source: `term_${index + 1}`, target: index === 2 ? '用于检查长内容自然换行的护理用语：不应把所有行撑成同样高度，也不能遮挡选框和操作。' : `译法 ${index + 1}` } : template.payload,
    } as typeof template));
    strong.aboutSubjectIds = []; strong.scope = { languagePair: { source: 'ja', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } }; strong.title = '必须单独确认的强制要求';
    fixture.entries.push(strong);
    const input = path.join(root, 'candidate-pack.fktk.json');
    await writeFile(input, JSON.stringify(fixture));
    const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    let page: Page | undefined;
    const errors: string[] = [];
    try {
      page = await app.firstWindow();
      const ui = page, win = await app.browserWindow(ui);
      ui.on('pageerror', error => errors.push(error.message));
      await win.evaluate(w => { w.webContents.setBackgroundThrottling(false); w.setSize(1280, 860); });
      const configure = async (locale: 'zh' | 'en') => {
        await ui.evaluate(locale => {
          localStorage.setItem('lang', locale);
          localStorage.setItem('translation-knowledge-tour-done', '1');
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: locale === 'zh' ? 'light' : 'dark' }, version: 0 }));
          location.hash = '/tools/translation-knowledge';
        }, locale);
        await ui.reload();
        await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
        await uiExpect(ui.getByTestId('knowledge-import')).toBeEnabled();
      };
      const read = () => ui.evaluate(async () => { const r = await window.translationKnowledge.read(); if (!r.ok) throw Error(r.error); return r.value; });
      const capture = async (name: string) => {
        await ui.waitForTimeout(350);
        await ui.screenshot({ path: path.join(artifacts, `${name}.png`) });
        const dialog = ui.getByRole('dialog');
        if (await dialog.count()) expect(await dialog.evaluate(e => { const r = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })).toBe(true);
        else expect(await ui.getByTestId('knowledge-batch-toolbar').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      };
      await configure('zh');
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
      await ui.getByTestId('knowledge-import').click();
      await ui.getByRole('button', { name: zh.actions.confirm_import, exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-batch-toolbar')).toBeVisible();
      expect(Object.keys((await read()).approvals)).toHaveLength(0);
      await ui.getByRole('combobox', { name: zh.bulk_review.collection, exact: true }).click();
      await ui.getByRole('option', { name: fixture.collections[1].name, exact: true }).click();
      await ui.getByTestId('knowledge-select-page').click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 20 条');
      await ui.getByRole('combobox', { name: zh.bulk_review.kind, exact: true }).click();
      await ui.getByRole('option', { name: zh.kind.rule, exact: true }).click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 0 条');
      await ui.getByRole('combobox', { name: zh.bulk_review.kind, exact: true }).click();
      await ui.getByRole('option', { name: zh.bulk_review.all_kinds, exact: true }).click();
      await ui.getByRole('combobox', { name: zh.bulk_review.collection, exact: true }).click();
      await ui.getByRole('option', { name: zh.workspace.all, exact: true }).click();
      await ui.getByTestId('knowledge-select-page').click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 30 条');
      await ui.getByTestId('knowledge-select-filtered').click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 101 条');
      await ui.getByRole('button', { name: zh.actions.next, exact: true }).click();
      await uiExpect(ui.getByTestId(`knowledge-select-entry-${fixture.entries[30].id}`)).toBeChecked();
      await ui.getByTestId(`knowledge-select-entry-${fixture.entries[30].id}`).click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 100 条');
      await ui.getByRole('button', { name: zh.actions.previous, exact: true }).click();
      await ui.getByTestId('knowledge-select-filtered').click();
      await ui.getByTestId('knowledge-batch-toolbar').scrollIntoViewIfNeeded();
      await capture('01-wide-selection');
      await ui.getByTestId('knowledge-batch-adopt').click();
      await uiExpect(ui.getByTestId('knowledge-batch-target-count')).toHaveText('本次处理 100 条');
      await capture('02-wide-preview');
      // Library changes while the user is reading the preview. No refreshed IDs may be auto-added.
      const extraId = await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw Error(read.error);
        const extra = { ...structuredClone(read.value.data.entries[0]), id: crypto.randomUUID(), title: '后来新增，不能自动采纳' };
        const saved = await window.translationKnowledge.saveRecord({ generation: read.value.generation, group: 'entries', record: extra });
        if (!saved.ok) throw Error(saved.error); return extra.id;
      });
      await ui.getByTestId('knowledge-batch-confirm').click();
      await uiExpect(ui.getByTestId('knowledge-batch-refresh')).toBeVisible();
      await uiExpect(ui.getByText(zh.bulk_review.stale, { exact: true })).toBeVisible();
      await uiExpect(ui.getByText(zh.errors.revision_conflict, { exact: true })).toHaveCount(0);
      await capture('05-stale-review');
      expect(Object.keys((await read()).approvals)).toHaveLength(0);
      await ui.getByTestId('knowledge-batch-refresh').click();
      await uiExpect(ui.getByTestId('knowledge-batch-confirm')).toBeEnabled();
      await uiExpect(ui.getByTestId('knowledge-batch-target-count')).toHaveText('本次处理 100 条');
      await ui.locator(`[data-batch-entry="${fixture.entries[0].id}"]`).getByRole('checkbox').click();
      await uiExpect(ui.getByTestId('knowledge-batch-target-count')).toHaveText('本次处理 99 条');
      await ui.getByTestId('knowledge-batch-confirm').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      const accepted = await read();
      expect(Object.keys(accepted.approvals)).toHaveLength(99);
      expect(accepted.approvals[extraId]).toBeUndefined();
      expect(accepted.approvals[strong.id]).toBeUndefined();
      expect(accepted.approvals[fixture.entries[0].id]).toBeUndefined();
      // Filtering clears selection, while both collections and types remain discoverable.
      await ui.getByTestId('knowledge-select-filtered').click();
      await ui.getByRole('textbox', { name: zh.filters.search }).fill('后来新增');
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('已选 0 条');
      await ui.getByTestId('knowledge-select-filtered').click();
      await ui.getByTestId('knowledge-batch-reject').click();
      await ui.getByTestId('knowledge-batch-confirm').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect((await read()).data.entries.find(e => e.id === extraId)?.state).toBe('rejected');
      expect((await read()).data.entries).toHaveLength(102);
      await configure('en');
      await win.evaluate(w => w.setSize(820, 700));
      await ui.getByTestId('knowledge-review').click();
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await ui.getByTestId('knowledge-select-filtered').click();
      await capture('03-narrow-dark-selection');
      await ui.getByTestId('knowledge-batch-adopt').click();
      await capture('04-narrow-dark-preview');
      await ui.locator(`[data-batch-entry="${fixture.entries[0].id}"]`).getByRole('button', { name: en.bulk_review.evidence, exact: true }).click();
      await capture('06-expanded-sources');
      await ui.getByTestId('knowledge-record-close').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText('2 selected');
      await uiExpect(ui.locator('body')).not.toHaveCSS('pointer-events', 'none');
      expect(errors).toEqual([]);
      await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ accepted: 99, rejected: 1, pending: 2, noNewIdentityAdopted: true, errors }, null, 2));
    } catch (error) {
      await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
      throw error;
    } finally {
      await app.close();
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root).startsWith('fusionkit-bulk-review-')).toBe(true);
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 180000);
});
