import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeFixture } from './fixtures';
import type { Entry } from '../../src/translation-knowledge/schemas';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

const screenshots = path.resolve('test-results/knowledge-entry-dialogs');

/** Settle only the dialog being inspected: the surrounding app has intentional looping motion. */
async function settle(dialog: Locator) {
  await uiExpect(dialog).toBeVisible();
  await dialog.evaluate(element => new Promise<void>((resolve, reject) => {
    const started = performance.now();
    let previous: number[] = [], stable = 0;
    const sample = () => {
      const nodes = [element, ...element.querySelectorAll('[data-slot="scroll-area-viewport"], [data-testid="knowledge-record-primary-actions"]')];
      const values = nodes.flatMap(node => {
        const rect = node.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      });
      stable = previous.length === values.length && values.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
      previous = values;
      if (stable >= 8 && performance.now() - started >= 200) { resolve(); return; }
      if (performance.now() - started > 5000) { reject(new Error('Entry dialog layout did not settle')); return; }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

function primaryText(entry: Entry) {
  return entry.kind === 'term' || entry.kind === 'memory' ? entry.payload.source
    : entry.kind === 'expression' ? entry.payload.sourcePhrase : entry.payload.text;
}

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('translation material record dialogs in native Electron', () => {
  it('keeps five record types readable and separates editing, review and maintenance actions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-entry-dialogs-'));
    const fixture = knowledgeFixture();
    const term = fixture.entries.find((entry): entry is Extract<Entry, { kind: 'term' }> => entry.kind === 'term')!;
    const context = fixture.entries.find(entry => entry.kind === 'context')!;
    term.title = 'checkpoint：跨语言冒险游戏的保存进度位置 · 长标题、译名适用范围与用户来源依据的完整阅读示例';
    term.payload.source = 'checkpoint for the northern expedition and the interstellar exploration mission';
    term.payload.target = '北境远征与星际探索任务中的存档点';
    term.payload.aliases = ['expedition checkpoint', `checkpoint_${'long_identifier_'.repeat(12)}`];
    term.payload.sense = '仅指游戏中保存进度的位置；不包括软件调试、边境检查站或医疗检查。\n分段说明帮助阅读，也应保留用户写入的换行。';
    fixture.sources[0].excerpt = Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 条来源说明：该约定只适用于虚构游戏的保存进度机制。内容包括上下文、人工确认依据以及不能推广到其他语境的限制。`).join('\n\n');
    fixture.sources[0].url = `https://example.invalid/translation-materials/${'long-source-reference-'.repeat(12)}`;
    fixture.collections[0].name = '游戏 X 自订资料 · 北境远征与星际探索任务的术语、背景和表达约定';
    fixture.recipes[0].instructions = '保留人物说话风格，准确翻译专有名词。\n'.repeat(18);
    const input = path.join(root, 'all-record-types.fktk.json');
    await mkdir(screenshots, { recursive: true });
    await writeFile(input, JSON.stringify(fixture));
    const application = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' },
    });
    const errors: string[] = [];
    const evidence: unknown[] = [];
    try {
      const page: Page = await application.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      const nativeWindow = await application.browserWindow(page);
      let labels = zh;
      const read = () => page.evaluate(async () => {
        const result = await window.translationKnowledge.read();
        if (!result.ok) throw new Error(result.error);
        return result.value;
      });
      const ready = async () => {
        await uiExpect(page.getByTestId('knowledge-import')).toBeEnabled();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      };
      const configure = async (locale: 'zh' | 'en') => {
        labels = locale === 'zh' ? zh : en;
        await page.evaluate(locale => {
          localStorage.setItem('lang', locale);
          localStorage.setItem('translation-knowledge-tour-done', '1');
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: locale === 'zh' ? 'light' : 'dark' }, version: 0 }));
          location.hash = '/tools/translation-knowledge';
        }, locale);
        await page.reload();
        await nativeWindow.evaluate((win, locale) => win.setSize(locale === 'zh' ? 1280 : 820, locale === 'zh' ? 860 : 700), locale);
        await ready();
        if (locale === 'en') await uiExpect(page.locator('html')).toHaveClass(/dark/);
        else await uiExpect(page.locator('html')).not.toHaveClass(/dark/);
      };
      const dialog = () => page.getByRole('dialog', { includeHidden: true });
      const closeRecord = async () => {
        await page.getByTestId('knowledge-record-close').click();
      };
      const closePreview = async () => {
        await page.getByTestId('knowledge-record-close').click();
        await uiExpect(dialog()).toHaveCount(0);
      };
      const expectWorkspaceInteractive = async () => {
        await uiExpect(dialog()).toHaveCount(0);
        await uiExpect(page.getByRole('menu')).toHaveCount(0);
        // A menu action can unmount its parent dialog before both Radix layers
        // release their pointer lock. Absence of visible dialogs alone is insufficient.
        await uiExpect(page.locator('body')).not.toHaveCSS('pointer-events', 'none');
        await uiExpect(page.locator('html')).not.toHaveCSS('pointer-events', 'none');
      };
      const capture = async (name: string, record = true) => {
        await ready();
        await settle(dialog());
        const geometry = await dialog().evaluate(element => {
          const rect = element.getBoundingClientRect();
          const viewports = [...element.querySelectorAll('[data-slot="scroll-area-viewport"]')];
          const actions = element.querySelector('[data-testid="knowledge-record-primary-actions"]');
          const footer = actions?.parentElement;
          const actionButtons = actions ? [...actions.querySelectorAll('button')].filter(button => button.getClientRects().length > 0) : [];
          return {
            fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
            overflow: element.scrollWidth > element.clientWidth + 1,
            contentOverflow: viewports.some(viewport => viewport.scrollWidth > viewport.clientWidth + 1),
            primaryButtonCount: actionButtons.length,
            footerOutsideScroller: Boolean(footer && !footer.closest('[data-slot="scroll-area-viewport"]')),
            footerVisible: Boolean(footer && footer.getBoundingClientRect().bottom <= rect.bottom + 1),
          };
        });
        expect(geometry.fits, name).toBe(true);
        expect(geometry.overflow, name).toBe(false);
        expect(geometry.contentOverflow, name).toBe(false);
        if (record) {
          expect(geometry.primaryButtonCount, name).toBeGreaterThan(0);
          expect(geometry.primaryButtonCount, name).toBeLessThanOrEqual(3);
          expect(geometry.footerOutsideScroller, name).toBe(true);
          expect(geometry.footerVisible, name).toBe(true);
        }
        evidence.push({ name, ...geometry });
        await page.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
      };
      const assertFirstScreen = async (entry: Entry) => {
        await settle(dialog());
        const text = page.getByTestId('knowledge-entry-detail').getByText(primaryText(entry), { exact: true }).first();
        await uiExpect(text).toBeVisible();
        const geometry = await text.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const viewport = element.closest('[data-slot="scroll-area-viewport"]')!.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, visibleTop: viewport.top, visibleBottom: viewport.bottom };
        });
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.visibleTop - 1);
        expect(geometry.top).toBeLessThan(geometry.visibleBottom - 20);
      };
      const openTerm = async () => {
        await page.getByTestId('knowledge-all').click();
        await page.getByTestId('knowledge-views').getByRole('tab', { name: labels.workspace.terms, exact: true }).click();
        await page.getByTestId(`knowledge-entry-details-${term.id}`).click();
        await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      };
      const openActions = async () => {
        await page.getByTestId('knowledge-entry-actions').click();
        await uiExpect(page.getByRole('menu')).toBeVisible();
      };

      await configure('zh');
      // Import via the actual native selection/preload/service path. Only the OS picker is controlled.
      await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByTestId('knowledge-import').click();
      await page.getByRole('button', { name: zh.actions.confirm_import, exact: true }).click();
      await uiExpect(dialog()).toHaveCount(0);
      const imported = await read();
      expect(imported.data.entries).toHaveLength(5);
      expect(Object.keys(imported.approvals)).toHaveLength(0);

      // Both themes/windows use the same imported records. A read/edit/cancel journey must not mutate them.
      for (const locale of ['zh', 'en'] as const) {
        if (locale === 'en') await configure(locale);
        const mode = locale === 'zh' ? 'zh-light-wide' : 'en-dark-narrow';
        await page.getByTestId('knowledge-review').click();
        for (const entry of fixture.entries) {
          await page.getByTestId(`knowledge-entry-details-${entry.id}`).click();
          await uiExpect(page.getByTestId('knowledge-entry-adopt')).toBeVisible();
          await assertFirstScreen(entry);
          await capture(`detail-${entry.kind}-${mode}`);
          if (entry.kind === 'term') {
            await uiExpect(page.getByTestId('knowledge-entry-scope')).toBeVisible();
            for (const section of ['sources', 'all-fields']) {
              const trigger = page.getByTestId(`knowledge-entry-${section}`).locator('[data-slot="accordion-trigger"]');
              await uiExpect(trigger).toHaveAttribute('aria-expanded', 'false');
              await trigger.click();
              await uiExpect(trigger).toHaveAttribute('aria-expanded', 'true');
              await trigger.click();
            }
            await page.getByTestId('knowledge-entry-sources').locator('[data-slot="accordion-trigger"]').click();
            await settle(dialog());
            const footer = page.getByTestId('knowledge-record-primary-actions').locator('..');
            const before = await footer.boundingBox();
            await dialog().locator('[data-slot="scroll-area-viewport"]').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
            await settle(dialog());
            const after = await footer.boundingBox();
            expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
            await capture(`detail-sources-scrolled-${mode}`);
          }
          await page.getByTestId('knowledge-entry-edit').click();
          await uiExpect(page.getByTestId('knowledge-entry-editor')).toBeVisible();
          await capture(`editor-${entry.kind}-${mode}`);
          if (entry.kind === 'term') {
            const tabs = dialog().getByRole('tablist', { name: labels.record.settings });
            const panel = page.getByTestId('knowledge-entry-wording');
            const rawAliases = 'checkpoint\n\n  save point  \n';
            const aliases = panel.getByLabel(labels.fields.aliases_lines, { exact: true });
            await aliases.fill(rawAliases);
            for (const value of ['language', 'scope', 'metadata', 'wording'] as const) {
              await tabs.getByRole('tab', { name: labels.record[`tab_${value}`], exact: true }).click();
              await uiExpect(dialog().getByRole('tabpanel')).toHaveCount(1);
              const activePanel = page.getByTestId(`knowledge-entry-${value}`);
              await uiExpect(activePanel).toBeVisible();
              // Content grows naturally; the dialog viewport is the only scroll owner.
              expect(await activePanel.evaluate(element => {
                const style = getComputedStyle(element);
                return style.overflowY === 'visible' && element.scrollHeight <= element.clientHeight + 1;
              })).toBe(true);
              if (value === 'metadata') {
                const note = activePanel.locator('textarea');
                await note.evaluate(element => { element.style.height = '800px'; });
                const viewport = dialog().locator('[data-slot="scroll-area-viewport"]').first();
                await uiExpect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
                const footer = page.getByTestId('knowledge-record-primary-actions');
                await settle(dialog());
                const before = await footer.boundingBox();
                await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
                await settle(dialog());
                const after = await footer.boundingBox();
                expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
                await capture(`editor-dialog-scrolled-${mode}`);
                await note.evaluate(element => { element.style.removeProperty('height'); });
                await viewport.evaluate(element => { element.scrollTop = 0; });
              }
              await settle(dialog());
              await capture(`editor-tab-${value}-${mode}`);
            }
            await uiExpect(aliases).toHaveValue(rawAliases);
            await uiExpect(dialog().getByText(labels.workspace.apply_help, { exact: true })).toHaveCount(0);
          }
          await closeRecord();
          await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
          await closeRecord();
          await uiExpect(dialog()).toHaveCount(0);
        }
      }
      expect(await read()).toEqual(imported);

      // Escape dismisses the local menu first, preserving the record and route.
      await openTerm();
      await openActions();
      await capture('candidate-actions-en-dark-narrow');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByRole('menu')).toHaveCount(0);
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      await uiExpect(page.getByTestId('knowledge-entry-actions')).toBeFocused();
      expect(new URL(page.url()).hash).toBe('#/tools/translation-knowledge');
      await page.getByTestId('knowledge-entry-adopt').click();
      await uiExpect(dialog()).toHaveCount(0);
      const approved = await read();
      expect(approved.data.entries.find(entry => entry.id === term.id)?.state).toBe('ready');
      expect(approved.approvals[term.id]?.method).toBe('human');
      await openTerm();
      await uiExpect(page.getByTestId('knowledge-entry-adopt')).toHaveCount(0);
      await capture('detail-term-ready-en-dark-narrow');

      await page.getByTestId('knowledge-entry-edit').click();
      await page.getByRole('textbox', { name: en.fields.target_text, exact: true }).fill('取消时不应写入的译文');
      await closeRecord();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      expect(await read()).toEqual(approved);
      await page.getByTestId('knowledge-entry-edit').click();
      await page.getByRole('textbox', { name: en.fields.target_text, exact: true }).fill('保存草稿后的存档点');
      // Fail one native save response, then automatically restore the production
      // handler. The subsequent retry must retain the draft and really persist it.
      await application.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const channel = 'translation-knowledge:save-record', original = handlers.get(channel);
        if (!original) throw new Error('Missing production knowledge save handler');
        handlers.set(channel, () => {
          handlers.set(channel, original);
          return { ok: false, error: 'write_failed' };
        });
      });
      await page.getByTestId('knowledge-save-draft').click();
      const saveError = page.getByTestId('knowledge-entry-editor').getByRole('alert');
      await uiExpect(saveError).toContainText(en.errors.write_failed);
      await uiExpect(saveError).toBeFocused();
      await uiExpect(saveError).toBeInViewport();
      await uiExpect(page.getByRole('textbox', { name: en.fields.target_text, exact: true })).toHaveValue('保存草稿后的存档点');
      expect(await read()).toEqual(approved);
      await capture('editor-save-error-en-dark-narrow');
      await page.getByTestId('knowledge-save-draft').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      const drafted = await read();
      expect(drafted.data.entries.find(entry => entry.id === term.id)?.state).toBe('candidate');
      expect(drafted.approvals[term.id]).toBeUndefined();
      expect(drafted.data.entries.find(entry => entry.id === term.id)?.revision).toBe(approved.data.entries.find(entry => entry.id === term.id)!.revision + 1);
      await page.getByTestId('knowledge-entry-edit').click();
      await page.getByRole('textbox', { name: en.fields.target_text, exact: true }).fill('保存并启用后的存档点');
      await page.getByTestId('knowledge-save-apply').click();
      await uiExpect(page.getByTestId('knowledge-entry-detail')).toBeVisible();
      const applied = await read();
      const current = applied.data.entries.find(entry => entry.id === term.id)!;
      expect(current.state).toBe('ready');
      expect(applied.approvals[term.id]?.revision).toBe(current.revision);

      // Copy opens a new draft. Cancelling or saving it must not edit the approved source.
      await openActions();
      await page.getByTestId('knowledge-entry-copy').click();
      await uiExpect(page.getByTestId('knowledge-entry-editor')).toBeVisible();
      await closeRecord();
      await expectWorkspaceInteractive();
      expect(await read()).toEqual(applied);
      await openTerm();
      await openActions();
      await page.getByTestId('knowledge-entry-copy').click();
      await page.getByRole('textbox', { name: en.fields.source_text, exact: true }).fill('a copied checkpoint');
      await page.getByTestId('knowledge-save-draft').click();
      await expectWorkspaceInteractive();
      const copied = await read();
      expect(copied.data.entries).toHaveLength(6);
      expect(copied.data.entries.find(entry => entry.id === term.id)).toEqual(current);
      const copy = copied.data.entries.find(entry => !fixture.entries.some(original => original.id === entry.id))!;
      expect(copy.state).toBe('candidate');
      expect(copied.approvals[copy.id]).toBeUndefined();

      await page.getByTestId('knowledge-review').click();
      await page.getByTestId(`knowledge-entry-details-${context.id}`).click();
      await openActions();
      await page.getByTestId('knowledge-entry-reject').click();
      await expectWorkspaceInteractive();
      expect((await read()).data.entries.find(entry => entry.id === context.id)?.state).toBe('rejected');

      // Archive has a reviewable preview and cancel is a no-op. Restoring requires approval again.
      await openTerm();
      await openActions();
      await page.getByTestId('knowledge-entry-maintenance').click();
      await uiExpect(page.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
      const beforeArchive = await read();
      await capture('entry-archive-preview-en-dark-narrow', false);
      await closePreview();
      await expectWorkspaceInteractive();
      await uiExpect(page.getByTestId(`knowledge-entry-details-${term.id}`)).toBeFocused();
      expect(await read()).toEqual(beforeArchive);
      await openTerm();
      await openActions();
      await page.getByTestId('knowledge-entry-maintenance').click();
      await page.getByTestId('knowledge-maintenance-confirm').click();
      await expectWorkspaceInteractive();
      expect((await read()).data.entries.find(entry => entry.id === term.id)?.state).toBe('archived');
      await page.getByTestId('knowledge-archive').click();
      await page.getByTestId(`knowledge-entry-details-${term.id}`).click();
      await uiExpect(page.getByTestId('knowledge-entry-adopt')).toHaveCount(0);
      await capture('detail-term-archived-en-dark-narrow');
      await openActions();
      await uiExpect(page.getByTestId('knowledge-entry-purge')).toHaveAttribute('role', 'menuitem');
      await page.keyboard.press('Escape');
      await page.getByTestId('knowledge-entry-maintenance').click();
      await capture('entry-restore-preview-en-dark-narrow', false);
      await page.getByTestId('knowledge-maintenance-confirm').click();
      await expectWorkspaceInteractive();
      const restored = await read();
      expect(restored.data.entries.find(entry => entry.id === term.id)?.state).toBe('needs_review');
      expect(restored.approvals[term.id]).toBeUndefined();

      // Catalog editors share the same fixed action hierarchy and keep management in a local menu.
      for (const locale of ['zh', 'en'] as const) {
        await configure(locale);
        const mode = locale === 'zh' ? 'zh-light-wide' : 'en-dark-narrow';
        await page.locator(`[data-collection-id="${fixture.collections[0].id}"]`).click();
        await page.getByTestId('knowledge-edit-collection').click();
        await uiExpect(page.getByTestId('knowledge-catalog-editor')).toBeVisible();
        await capture(`catalog-collection-${mode}`);
        await page.getByTestId('knowledge-catalog-more').click();
        await uiExpect(page.getByTestId('knowledge-catalog-maintenance')).toHaveAttribute('role', 'menuitem');
        await uiExpect(page.getByTestId('knowledge-catalog-purge')).toHaveAttribute('role', 'menuitem');
        await page.keyboard.press('Escape');
        await uiExpect(page.getByRole('menu')).toHaveCount(0);
        await uiExpect(page.getByTestId('knowledge-catalog-editor')).toBeVisible();
        await closeRecord();
        await uiExpect(dialog()).toHaveCount(0);
        const management = page.locator('#knowledge-more-management').locator('[data-slot="accordion-trigger"]').first();
        if (await management.getAttribute('aria-expanded') === 'false') await management.click();
        await page.getByRole('button', { name: labels.views.plans, exact: true }).click();
        await page.getByRole('button').filter({ hasText: fixture.recipes[0].name }).first().click();
        await uiExpect(page.getByTestId('knowledge-catalog-editor')).toBeVisible();
        await capture(`catalog-plan-${mode}`);
        const before = await read();
        await page.getByRole('textbox', { name: labels.fields.instructions, exact: true }).fill('Unsaved changes must be discarded');
        await closeRecord();
        await uiExpect(dialog()).toHaveCount(0);
        expect(await read()).toEqual(before);
      }
      expect(errors).toEqual([]);
      await writeFile(path.join(screenshots, 'geometry.json'), JSON.stringify(evidence, null, 2));
    } finally {
      const child = application.process();
      try { await application.close(); }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  }, 180000);
});
