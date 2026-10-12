import { afterAll, describe, expect, it } from 'vitest';
import { expect as uiExpect, type Locator } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import { launchStudioApp, openSubtitles, preparePage, readDocuments, readLibrary, seedLibrary, settled, startProvider } from './studio-e2e';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateExecutionRecord } from '../../src/subtitle-studio/execution-record-contract';
import type { Entry } from '../../src/translation-knowledge/schemas';

const json = async (file: string) => JSON.parse(await readFile(path.resolve(file), 'utf8'));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('batch knowledge translation through native Electron', () => {
  let launched: Awaited<ReturnType<typeof launchStudioApp>> | undefined, provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  const artifacts = path.resolve('test-results/translation-knowledge-batch');
  afterAll(async () => {
    try { if (launched) expect(await launched.close()).toBe(true); } finally { await provider?.close(); }
  });

  it('checks three files with a preset, starts the two ready ones, and records the collections and entries of each', async () => {
    await mkdir(artifacts, { recursive: true });
    const zh = { studio: await json('src/locales/zh/studio.json'), knowledge: await json('src/locales/zh/knowledge.json'), materials: await json('src/locales/zh/materials.json') };
    const en = { studio: await json('src/locales/en/studio.json'), knowledge: await json('src/locales/en/knowledge.json') };
    provider = await startProvider(item => `批量译文：${item.text.replace(/checkpoint/gi, '存档点')}`);
    const fixture = knowledgeFixture();
    const [game, common] = fixture.collections;
    const preset = fixture.presets[0];
    const checkpoint = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'checkpoint')!;
    // Two selected collections fix different required translations; only the third file says it.
    const savepoints: Entry[] = [[game.id, '存档柱'], [common.id, '保存站']].map(([collectionId, target], index) => ({ id: `50000000-0000-4000-8000-00000000032${index}`, revision: 1,
      collectionId, enabled: true, kind: 'term', payload: { source: 'savepoint', target, aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } } }));
    fixture.entries.push(...savepoints);
    const sources = [
      { name: '01 Alpine — twenty four subtitle cues across independent analysis windows.lrc', marker: 'Alpine', count: 24 },
      { name: '02 Birch — separate short document.lrc', marker: 'Birch', count: 2 },
      { name: '03 Cobalt — conflicting required terminology needs review.lrc', marker: 'Cobalt', count: 2 },
    ];

    launched = await launchStudioApp('fusionkit-knowledge-batch-e2e-');
    const { app, ui } = launched;
    await Promise.all(sources.map(source => writeFile(path.join(launched!.root, source.name), Array.from({ length: source.count }, (_, index) => {
      const number = index + 1;
      const text = source.marker === 'Cobalt' ? `Cobalt savepoint ${number}.` : number === 1 || number === 21 ? `${source.marker} checkpoint ${number}.` : `${source.marker} dialogue ${number}.`;
      return `[00:${String(number).padStart(2, '0')}]${text}`;
    }).join('\n'))));
    const repository = new DocumentRepository(path.join(launched.profile, 'subtitle-studio', 'documents'));
    const settledFrames = () => ui.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const capture = async (name: string, target?: Locator) => {
      if (target) await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await settledFrames();
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const dialogFor = (testId: string) => ui.getByRole('dialog').filter({ has: ui.getByTestId(testId) });
    const geometry = async (dialog: Locator) => {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    };
    const issueTexts = async (scope: Locator, issues: Record<string, string>) => {
      const rows = await scope.locator('[data-issue-code]').evaluateAll(nodes => nodes.map(node => ({ code: node.getAttribute('data-issue-code')!, text: node.textContent ?? '' })));
      for (const row of rows) { expect(issues[row.code], `Locale text for ${row.code}`).toBeTruthy(); expect(row.text).toContain(issues[row.code]); }
      return rows.map(row => row.code);
    };
    const byName = (documents: Awaited<ReturnType<typeof readDocuments>>) => sources.map(source => documents.find(document => document.summary.origin.displayName === source.name)!);
    const selectDocuments = async (ids: string[]) => {
      for (const id of ids) await ui.locator(`[data-testid="studio-library-row"][data-document-id="${id}"]`).getByRole('checkbox').check();
    };
    const choosePreset = async () => {
      await ui.getByTestId('studio-materials-choose').click();
      await ui.getByTestId('studio-materials-tabs').getByRole('tab').nth(1).click();
      await ui.getByTestId(`studio-materials-preset-${preset.id}`).click();
      await ui.getByTestId('studio-materials-done').click();
      await uiExpect(ui.getByTestId('studio-materials-picker')).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-materials-summary').locator('.studio-materials-chip')).toHaveCount(2);
    };

    try {
      await preparePage(ui, { lang: 'zh', port: provider.port });
      const library = await seedLibrary(ui, fixture);
      await openSubtitles(app, ui, sources.map(source => path.join(launched!.root, source.name)), zh.studio.open_file);
      const documents = byName(await readDocuments(ui));
      const baseline = await Promise.all(documents.map(document => repository.readSnapshot(document.summary.id)));
      await selectDocuments(documents.map(document => document.summary.id));
      await uiExpect(ui.getByTestId('studio-batch-toolbar')).toContainText('3');
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: zh.studio.batch.translation, exact: true }).click();
      const dialog = dialogFor('studio-translation-form');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await ui.getByTestId('studio-translation-advanced').click();
      await dialog.getByRole('spinbutton', { name: zh.studio.translation.batch_cues, exact: true }).fill('20');
      await ui.getByTestId('studio-translation-advanced').click();
      await choosePreset();
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(preset.instructions);
      // A batch picks shared materials only: no sample lines, topics, roles or conditions.
      await uiExpect(ui.getByTestId('knowledge-trial-scopes')).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-translation-trial')).toHaveCount(0);
      await uiExpect(dialog.locator('[data-testid="studio-materials-topics"], [data-testid^="studio-materials-role-"], [data-testid^="studio-materials-confirm-"]')).toHaveCount(0);
      await capture('configuration-light', ui.getByTestId('studio-translation-form'));

      const preview = ui.getByTestId('knowledge-batch-preview'), start = ui.getByTestId('studio-translation-review-start');
      const file = (index: number) => ui.getByTestId(`knowledge-batch-file-${documents[index].summary.id}`);
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(preview).toBeVisible();
      await uiExpect(file(0)).toHaveAttribute('data-state', 'ready');
      await uiExpect(file(1)).toHaveAttribute('data-state', 'ready');
      await uiExpect(file(2)).toHaveAttribute('data-state', 'blocked');
      await uiExpect(start).toContainText('2');
      const conflict = file(2).locator('[data-issue-code="term_conflict"]');
      await uiExpect(conflict).toContainText(zh.knowledge.trial.issue.term_conflict);
      await conflict.locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(file(2)).toContainText('savepoint → 存档柱');
      await uiExpect(file(2)).toContainText('savepoint → 保存站');
      for (let index = 0; index < 3; index++) await issueTexts(file(index), zh.knowledge.trial.issue);
      expect(provider.requests).toHaveLength(0);
      expect(await Promise.all(documents.map(document => repository.readSnapshot(document.summary.id)))).toEqual(baseline);
      await capture('per-file-conflict-light', file(2));
      await geometry(dialogFor('studio-translation-review-dialog'));
      await start.click();

      const result = ui.getByTestId('studio-batch-result');
      await uiExpect(result).toHaveAttribute('data-outcome', 'partial');
      await result.locator('[data-slot="accordion-trigger"]').first().click();
      await uiExpect(result.locator('[data-state="success"]')).toHaveCount(2);
      await uiExpect(result.locator(`[data-result-id="${documents[2].summary.id}"]`)).toHaveAttribute('data-state', 'failed');
      await capture('partial-admission-light', result);
      await result.getByRole('button', { name: zh.studio.overview.view_progress, exact: true }).click();
      const overview = ui.getByTestId('studio-translation-overview-list');
      await uiExpect(overview.locator('[data-task-id]')).toHaveCount(2);
      await uiExpect(overview.locator('[data-state="completed"]')).toHaveCount(2, { timeout: 30000 });
      await uiExpect(overview).not.toContainText(sources[2].name);
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);

      const completed = byName(await readDocuments(ui));
      expect(completed[2]).toEqual(documents[2]);
      expect(provider.requests.length).toBeGreaterThanOrEqual(3);
      expect(provider.requests.every(request => request.payload.translationRequirements === preset.instructions)).toBe(true);
      for (const [index, source] of sources.slice(0, 2).entries()) {
        const document = completed[index];
        expect(document.tasks).toHaveLength(1); expect(document.tasks[0].status).toBe('completed');
        expect(Object.keys(document.translationTracks[0].entries)).toHaveLength(source.count);
        const own = provider.requests.filter(request => request.payload.items[0].text.startsWith(source.marker));
        expect(own.flatMap(request => request.payload.items.map(item => item.id))).toEqual(Array.from({ length: source.count }, (_, number) => `u${number + 1}`));
        for (const { payload } of own) for (const other of sources.filter(item => item !== source)) expect(JSON.stringify(payload)).not.toContain(other.marker);
        expect(own.flatMap(request => request.payload.translationKnowledge!.items.filter(item => item.kind === 'term').flatMap(item => item.applicableItemIds))).toEqual(source.count > 20 ? ['u1', 'u21'] : ['u1']);
        // Each file keeps its own frozen closure of exactly the preset's collections.
        const snapshot = await repository.readSnapshot(document.summary.id), track = snapshot.document.translationTracks[0];
        const record = validateExecutionRecord(snapshot.executionRecords![track.executionRef!.id], { ref: track.executionRef, documentId: document.summary.id, trackId: track.id });
        const frozen = record.knowledge!;
        expect(frozen.selection).toEqual({ version: 2, languagePair: preset.languagePair, collectionIds: preset.collectionIds, disabledEntryIds: [], instructions: preset.instructions, context: preset.context });
        expect(frozen.generation).toBe(library.generation);
        expect(frozen.data.collections.map(item => item.id)).toEqual(preset.collectionIds);
        expect(frozen.data.presets).toEqual([]);
        expect(frozen.data.entries.map(item => item.id).sort()).toEqual(library.data.entries.filter(item => preset.collectionIds.includes(item.collectionId)).map(item => item.id).sort());
        const view = await ui.evaluate(async ({ documentId, trackId }) => {
          const record = await window.subtitleStudio.readExecutionRecord({ documentId, trackId, batchOffset: 0 });
          if (!record.ok || record.value.state !== 'available') throw new Error(JSON.stringify(record)); return record.value;
        }, { documentId: document.summary.id, trackId: track.id });
        expect(view.knowledge?.collections).toEqual([game.name, common.name]);
        expect(view.knowledge?.compiled.items.map(item => item.entryId)).toContain(checkpoint.id);
      }
      for (const privateValue of [checkpoint.id, game.id, common.name, ...sources.map(source => source.name)]) expect(provider.requests.map(request => request.raw).join('\n')).not.toContain(privateValue);

      // The record detail of a batch file shows its collections and included entries.
      const showRecord = async (index: number) => {
        const trigger = ui.locator('#studio-library-trigger');
        if (await trigger.isVisible() && !(await ui.locator('.studio-library-dialog').isVisible())) await trigger.click();
        await ui.locator(`[data-testid="studio-library-row"][data-document-id="${documents[index].summary.id}"] .studio-document`).click();
        await ui.getByTestId('studio-execution-record').click();
        return dialogFor('studio-execution-record-content').getByTestId('studio-execution-knowledge');
      };
      const knowledge = await showRecord(0);
      await uiExpect(knowledge.locator('.studio-execution-facts dt')).toHaveText([zh.materials.selection.collections]);
      await uiExpect(knowledge.locator('.studio-execution-facts dd')).toHaveText(`${game.name} / ${common.name}`);
      await uiExpect(knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'checkpoint → 存档点' })).toContainText(zh.studio.execution.knowledge_required);
      expect(await knowledge.innerText()).not.toMatch(/方案|主题|条件/);
      for (const line of await knowledge.locator('.studio-execution-issues li > p:first-child').allInnerTexts()) expect(Object.values(zh.knowledge.trial.issue)).toContain(line);
      await capture('batch-record-light', knowledge);
      await geometry(dialogFor('studio-execution-record-content'));
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);

      // Cleaning up the tasks leaves every retained record unchanged.
      for (const document of completed.slice(0, 2)) {
        const before = await repository.readSnapshot(document.summary.id);
        await ui.evaluate(async document => {
          const result = await window.subtitleStudio.removeTask({ documentId: document.summary.id, revision: document.summary.revision, taskId: document.tasks[0].id });
          if (!result.ok) throw new Error(result.error);
        }, document);
        const retained = await repository.readSnapshot(document.summary.id);
        expect(retained.tasks).toHaveLength(0);
        expect(retained.executionRecords).toEqual(before.executionRecords);
      }

      // English, dark and 900 × 700: checking again sends nothing and still explains the blocked file.
      const sentBefore = provider.requests.length;
      await preparePage(ui, { lang: 'en', theme: 'dark' });
      await selectDocuments(documents.map(document => document.summary.id));
      // The narrow layout moves the library into a dialog, so the batch opens first.
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: en.studio.batch.translation, exact: true }).click();
      await launched.resize(900, 700);
      await ui.getByRole('combobox', { name: en.studio.translation.language, exact: true }).click();
      await ui.getByRole('option', { name: en.studio.translation.languages.zh, exact: true }).click();
      await choosePreset();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(file(2)).toHaveAttribute('data-state', 'blocked');
      await uiExpect(file(2).locator('[data-issue-code="term_conflict"]')).toContainText(en.knowledge.trial.issue.term_conflict);
      await capture('batch-english-dark-900', preview);
      await geometry(dialogFor('studio-translation-review-dialog'));
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(provider.requests).toHaveLength(sentBefore);
      expect(await readLibrary(ui)).toEqual(library);
      expect([...launched.errors, ...provider.errors]).toEqual([]);
    } catch (error) {
      await capture('failure').catch(() => undefined);
      await writeFile(path.join(artifacts, 'failure.txt'), await ui.locator('body').innerText()).catch(() => undefined);
      throw error;
    }
  }, 180000);
});
