import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KnowledgePackage, TermEntry } from '../../src/translation-knowledge/schemas';
import { knowledgeFixture } from './fixtures';
import zh from '../../src/locales/zh/knowledge.json';

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('translation materials import and export in native Electron', () => {
  let app: ElectronApplication | undefined, page: Page | undefined;
  let root = '';
  const artifacts = path.resolve('test-results/translation-knowledge-consumer-ux');

  afterAll(async () => {
    try {
      const child = app?.process();
      await app?.close();
      if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('previews dropped packages, rejects other versions, merges same ids keeping local edits, and exports with warnings or cancels', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-consumer-ux-'));
    await mkdir(artifacts, { recursive: true });
    const fixture = knowledgeFixture();
    const packageFile = path.join(root, 'multi-collection.fktk.json');
    const legacyFile = path.join(root, 'legacy-v1.fktk.json');
    const textFile = path.join(root, 'not-a-package.txt');
    const exportDirectory = path.join(root, 'exports');
    await mkdir(exportDirectory);
    await Promise.all([
      writeFile(packageFile, JSON.stringify(fixture)),
      writeFile(legacyFile, JSON.stringify({ ...fixture, schemaVersion: 1 })),
      writeFile(textFile, 'checkpoint\t存档点\n'),
    ]);
    const errors: string[] = [];
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    const ui = page;
    ui.on('pageerror', error => errors.push(error.message));
    const nativeWindow = await app.browserWindow(ui);
    const capture = async (name: string) => {
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await ui.waitForTimeout(250);
      expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const readLibrary = () => ui.evaluate(async () => {
      const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value;
    });
    // A real file chosen through an input carries native file authority into the drop event.
    const drop = async (file: string) => {
      await ui.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.hidden = true; input.dataset.knowledgeDropFixture = ''; document.body.append(input); });
      await ui.locator('[data-knowledge-drop-fixture]').setInputFiles(file);
      await ui.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-knowledge-drop-fixture]')!;
        const target = document.querySelector('[data-testid=translation-knowledge]')!;
        for (const type of ['dragenter', 'drop']) {
          const transfer = new DataTransfer(); Array.from(input.files!).forEach(item => transfer.items.add(item));
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }
        input.remove();
      });
    };
    const dialog = ui.getByRole('dialog');
    const heading = ui.getByTestId('knowledge-collection-header').locator('h2');
    const toast = (text: string) => ui.locator('[data-sonner-toast]').filter({ hasText: text });
    const openFirst = async () => {
      await ui.locator(`[data-collection-id="${fixture.collections[0].id}"]`).click();
      await uiExpect(heading).toHaveText(fixture.collections[0].name);
    };
    const importRow = (id: string) => ui.getByTestId('knowledge-import-collections').locator(`[data-import-collection="${id}"]`);
    try {
      await ui.evaluate(() => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/translation-knowledge';
      });
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await uiExpect(ui.getByTestId('knowledge-empty-library')).toBeVisible();
      const empty = await readLibrary();

      // Only a single .fktk.json file is accepted as a drop.
      await drop(textFile);
      await uiExpect(ui.getByText(zh.import.drop_invalid, { exact: true })).toBeVisible();
      await uiExpect(dialog).toHaveCount(0);

      // AC-PAGE-06-1: a non-v2 package is refused with the version message and no preview.
      await drop(legacyFile);
      await uiExpect(ui.getByTestId('knowledge-import-error')).toHaveText(zh.import.unsupported_version);
      await uiExpect(ui.getByText(zh.import.drop_invalid, { exact: true })).toHaveCount(0);
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-import-collections')).toHaveCount(0);
      expect(await readLibrary()).toEqual(empty);
      await capture('01-unsupported-version');

      // AC-PAGE-06-1: a v2 package previews each collection with its status and count, then opens the first one.
      await drop(packageFile);
      await uiExpect(dialog).toContainText(zh.import.title);
      await uiExpect(dialog).toContainText(fill(zh.import.description, { name: fixture.package.name }));
      await uiExpect(ui.getByTestId('knowledge-import-error')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-import-collections').locator('[data-import-collection]')).toHaveCount(fixture.collections.length);
      for (const collection of fixture.collections) {
        const row = importRow(collection.id);
        await uiExpect(row).toHaveAttribute('data-status', 'new');
        await uiExpect(row).toContainText(collection.name);
        await uiExpect(row).toContainText(zh.import.status_new);
        await uiExpect(row).toContainText(fill(zh.import.entries, { count: fixture.entries.filter(entry => entry.collectionId === collection.id).length }));
        await uiExpect(row.getByRole('combobox', { name: fill(zh.import.action_for, { name: collection.name }), exact: true })).toHaveText(zh.import.action_add);
      }
      await uiExpect(dialog).toContainText(fill(zh.import.presets, { count: fixture.presets.length }));
      await uiExpect(dialog.getByText(zh.import.conflict, { exact: true })).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-import-commit')).toHaveText(fill(zh.import.commit, { count: fixture.collections.length }));
      await capture('02-import-preview-new');
      await ui.getByTestId('knowledge-import-commit').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(toast(fill(zh.import.done, { added: fixture.entries.length, updated: 0, skipped: 0 }))).toBeVisible();
      // The first imported collection, not the first by name (which would be shown by default).
      await uiExpect(heading).toHaveText(fixture.collections[0].name);
      let stored = await readLibrary();
      expect(stored.data.collections.map(item => item.id).sort()).toEqual(fixture.collections.map(item => item.id).sort());
      expect(stored.data.entries.map(item => item.id).sort()).toEqual(fixture.entries.map(item => item.id).sort());
      expect(stored.data.presets.map(item => item.id)).toEqual(fixture.presets.map(item => item.id));

      // AC-PAGE-06-2: change one entry and delete another locally, then import the same package again.
      const first = fixture.collections[0];
      const firstTerms = fixture.entries.filter((entry): entry is TermEntry => entry.collectionId === first.id && entry.kind === 'term');
      const firstEntries = fixture.entries.filter(entry => entry.collectionId === first.id);
      expect(firstTerms.length).toBeGreaterThanOrEqual(2);
      const [edited, removed] = firstTerms;
      const localTarget = '本地改过的译法';
      await ui.evaluate(async ({ editedId, removedId, target }) => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const entry = current.value.data.entries.find(item => item.id === editedId);
        if (entry?.kind !== 'term') throw new Error('Fixture term missing');
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [{ group: 'entries', record: { ...entry, payload: { ...entry.payload, target } } }] });
        if (!saved.ok) throw new Error(saved.error);
        const deleted = await window.translationKnowledge.deleteRecords({ generation: saved.value.generation, items: [{ group: 'entries', id: removedId }] });
        if (!deleted.ok) throw new Error(deleted.error);
      }, { editedId: edited.id, removedId: removed.id, target: localTarget });
      await ui.reload();
      await openFirst();
      await drop(packageFile);
      await uiExpect(dialog).toContainText(zh.import.title);
      for (const collection of fixture.collections) {
        const row = importRow(collection.id);
        const count = fixture.entries.filter(entry => entry.collectionId === collection.id).length;
        const compare = collection.id === first.id ? { added: 1, changed: 1, unchanged: count - 2 } : { added: 0, changed: 0, unchanged: count };
        await uiExpect(row).toHaveAttribute('data-status', 'existing');
        await uiExpect(row).toContainText(zh.import.status_existing);
        await uiExpect(row).toContainText(fill(zh.import.compare, compare));
        await uiExpect(row.getByRole('combobox', { name: fill(zh.import.action_for, { name: collection.name }), exact: true })).toHaveText(zh.import.action_merge);
      }
      await uiExpect(dialog.getByRole('combobox', { name: zh.import.conflict, exact: true })).toHaveText(zh.import.keep_local);
      await capture('03-import-preview-existing');
      await ui.getByTestId('knowledge-import-commit').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(toast(fill(zh.import.done, { added: 1, updated: 0, skipped: fixture.entries.length - 1 }))).toBeVisible();
      await uiExpect(heading).toHaveText(first.name);
      stored = await readLibrary();
      const keptLocal = stored.data.entries.find(entry => entry.id === edited.id);
      expect(keptLocal?.kind === 'term' && keptLocal.payload.target).toBe(localTarget);
      expect(stored.data.entries.find(entry => entry.id === removed.id)).toEqual({ ...removed, revision: 1 });
      expect(stored.data.entries.filter(entry => entry.collectionId === first.id)).toHaveLength(firstEntries.length);

      // AC-PAGE-06-3: content that looks like a local path is listed as a warning before saving.
      const privatePath = 'C:\\Users\\translator\\Documents\\private-glossary.txt';
      await ui.evaluate(async ({ collectionId, note }) => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [{ group: 'entries', record: {
          id: crypto.randomUUID(), revision: 1, kind: 'term', collectionId, enabled: true, origin: { kind: 'manual' },
          payload: { source: 'inventory', target: '背包', aliases: [], note, strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } },
        } }] });
        if (!saved.ok) throw new Error(saved.error);
      }, { collectionId: first.id, note: `整理自 ${privatePath}` });
      await ui.reload();
      await openFirst();
      const exportFiles = async () => readdir(exportDirectory);

      // Cancelling the native save dialog writes nothing and leaves the dialog open.
      await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
      await ui.getByTestId('knowledge-export').click();
      await uiExpect(dialog).toContainText(zh.export.title);
      await uiExpect(dialog.getByRole('checkbox', { name: new RegExp(`^${first.name} · `) })).toBeChecked();
      await uiExpect(ui.getByTestId('knowledge-export-save')).toHaveText(zh.export.save);
      await ui.getByTestId('knowledge-export-save').click();
      const warnings = ui.getByTestId('knowledge-export-warnings');
      await uiExpect(warnings).toBeVisible();
      await uiExpect(warnings).toContainText(zh.diagnostic.EXPORT_PRIVATE_CONTENT);
      await uiExpect(dialog).toContainText(zh.export.warnings_help);
      await uiExpect(ui.getByTestId('knowledge-export-save')).toHaveText(zh.export.save_anyway);
      expect(await exportFiles()).toEqual([]);
      await capture('04-export-warnings');
      await ui.getByTestId('knowledge-export-save').click();
      await uiExpect(ui.getByTestId('knowledge-export-save')).toBeEnabled();
      await uiExpect(dialog).toContainText(zh.export.title);
      expect(await exportFiles()).toEqual([]);
      expect(await readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^translation-knowledge-.*\.fktk\.json$/)]));
      await dialog.getByRole('button', { name: zh.actions.close, exact: true }).click();
      await uiExpect(dialog).toHaveCount(0);

      // The same warnings from the collection menu, then save anyway.
      const destination = path.join(exportDirectory, 'shared-collection.fktk.json');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination);
      await ui.getByTestId('knowledge-collection-actions').click();
      await ui.getByTestId('knowledge-collection-export').click();
      await uiExpect(dialog).toContainText(zh.export.title);
      await ui.getByTestId('knowledge-export-save').click();
      await uiExpect(warnings).toContainText(zh.diagnostic.EXPORT_PRIVATE_CONTENT);
      await ui.getByTestId('knowledge-export-save').click();
      await uiExpect(dialog).toHaveCount(0);
      const exportedCount = firstEntries.length + 1;
      await uiExpect(toast(fill(zh.export.done, { fileName: path.basename(destination), count: exportedCount }))).toBeVisible();
      expect(await exportFiles()).toEqual([path.basename(destination)]);
      const exported = JSON.parse(await readFile(destination, 'utf8')) as KnowledgePackage;
      expect(exported.schemaVersion).toBe(2);
      expect(exported.collections.map(item => item.id)).toEqual([first.id]);
      expect(exported.entries).toHaveLength(exportedCount);
      expect(JSON.stringify(exported)).toContain('private-glossary.txt');
      expect(errors).toEqual([]);
    } catch (error) {
      await ui.screenshot({ path: path.join(artifacts, 'consumer-ux-failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 120000);
});
