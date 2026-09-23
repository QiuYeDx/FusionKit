import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SaveRecordRequest } from '../../src/translation-knowledge/ipc-contract';
import type { Collection, Entry, Recipe, Source } from '../../src/translation-knowledge/schemas';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('collection maintenance in native Electron', () => {
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let root = '';
  const screenshots = path.resolve('test-results/translation-knowledge-collection-maintenance');

  afterAll(async () => {
    try {
      const child = application?.process();
      await application?.close();
      if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('previews direct deletion, preserves cancelled changes and sources, and distinguishes archive from deletion', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-collection-maintenance-'));
    await mkdir(screenshots, { recursive: true });
    application = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' },
    });
    page = await application.firstWindow();
    const ui = page;
    const errors: string[] = [];
    ui.on('pageerror', error => errors.push(error.message));
    const nativeWindow = await application.browserWindow(ui);
    const read = () => ui.evaluate(async () => {
      const result = await window.translationKnowledge.read();
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
    const capture = async (name: string, target: Locator) => {
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await uiExpect(target).toBeVisible();
      // CSS screenshot animation disabling does not settle the dialog's Motion
      // layout. Sample the actual target until its geometry has stopped moving.
      await target.evaluate(element => new Promise<void>((resolve, reject) => {
        const started = performance.now();
        let previous: number[] = [], stable = 0;
        const sample = () => {
          const nodes = [element, ...element.querySelectorAll('div')];
          const values = nodes.flatMap(node => {
            const rect = node.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          });
          stable = previous.length === values.length && values.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
          previous = values;
          if (stable >= 8 && performance.now() - started > 250) { resolve(); return; }
          if (performance.now() - started > 5000) { reject(new Error('Collection maintenance layout did not settle')); return; }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }));
      const geometry = await target.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
          fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
          overflow: element.scrollWidth > element.clientWidth + 1,
          scrollingContentOverflows: [...element.querySelectorAll('[data-slot="scroll-area-viewport"]')].some(viewport => viewport.scrollWidth > viewport.clientWidth + 1),
        };
      });
      expect(geometry).toEqual({ fits: true, overflow: false, scrollingContentOverflows: false });
      await ui.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
    };
    const selectCollection = async (id: string, name: string) => {
      await ui.locator(`[data-collection-id="${id}"]`).click();
      await uiExpect(ui.locator('#knowledge-content-heading h2')).toHaveText(name);
    };
    const openActions = async () => {
      await ui.getByTestId('knowledge-collection-actions').click();
      await uiExpect(ui.getByRole('menu')).toBeVisible();
    };
    const openMaintenance = async (action: 'archive' | 'restore' | 'delete') => {
      await openActions();
      await ui.getByTestId(`knowledge-collection-${action}`).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeVisible();
    };
    const cancel = async () => {
      await ui.getByRole('dialog').getByRole('button', { name: /^(取消|Cancel)$/ }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
    };
    const confirm = async () => {
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
      await ui.getByTestId('knowledge-maintenance-confirm').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
    };
    const expectDirectDeletion = async () => {
      await uiExpect(ui.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
    };

    try {
      await ui.evaluate(() => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/translation-knowledge';
      });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await uiExpect(ui.getByTestId('knowledge-new-collection')).toBeEnabled();

      // Seed through the production preload boundary; no repository files,
      // maintenance plans or state transitions are stubbed by this scenario.
      const fixture = await ui.evaluate(async () => {
        const initial = await window.translationKnowledge.read();
        if (!initial.ok) throw new Error(initial.error);
        let snapshot = initial.value;
        const save = async (request: Omit<SaveRecordRequest, 'generation'>) => {
          const result = await window.translationKnowledge.saveRecord({ ...request, generation: snapshot.generation });
          if (!result.ok) throw new Error(`${result.error}: ${JSON.stringify(result.diagnostics)}`);
          snapshot = result.value;
        };
        const collection = (name: string): Collection => ({
          id: crypto.randomUUID(), revision: 1, archived: false, name, description: '', aboutSubjectIds: [],
          defaultLanguagePair: { source: 'en', target: 'zh-Hans' },
        });
        const empty = collection('可删除的空资料集');
        const filled = collection('旅行视频术语 · 本次删除的资料集');
        const other = collection('日常对话 · 保留的其他资料集');
        const archival = collection('暂时停用 · 可恢复的节目资料集');
        const referenced = collection('翻译方案正在使用的资料集');
        for (const record of [empty, filled, other, archival, referenced]) await save({ group: 'collections', record });
        const sharedSource: Source = {
          id: crypto.randomUUID(), revision: 1, kind: 'user_note', title: '多个资料集共用的人工译名约定',
          excerpt: '本地测试使用的译名约定；删除资料集不应连带删除来源依据。',
        };
        const archivalSource: Source = {
          id: crypto.randomUUID(), revision: 1, kind: 'user_note', title: '节目资料的独立人工来源',
          excerpt: '删除此资料集后，该来源仍可留待单独整理。',
        };
        for (const record of [sharedSource, archivalSource]) await save({ group: 'sources', record });
        const term = (owner: Collection, source: string, target: string, evidenceSource = sharedSource): Entry => ({
          id: crypto.randomUUID(), revision: 1, kind: 'term', title: `${source} → ${target}`, collectionId: owner.id,
          aboutSubjectIds: [], scope: { languagePair: { source: 'en', target: 'zh-Hans' }, requiredSubjects: [], condition: { mode: 'none' } },
          state: 'ready', evidence: [{ sourceId: evidenceSource.id, support: 'direct' }], derivedFrom: [],
          payload: { source, target, aliases: [], sense: '', match: { mode: 'whole_term', caseSensitive: false }, strength: 'preferred' },
        });
        const filledTerms = [term(filled, 'checkpoint', '存档点'), term(filled, 'save slot', '存档槽')];
        const otherTerm = term(other, 'good morning', '早安');
        const archivalTerm = term(archival, 'opening scene', '开场', archivalSource);
        const referencedTerm = term(referenced, 'closing scene', '尾声');
        for (const record of [...filledTerms, otherTerm, archivalTerm, referencedTerm]) await save({ group: 'entries', record, adopt: true });
        const recipe: Recipe = {
          id: crypto.randomUUID(), revision: 1, archived: false, name: '节目字幕英中翻译方案', description: '',
          languagePair: { source: 'en', target: 'zh-Hans' }, readCollectionIds: [referenced.id], subjectSuggestions: [],
          modifierStyleIds: [], instructions: '', context: '', inheritGlobalPreferences: true, learningSuggestion: 'off',
        };
        await save({ group: 'recipes', record: recipe });
        return { empty, filled, other, archival, referenced, filledTerms, otherTerm, archivalTerm, referencedTerm, recipe, sharedSource, archivalSource };
      });
      await ui.reload();
      await uiExpect(ui.getByTestId('knowledge-new-collection')).toBeEnabled();
      const originalOther = (await read()).data.entries.find(entry => entry.id === fixture.otherTerm.id)!;
      const originalOtherApproval = (await read()).approvals[fixture.otherTerm.id];

      // An empty active collection can be deleted directly. Opening and
      // cancelling the preview must not first archive or revise anything.
      await selectCollection(fixture.empty.id, fixture.empty.name);
      const beforeEmpty = await read();
      await openMaintenance('archive');
      await uiExpect(ui.getByTestId('collection-maintenance-summary')).toContainText(fixture.empty.name);
      await uiExpect(ui.getByTestId('knowledge-collection-archive-details').locator('[data-slot=accordion-trigger]').first()).toContainText('0 项');
      await uiExpect(ui.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await capture('collection-archive-empty-light-wide', ui.getByRole('dialog'));
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(new URL(ui.url()).hash).toBe('#/tools/translation-knowledge');
      expect(await read()).toEqual(beforeEmpty);
      await openMaintenance('delete');
      await uiExpect(ui.getByTestId('collection-maintenance-summary')).toContainText(fixture.empty.name);
      await uiExpect(ui.getByTestId('knowledge-collection-delete-details').locator('[data-slot=accordion-trigger]').first()).toContainText('0 项');
      await uiExpect(ui.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await expectDirectDeletion();
      await cancel();
      expect(await read()).toEqual(beforeEmpty);
      await openMaintenance('delete');
      await expectDirectDeletion();
      await confirm();
      expect((await read()).data.collections.some(item => item.id === fixture.empty.id)).toBe(false);
      await uiExpect(ui.locator(`[data-collection-id="${fixture.empty.id}"]`)).toHaveCount(0);

      // A populated collection previews its real member list before anything
      // is changed, including the approvals of currently usable terms.
      await selectCollection(fixture.filled.id, fixture.filled.name);
      const beforeFilled = await read();
      expect(fixture.filledTerms.every(term => beforeFilled.data.entries.find(entry => entry.id === term.id)?.state === 'ready')).toBe(true);
      await openActions();
      await uiExpect(ui.getByTestId('knowledge-collection-archive')).toBeVisible();
      await uiExpect(ui.getByTestId('knowledge-collection-delete')).toBeVisible();
      await capture('collection-menu-light-wide', ui.getByRole('menu'));
      await ui.getByTestId('knowledge-collection-delete').click();
      await uiExpect(ui.getByTestId('collection-maintenance-summary')).toContainText(fixture.filled.name);
      await uiExpect(ui.getByTestId('knowledge-collection-delete-details').locator('[data-slot=accordion-trigger]').first()).toContainText('2 项');
      for (const term of fixture.filledTerms) await uiExpect(ui.getByRole('dialog')).toContainText(term.title);
      await uiExpect(ui.getByRole('dialog')).toContainText(fixture.sharedSource.title);
      await uiExpect(ui.getByRole('dialog')).toContainText('来源依据');
      const details = ui.getByTestId('knowledge-collection-delete-details');
      await uiExpect(details.locator('[data-slot=accordion-trigger]').first()).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(ui.getByTestId('knowledge-collection-delete-history')).toContainText('清理全部资料集的本地历史');
      await uiExpect(ui.getByTestId('knowledge-collection-delete-tasks')).toContainText('不受影响');
      await capture('collection-delete-light-wide', ui.getByRole('dialog'));
      const history = ui.getByTestId('knowledge-collection-delete-history');
      const separatorOpacity = () => history.evaluate(element => getComputedStyle(element, '::before').opacity);
      await uiExpect.poll(separatorOpacity).toBe('1');
      for (const [name, trigger] of [
        ['entries', details.locator('[data-slot=accordion-trigger]').first()], ['history', history.locator('[data-slot=accordion-trigger]').first()],
      ] as const) {
        await trigger.hover();
        await uiExpect.poll(separatorOpacity).toBe('0');
        const inset = await trigger.evaluate(element => {
          const row = element.getBoundingClientRect();
          const icon = element.firstElementChild!.getBoundingClientRect();
          const end = element.lastElementChild!.getBoundingClientRect();
          return { left: icon.left - row.left, right: row.right - end.right };
        });
        expect(inset).toEqual({ left: 8, right: 8 });
        await capture(`collection-delete-hover-${name}-light`, ui.getByRole('dialog'));
        await ui.getByRole('button', { name: '取消', exact: true }).hover();
        await uiExpect.poll(separatorOpacity).toBe('1');
      }
      const detailsTrigger = details.locator('[data-slot=accordion-trigger]').first();
      await detailsTrigger.focus();
      // Programmatic focus after hover remains in pointer modality. Traverse
      // the actual tab order so this checks the keyboard focus-visible state.
      await ui.keyboard.press('Tab');
      await ui.keyboard.press('Shift+Tab');
      await uiExpect(detailsTrigger).toBeFocused();
      await uiExpect.poll(separatorOpacity).toBe('0');
      await ui.keyboard.press('Enter');
      await uiExpect(detailsTrigger).toHaveAttribute('aria-expanded', 'true');
      // The lower divider now borders expanded content, not the hovered heading.
      await uiExpect.poll(separatorOpacity).toBe('1');
      await capture('collection-delete-details-light-wide', ui.getByRole('dialog'));
      await ui.keyboard.press('Space');
      await uiExpect(detailsTrigger).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(details.locator('[data-slot=accordion-content]').first()).toHaveAttribute('inert', '');
      await uiExpect(details.locator('li').first()).toBeHidden();
      await uiExpect.poll(separatorOpacity).toBe('0');
      await cancel();
      expect(await read()).toEqual(beforeFilled);

      await ui.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await selectCollection(fixture.filled.id, fixture.filled.name);
      await openActions();
      await capture('collection-menu-dark-narrow', ui.getByRole('menu'));
      await ui.getByTestId('knowledge-collection-delete').click();
      await uiExpect(ui.getByTestId('knowledge-collection-delete-details').locator('[data-slot=accordion-trigger]').first()).toContainText('2 项');
      await ui.getByTestId('knowledge-collection-delete-history').locator('[data-slot=accordion-trigger]').first().hover();
      await uiExpect.poll(separatorOpacity).toBe('0');
      await capture('collection-delete-dark-narrow', ui.getByRole('dialog'));
      await expectDirectDeletion();
      await confirm();
      let stored = await read();
      expect(stored.data.collections.some(item => item.id === fixture.filled.id)).toBe(false);
      for (const term of fixture.filledTerms) {
        expect(stored.data.entries.some(entry => entry.id === term.id)).toBe(false);
        expect(stored.approvals[term.id]).toBeUndefined();
      }
      expect(stored.data.collections.find(item => item.id === fixture.other.id)).toEqual(fixture.other);
      expect(stored.data.entries.find(entry => entry.id === fixture.otherTerm.id)).toEqual(originalOther);
      expect(stored.approvals[fixture.otherTerm.id]).toEqual(originalOtherApproval);
      expect(stored.data.sources.find(source => source.id === fixture.sharedSource.id)).toEqual(fixture.sharedSource);
      expect(stored.maintenance?.cleanupPending).toBe(false);

      // Archive is reversible suspension: retain the collection and terms,
      // invalidate applicability, and require a fresh confirmation on restore.
      await ui.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })));
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await selectCollection(fixture.archival.id, fixture.archival.name);
      const beforeArchive = await read();
      expect(beforeArchive.approvals[fixture.archivalTerm.id]).toBeDefined();
      await openMaintenance('archive');
      await uiExpect(ui.getByTestId('collection-maintenance-summary')).toContainText(fixture.archival.name);
      await uiExpect(ui.getByRole('dialog')).toContainText(/保留/);
      await uiExpect(ui.getByRole('dialog')).toContainText(/待审核|重新确认|重新审核/);
      await uiExpect(ui.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await uiExpect(ui.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toHaveText('归档资料集');
      const archiveDetails = ui.getByTestId('knowledge-collection-archive-details');
      await uiExpect(archiveDetails.locator('[data-slot=accordion-trigger]').first()).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(archiveDetails.locator('[data-slot=accordion-trigger]').first()).toContainText('1 项');
      await capture('collection-archive-light-wide', ui.getByRole('dialog'));
      await archiveDetails.locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(archiveDetails.locator('li').filter({ hasText: fixture.archivalTerm.title })).toBeVisible();
      await capture('collection-archive-details-light-wide', ui.getByRole('dialog'));
      await cancel();
      expect(await read()).toEqual(beforeArchive);

      await ui.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await selectCollection(fixture.archival.id, fixture.archival.name);
      await openMaintenance('archive');
      await archiveDetails.locator('[data-slot=accordion-trigger]').first().hover();
      await capture('collection-archive-dark-narrow', ui.getByRole('dialog'));
      await confirm();
      stored = await read();
      expect(stored.data.collections.find(item => item.id === fixture.archival.id)?.archived).toBe(true);
      expect(stored.data.entries.find(entry => entry.id === fixture.archivalTerm.id)?.state).toBe('needs_review');
      expect(stored.approvals[fixture.archivalTerm.id]).toBeUndefined();
      expect(stored.data.sources.find(source => source.id === fixture.archivalSource.id)).toEqual(fixture.archivalSource);
      await ui.getByTestId('knowledge-archive').click();
      await selectCollection(fixture.archival.id, fixture.archival.name);
      await uiExpect(ui.locator(`[data-entry-id="${fixture.archivalTerm.id}"]`)).toBeVisible();
      await capture('collection-archived-dark-narrow', ui.locator('#knowledge-content-heading'));
      await openMaintenance('restore');
      await uiExpect(ui.getByRole('dialog')).toContainText(/不会自动|重新确认|待审核/);
      await confirm();
      stored = await read();
      expect(stored.data.collections.find(item => item.id === fixture.archival.id)?.archived).toBe(false);
      expect(stored.data.entries.find(entry => entry.id === fixture.archivalTerm.id)?.state).toBe('needs_review');
      expect(stored.approvals[fixture.archivalTerm.id]).toBeUndefined();

      // Archived collections expose the same deletion action and retain their
      // own title, rather than an ambiguous generic archive heading.
      await selectCollection(fixture.archival.id, fixture.archival.name);
      await openMaintenance('archive');
      await confirm();
      await ui.getByTestId('knowledge-archive').click();
      await selectCollection(fixture.archival.id, fixture.archival.name);
      await openMaintenance('delete');
      await uiExpect(ui.getByTestId('collection-maintenance-summary')).toContainText(fixture.archival.name);
      await uiExpect(ui.getByTestId('knowledge-collection-delete-details').locator('[data-slot=accordion-trigger]').first()).toContainText('1 项');
      await expectDirectDeletion();
      await confirm();
      stored = await read();
      expect(stored.data.collections.some(item => item.id === fixture.archival.id)).toBe(false);
      expect(stored.data.entries.some(entry => entry.id === fixture.archivalTerm.id)).toBe(false);
      expect(stored.data.sources.find(source => source.id === fixture.archivalSource.id)).toEqual(fixture.archivalSource);
      expect(stored.data.entries.find(entry => entry.id === fixture.otherTerm.id)).toEqual(originalOther);
      expect(stored.approvals[fixture.otherTerm.id]).toEqual(originalOtherApproval);

      // An external recipe reference blocks the destructive action. The real
      // dependency name must be visible and cancellation leaves all data intact.
      await selectCollection(fixture.referenced.id, fixture.referenced.name);
      const beforeBlocked = await read();
      await openMaintenance('delete');
      await uiExpect(ui.getByRole('dialog')).toContainText(fixture.recipe.name);
      await uiExpect(ui.getByRole('dialog')).toContainText('仍被其他资料引用');
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeDisabled();
      await uiExpect(ui.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
      await capture('collection-delete-referenced-dark-narrow', ui.getByRole('dialog'));
      await cancel();
      expect(await read()).toEqual(beforeBlocked);
      // Long names and translated text must fit a short native window, with
      // deletion and cancellation still reachable while details scroll.
      const longName = 'TravelTerminologyWithoutWordBreaks'.repeat(4);
      await ui.evaluate(async ({ id, name }) => {
        const result = await window.translationKnowledge.read();
        if (!result.ok) throw new Error(result.error);
        const collection = result.value.data.collections.find(item => item.id === id)!;
        const saved = await window.translationKnowledge.saveRecord({ generation: result.value.generation, group: 'collections', record: { ...collection, name } });
        if (!saved.ok) throw new Error(saved.error);
        localStorage.setItem('lang', 'en');
      }, { id: fixture.other.id, name: longName });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(786, 660));
      await selectCollection(fixture.other.id, longName);
      await openMaintenance('archive');
      await uiExpect(ui.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toHaveText('Archive collection');
      await capture('collection-archive-english-long-name', ui.getByRole('dialog'));
      await archiveDetails.locator('[data-slot=accordion-trigger]').first().click();
      await capture('collection-archive-english-long-name-expanded', ui.getByRole('dialog'));
      await ui.getByRole('dialog').locator('[data-slot=scroll-area-viewport]').first().evaluate(element => { element.scrollTop = element.scrollHeight; });
      await uiExpect(ui.getByTestId('knowledge-collection-archive-restore-hint')).toBeVisible();
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeInViewport();
      await capture('collection-archive-english-long-name-scrolled', ui.getByRole('dialog'));
      await cancel();
      expect((await read()).data.collections.find(item => item.id === fixture.other.id)?.archived).toBe(false);
      await openMaintenance('delete');
      await uiExpect(ui.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await capture('collection-delete-english-long-name', ui.getByRole('dialog'));
      await ui.getByTestId('knowledge-collection-delete-history').locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(ui.getByRole('dialog').getByRole('checkbox')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
      await capture('collection-delete-english-long-name-expanded', ui.getByRole('dialog'));
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect((await read()).data.collections.some(item => item.id === fixture.other.id)).toBe(true);
      expect(errors).toEqual([]);
    } catch (error) {
      await ui.screenshot({ path: path.join(screenshots, 'collection-maintenance-failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 120_000);
});
