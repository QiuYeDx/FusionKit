import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { Collection, Entry, Preset, TermEntry } from '../../src/translation-knowledge/schemas';
import { KNOWLEDGE_CHANGED_EVENT } from '../../src/translation-knowledge/library-events';
import zh from '../../src/locales/zh/knowledge.json';

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));
const withoutRevision = <T extends { revision: number }>(record: T) => ({ ...record, revision: expect.any(Number) });

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

  it('selects, disables, moves and deletes entries with undo, and manages, archives and deletes collections with undo', async () => {
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
    const capture = async (name: string) => {
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await ui.waitForTimeout(250);
      expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await ui.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
    };
    const heading = ui.getByTestId('knowledge-collection-header').locator('h2');
    const selectCollection = async (collection: Collection) => {
      await ui.locator(`[data-collection-id="${collection.id}"]`).click();
      await uiExpect(heading).toHaveText(collection.name);
    };
    const table = ui.getByTestId('knowledge-term-table');
    const row = (entry: Entry) => table.locator(`[role="row"][data-entry-id="${entry.id}"]`);
    const checkbox = (term: TermEntry) => table.getByRole('checkbox', { name: fill(zh.terms.select, { source: term.payload.source }), exact: true });
    const toast = (text: string) => ui.locator('[data-sonner-toast]').filter({ hasText: text });
    const selectionBar = ui.getByTestId('knowledge-selection-bar');
    const openActions = async () => {
      await ui.getByTestId('knowledge-collection-actions').click();
      await uiExpect(ui.getByRole('menu')).toBeVisible();
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
      await uiExpect(ui.getByTestId('knowledge-empty-library')).toBeVisible();

      // Seed through the production preload boundary in one transaction.
      const fixture = await ui.evaluate(async () => {
        const initial = await window.translationKnowledge.read();
        if (!initial.ok) throw new Error(initial.error);
        const en = { source: 'en', target: 'zh-Hans' };
        const collection = (name: string, languagePair = en, archived = false): Collection => ({ id: crypto.randomUUID(), revision: 1, name, description: '', languagePair, archived });
        const main = collection('A · 游戏 X 术语');
        const target = collection('B · 通用游戏用语');
        const other = collection('C · 日语节目资料', { source: 'ja', target: 'zh-Hans' });
        const archived = collection('D · 已归档的旧项目', en, true);
        const term = (owner: Collection, source: string, target: string): TermEntry => ({
          id: crypto.randomUUID(), revision: 1, kind: 'term', collectionId: owner.id, enabled: true, origin: { kind: 'manual' },
          payload: { source, target, aliases: [], note: '', strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } },
        });
        const terms = [term(main, 'checkpoint', '存档点'), term(main, 'save slot', '存档槽'), term(main, 'boss', '首领'),
          term(main, 'quest', '任务'), term(main, 'loot', '战利品'), term(main, 'respawn', '重生')];
        const rule: Entry = { id: crypto.randomUUID(), revision: 1, kind: 'rule', collectionId: main.id, enabled: true, payload: { text: '保留角色名的原文写法', required: true } };
        const otherTerm = term(other, 'おはよう', '早上好');
        const preset: Preset = { id: crypto.randomUUID(), revision: 1, name: '游戏实况预设', languagePair: en, collectionIds: [main.id, target.id], instructions: '', context: '' };
        const saved = await window.translationKnowledge.saveRecords({ generation: initial.value.generation, items: [
          ...[main, target, other, archived].map(record => ({ group: 'collections' as const, record })),
          ...[...terms, rule, otherTerm].map(record => ({ group: 'entries' as const, record })),
          { group: 'presets' as const, record: preset },
        ] });
        if (!saved.ok) throw new Error(`${saved.error}: ${JSON.stringify(saved.diagnostics)}`);
        return { main, target, other, archived, terms, rule, otherTerm, preset };
      });
      const [checkpoint, saveSlot, boss, quest, loot, respawn] = fixture.terms;
      await ui.reload();
      // The first live collection by name opens by default.
      await uiExpect(heading).toHaveText(fixture.main.name);
      await uiExpect(table.locator('[role="row"][data-entry-id]')).toHaveCount(6);

      // AC-PAGE-05-1: checkbox, then Shift range; disabling 3 clears the selection.
      await checkbox(checkpoint).click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText(fill(zh.selection.count, { count: 1 }));
      await checkbox(boss).click({ modifiers: ['Shift'] });
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText(fill(zh.selection.count, { count: 3 }));
      for (const term of [checkpoint, saveSlot, boss]) await uiExpect(row(term)).toHaveAttribute('aria-selected', 'true');
      for (const term of [quest, loot, respawn]) await uiExpect(row(term)).toHaveAttribute('aria-selected', 'false');
      await uiExpect(ui.getByTestId('knowledge-select-page')).toHaveAttribute('data-state', 'indeterminate');
      await capture('01-range-selected');
      await ui.getByTestId('knowledge-selection-disable').click();
      await uiExpect(toast(fill(zh.selection.disabled_done, { count: 3 }))).toBeVisible();
      await uiExpect(selectionBar).toHaveCount(0);
      for (const term of [checkpoint, saveSlot, boss]) {
        await uiExpect(row(term)).toHaveAttribute('data-enabled', 'false');
        await uiExpect(row(term)).toContainText(zh.terms.disabled);
        await uiExpect(row(term)).toHaveAttribute('aria-selected', 'false');
      }
      let stored = await read();
      const enabledOf = (snapshot: LibrarySnapshot) => Object.fromEntries(fixture.terms.map(term => [term.payload.source, snapshot.data.entries.find(entry => entry.id === term.id)!.enabled]));
      expect(enabledOf(stored)).toEqual({ checkpoint: false, 'save slot': false, boss: false, quest: true, loot: true, respawn: true });

      // Select the whole page, then clear it again from the same header checkbox.
      await ui.getByTestId('knowledge-select-page').click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText(fill(zh.selection.count, { count: 6 }));
      await uiExpect(ui.getByTestId('knowledge-select-page')).toHaveAttribute('data-state', 'checked');
      await ui.getByTestId('knowledge-select-page').click();
      await uiExpect(selectionBar).toHaveCount(0);

      // AC-PAGE-05-2: only live collections with the same direction are offered as targets.
      await checkbox(quest).click();
      await checkbox(loot).click();
      await uiExpect(ui.getByTestId('knowledge-selection-count')).toHaveText(fill(zh.selection.count, { count: 2 }));
      await ui.getByTestId('knowledge-selection-move').click();
      const menu = ui.getByRole('menu');
      await uiExpect(menu).toContainText(zh.selection.move_help);
      await uiExpect(menu.locator('[data-move-target]')).toHaveCount(1);
      expect(await menu.locator('[data-move-target]').evaluateAll(items => items.map(item => item.getAttribute('data-move-target')))).toEqual([fixture.target.id]);
      await capture('02-move-targets');
      await menu.getByRole('menuitem', { name: fixture.target.name, exact: true }).click();
      await uiExpect(toast(fill(zh.selection.moved, { count: 2, name: fixture.target.name }))).toBeVisible();
      await uiExpect(row(quest)).toHaveCount(0);
      await uiExpect(row(loot)).toHaveCount(0);
      await uiExpect(selectionBar).toHaveCount(0);
      stored = await read();
      for (const term of [quest, loot]) expect(stored.data.entries.find(entry => entry.id === term.id)!.collectionId).toBe(fixture.target.id);
      await selectCollection(fixture.target);
      await uiExpect(row(quest)).toBeVisible();
      await uiExpect(row(loot)).toBeVisible();
      await selectCollection(fixture.main);

      // AC-PAGE-05-3: delete 2, then Undo in the toast restores the same content.
      const beforeDelete = await read();
      const deletedTerms = [checkpoint, saveSlot].map(term => beforeDelete.data.entries.find(entry => entry.id === term.id)!);
      await checkbox(checkpoint).click();
      await checkbox(saveSlot).click();
      await ui.getByTestId('knowledge-selection-delete').click();
      const deletedToast = toast(fill(zh.undo.deleted, { count: 2 }));
      await uiExpect(deletedToast).toBeVisible();
      await uiExpect(row(checkpoint)).toHaveCount(0);
      await uiExpect(row(saveSlot)).toHaveCount(0);
      stored = await read();
      expect(stored.data.entries.some(entry => deletedTerms.some(term => term.id === entry.id))).toBe(false);
      await capture('03-delete-undo-toast');
      await deletedToast.getByRole('button', { name: zh.undo.action, exact: true }).click();
      await uiExpect(toast(zh.undo.done)).toBeVisible();
      await uiExpect(row(checkpoint)).toBeVisible();
      await uiExpect(row(saveSlot)).toBeVisible();
      await uiExpect(row(checkpoint)).toHaveAttribute('data-enabled', 'false');
      stored = await read();
      for (const term of deletedTerms) expect(stored.data.entries.find(entry => entry.id === term.id)).toEqual(withoutRevision(term));

      // AC-PAGE-04-2: changing the direction of a collection with entries warns, then saves.
      await selectCollection(fixture.other);
      await ui.getByTestId('knowledge-edit-collection').click();
      const dialog = ui.getByRole('dialog');
      await uiExpect(dialog).toContainText(zh.collection.edit_title);
      await uiExpect(ui.getByTestId('knowledge-direction-warning')).toHaveCount(0);
      await dialog.getByRole('combobox', { name: zh.collection.target_language, exact: true }).click();
      await ui.getByRole('option', { name: zh.languages['zh-Hant'], exact: true }).click();
      await uiExpect(ui.getByTestId('knowledge-direction-warning')).toHaveText(fill(zh.collection.direction_changed, { count: 1 }));
      await capture('04-direction-warning');
      await dialog.getByRole('combobox', { name: zh.collection.target_language, exact: true }).click();
      await ui.getByRole('option', { name: zh.languages['zh-Hans'], exact: true }).click();
      await uiExpect(ui.getByTestId('knowledge-direction-warning')).toHaveCount(0);
      await dialog.getByRole('combobox', { name: zh.collection.target_language, exact: true }).click();
      await ui.getByRole('option', { name: zh.languages['zh-Hant'], exact: true }).click();
      await uiExpect(ui.getByTestId('knowledge-direction-warning')).toBeVisible();
      await ui.getByTestId('knowledge-collection-save').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-collection-direction')).toContainText(zh.languages['zh-Hant']);
      stored = await read();
      expect(stored.data.collections.find(item => item.id === fixture.other.id)!.languagePair).toEqual({ source: 'ja', target: 'zh-Hant' });
      expect(stored.data.entries.find(entry => entry.id === fixture.otherTerm.id)!.collectionId).toBe(fixture.other.id);

      // AC-PAGE-04-3: archiving moves it to the archived group; restoring puts it back.
      const liveList = ui.getByTestId('knowledge-collections-scroll');
      const liveOrder = () => liveList.locator('[data-collection-id]').evaluateAll(rows => rows.map(item => item.getAttribute('data-collection-id')));
      const before = await liveOrder();
      expect(before).toEqual([fixture.main.id, fixture.target.id, fixture.other.id]);
      await openActions();
      await ui.getByTestId('knowledge-collection-archive').click();
      await uiExpect(toast(fill(zh.collection.archived_done, { name: fixture.other.name }))).toBeVisible();
      await uiExpect(liveList.locator(`[data-collection-id="${fixture.other.id}"]`)).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-archived').locator(`[data-collection-id="${fixture.other.id}"]`)).toHaveCount(1);
      await uiExpect(ui.getByTestId('knowledge-archived')).toContainText(fill(zh.sidebar.archived, { count: 2 }));
      await uiExpect(ui.getByTestId('knowledge-archived-badge')).toBeVisible();
      await uiExpect(ui.getByTestId('knowledge-archived-help')).toHaveText(zh.collection.archived_help);
      await uiExpect(ui.getByTestId('knowledge-add-term')).toHaveCount(0);
      expect((await read()).data.collections.find(item => item.id === fixture.other.id)!.archived).toBe(true);
      await capture('05-archived');
      await ui.getByTestId('knowledge-collection-restore').click();
      await uiExpect(toast(fill(zh.collection.restored_done, { name: fixture.other.name }))).toBeVisible();
      await uiExpect.poll(liveOrder).toEqual(before);
      await uiExpect(ui.getByTestId('knowledge-archived').locator(`[data-collection-id="${fixture.other.id}"]`)).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-archived-badge')).toHaveCount(0);
      expect((await read()).data.collections.find(item => item.id === fixture.other.id)!.archived).toBe(false);

      // AC-PAGE-04-4 / AC-PAGE-05-4: the confirmation names what goes along; Undo restores all of it.
      await selectCollection(fixture.main);
      const beforeCollectionDelete = await read();
      const mainEntries = beforeCollectionDelete.data.entries.filter(entry => entry.collectionId === fixture.main.id);
      expect(mainEntries).toHaveLength(5);
      await openActions();
      await ui.getByTestId('knowledge-collection-delete').click();
      const impact = ui.getByTestId('knowledge-collection-delete-impact');
      await uiExpect(dialog).toContainText(fill(zh.collection.delete_title, { name: fixture.main.name }));
      await uiExpect(impact).toContainText(fill(zh.collection.delete_entries, { count: 5 }));
      await uiExpect(impact).toContainText(fill(zh.collection.delete_presets, { count: 1, names: fixture.preset.name }));
      await uiExpect(impact).toContainText(zh.collection.delete_undo);
      await capture('06-collection-delete-confirm');
      // Closing the confirmation changes nothing.
      await dialog.getByRole('button', { name: zh.actions.close, exact: true }).click();
      await uiExpect(dialog).toHaveCount(0);
      expect(await read()).toEqual(beforeCollectionDelete);
      await openActions();
      await ui.getByTestId('knowledge-collection-delete').click();
      await ui.getByTestId('knowledge-collection-delete-confirm').click();
      await uiExpect(dialog).toHaveCount(0);
      const collectionToast = toast(fill(zh.undo.collection_deleted, { name: fixture.main.name }));
      await uiExpect(collectionToast).toBeVisible();
      await uiExpect(ui.locator(`[data-collection-id="${fixture.main.id}"]`)).toHaveCount(0);
      await uiExpect(heading).not.toHaveText(fixture.main.name);
      stored = await read();
      expect(stored.data.collections.some(item => item.id === fixture.main.id)).toBe(false);
      expect(stored.data.entries.some(entry => entry.collectionId === fixture.main.id)).toBe(false);
      expect(stored.data.presets.find(item => item.id === fixture.preset.id)!.collectionIds).toEqual([fixture.target.id]);
      await collectionToast.getByRole('button', { name: zh.undo.action, exact: true }).click();
      await uiExpect(toast(zh.undo.done).last()).toBeVisible();
      await uiExpect(ui.locator(`[data-collection-id="${fixture.main.id}"]`)).toBeVisible();
      stored = await read();
      expect(stored.data.collections.find(item => item.id === fixture.main.id)).toEqual(withoutRevision(fixture.main));
      expect(stored.data.entries.filter(entry => entry.collectionId === fixture.main.id)).toEqual(expect.arrayContaining(mainEntries.map(withoutRevision)));
      expect(stored.data.entries.filter(entry => entry.collectionId === fixture.main.id)).toHaveLength(5);
      expect(stored.data.presets.find(item => item.id === fixture.preset.id)!.collectionIds).toEqual(fixture.preset.collectionIds);
      await uiExpect(collectionToast).toHaveCount(0);

      // AC-PAGE-05-5: when the same id was re-created meanwhile, Undo fails and restores nothing.
      await selectCollection(fixture.main);
      await uiExpect(table.locator('[role="row"][data-entry-id]')).toHaveCount(4);
      await openActions();
      await ui.getByTestId('knowledge-collection-delete').click();
      await ui.getByTestId('knowledge-collection-delete-confirm').click();
      await uiExpect(dialog).toHaveCount(0);
      const conflictToast = toast(fill(zh.undo.collection_deleted, { name: fixture.main.name }));
      await uiExpect(conflictToast).toBeVisible();
      const recreatedName = 'A · 同编号的新资料集';
      // Another in-app save (the assistant or a Studio dialog) announces its library like this.
      await ui.evaluate(async ({ id, name, event }) => {
        const current = await window.translationKnowledge.read();
        if (!current.ok) throw new Error(current.error);
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [
          { group: 'collections', record: { id, revision: 1, name, description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: false } },
        ] });
        if (!saved.ok) throw new Error(saved.error);
        window.dispatchEvent(new CustomEvent(event, { detail: saved.value }));
      }, { id: fixture.main.id, name: recreatedName, event: KNOWLEDGE_CHANGED_EVENT });
      await uiExpect(ui.locator(`[data-collection-id="${fixture.main.id}"]`)).toContainText(recreatedName);
      const beforeUndo = await read();
      await conflictToast.getByRole('button', { name: zh.undo.action, exact: true }).click();
      const failure = ui.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: zh.undo.failed });
      await uiExpect(failure).toBeVisible();
      await uiExpect(failure).toContainText(zh.undo.reason_exists);
      await capture('07-undo-conflict');
      stored = await read();
      expect(stored).toEqual(beforeUndo);
      expect(stored.data.collections.find(item => item.id === fixture.main.id)!.name).toBe(recreatedName);
      expect(stored.data.entries.some(entry => mainEntries.some(original => original.id === entry.id))).toBe(false);
      expect(stored.data.presets.find(item => item.id === fixture.preset.id)!.collectionIds).toEqual([fixture.target.id]);
      expect(errors).toEqual([]);
    } catch (error) {
      await ui.screenshot({ path: path.join(screenshots, 'collection-maintenance-failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 120_000);
});
