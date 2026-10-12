import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { buildTranscriptionUiApp } from '../subtitle-studio/helpers/transcription-ui-build';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateExecutionRecord } from '../../src/subtitle-studio/execution-record-contract';
import { knowledgeFixture } from './fixtures';
import { launchStudioApp, preparePage, readLibrary, seedLibrary, settled, startProvider } from './studio-e2e';
import type { Entry } from '../../src/translation-knowledge/schemas';

type RuntimeState = { tasks: Array<{ taskId: string; documentId?: string; status: string; automaticTranslation?: { status: string; taskId?: string } }> };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<RuntimeState> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
const json = async (file: string) => JSON.parse(await readFile(path.resolve(file), 'utf8'));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('automatic knowledge translation through native Electron', () => {
  it('freezes the chosen collections before transcription, then explains a failed check and re-checks it in the translation dialog', async () => {
    // Controlled build: the native transcription runtime is replaced; main, preload, renderer and the HTTP executor stay real.
    const fixture = await buildTranscriptionUiApp('controlled');
    const zh = { studio: await json('src/locales/zh/studio.json'), knowledge: await json('src/locales/zh/knowledge.json'), materials: await json('src/locales/zh/materials.json') };
    const en = { studio: await json('src/locales/en/studio.json'), knowledge: await json('src/locales/en/knowledge.json') };
    let launched: Awaited<ReturnType<typeof launchStudioApp>> | undefined, provider: Awaited<ReturnType<typeof startProvider>> | undefined, page: Page | undefined, passed = false;
    const evidence: Record<string, unknown> = {};
    try {
      provider = await startProvider(item => `自动译文：${item.text.replace(/checkpoint/gi, '存档点').replace(/savepoint/gi, '保存站')}`);
      const data = knowledgeFixture();
      const [game, common] = data.collections;
      const preset = data.presets[0];
      preset.context = '这些字幕讨论游戏 X 的存档位置。';
      const checkpoint = data.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'checkpoint')!;
      const savepoints: Entry[] = [[game.id, '存档柱'], [common.id, '保存站']].map(([collectionId, target], index) => ({ id: `50000000-0000-4000-8000-00000000033${index}`, revision: 1,
        collectionId, enabled: true, kind: 'term', payload: { source: 'savepoint', target, aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } } }));
      data.entries.push(...savepoints);
      launched = await launchStudioApp('fusionkit-knowledge-automatic-e2e-', { appRoot: fixture.appRoot });
      const { app, ui } = launched; page = ui; ui.setDefaultTimeout(15000);
      const repository = new DocumentRepository(path.join(launched.profile, 'subtitle-studio/documents'));
      const mediaFiles = ['01 frozen-checkpoint.wav', '02 conflicting-savepoint.wav'].map(name => path.join(launched!.root, name));
      await Promise.all(mediaFiles.map(file => writeFile(file, Buffer.alloc(44))));
      const capture = (name: string) => ui.screenshot({ path: path.join(fixture.artifacts, `${name}.png`), animations: 'disabled' });
      const fits = async (target: Locator) => {
        expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
        expect(await target.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      };
      const preferences = () => ui.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1') ?? '{}').state.transcription.autoTranslation);
      const chooseMedia = async (file: string) => {
        await uiExpect(ui.getByTestId('studio-materials-picker')).toHaveCount(0);
        await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [file]);
        await ui.getByTestId('studio-transcription-picker').getByRole('button', { name: zh.studio.transcription.choose_media, exact: true }).click();
        await uiExpect(ui.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      };

      await preparePage(ui, { lang: 'zh', port: provider.port });
      const seeded = await seedLibrary(ui, data);
      await ui.getByTestId('subtitle-studio').waitFor();
      await ui.getByRole('tab', { name: zh.studio.workspace_transcription, exact: true }).click();
      await ui.getByTestId('studio-transcription').waitFor(); await control(app, { operation: 'resources-ready' });
      await ui.getByTestId('studio-transcription-manage-resources').click();
      await ui.getByRole('dialog').getByRole('button', { name: zh.studio.transcription.check_again, exact: true }).click();
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await ui.locator('#studio-transcription-auto-translation').click();
      const materials = ui.getByTestId('studio-automatic-materials');
      await materials.getByTestId('studio-materials-choose').click();
      await ui.getByTestId('studio-materials-tabs').getByRole('tab').nth(1).click();
      await ui.getByTestId(`studio-materials-preset-${preset.id}`).click();
      await ui.getByTestId('studio-materials-done').click();
      await uiExpect(materials.getByTestId('studio-materials-source')).toHaveText(zh.knowledge.languages.en);
      await uiExpect(materials.locator('.studio-materials-chip')).toHaveCount(2);
      await uiExpect(ui.getByTestId('studio-automatic-instructions')).toHaveValue(preset.instructions);
      await uiExpect.poll(async () => (await preferences()).knowledge).toEqual({ enabled: true, sourceLanguage: 'en', collectionIds: preset.collectionIds, disabledEntryIds: [], instructions: preset.instructions, context: preset.context });
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await materials.scrollIntoViewIfNeeded();
      await capture('automatic-knowledge-selection-light');

      await chooseMedia(mediaFiles[0]);
      await ui.getByTestId('studio-transcription-start').click();
      await uiExpect.poll(async () => (await control(app, { operation: 'snapshot' })).tasks.length).toBe(1);
      const firstNative = (await control(app, { operation: 'snapshot' })).tasks[0];
      // The library changes after admission; the frozen copy taken before transcription is what translates.
      const edited = await ui.evaluate(async id => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        const term = read.value.data.entries.find(entry => entry.id === id)!;
        if (term.kind !== 'term') throw new Error('Missing term');
        const saved = await window.translationKnowledge.saveRecords({ generation: read.value.generation, items: [{ group: 'entries', record: { ...term, payload: { ...term.payload, target: '后来修改的检查站' } } }] });
        if (!saved.ok) throw new Error(JSON.stringify(saved)); return saved.value;
      }, checkpoint.id);
      expect(edited.generation).toBeGreaterThan(seeded.generation);
      expect(provider.requests).toHaveLength(0);
      await control(app, { operation: 'complete', taskId: firstNative.taskId, texts: ['We reached the checkpoint.', 'Wait here until the next scene.'] });
      await uiExpect.poll(() => provider!.requests.length).toBe(1);
      const firstDocumentId = (await control(app, { operation: 'snapshot' })).tasks[0].documentId!;
      await uiExpect.poll(async () => (await repository.readSnapshot(firstDocumentId)).tasks[0]?.status).toBe('completed');
      const first = await repository.readSnapshot(firstDocumentId), track = first.document.translationTracks[0];
      const execution = validateExecutionRecord(first.executionRecords![track.executionRef!.id]);
      expect(execution.knowledge!.generation).toBe(seeded.generation);
      expect(execution.knowledge!.selection).toMatchObject({ version: 2, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: preset.collectionIds, disabledEntryIds: [] });
      expect(execution.knowledge!.data.collections.map(item => item.id)).toEqual(preset.collectionIds);
      const frozenTerm = execution.knowledge!.data.entries.find(entry => entry.id === checkpoint.id)!;
      expect(frozenTerm.kind === 'term' && frozenTerm.payload.target).toBe('存档点');
      expect(provider.requests[0].raw).toContain('存档点'); expect(provider.requests[0].raw).not.toContain('后来修改的检查站');
      expect(provider.requests[0].payload.translationRequirements).toBe(preset.instructions);
      expect(provider.requests[0].payload.translationKnowledge?.items.some(item => item.kind === 'term' && item.applicableItemIds.includes('u1'))).toBe(true);
      expect(Object.values(execution.requests).map(request => request.httpBody)).toContain(provider.requests[0].raw);
      expect(JSON.stringify(first)).not.toContain('synthetic-knowledge-key');
      evidence.frozen = { documentId: firstDocumentId, generation: execution.knowledge!.generation, liveGeneration: edited.generation };

      // The next submission refreshes the common selection explicitly; its check then fails on a conflict.
      await materials.getByTestId('studio-materials-choose').click();
      await ui.getByTestId('studio-materials-picker').getByRole('button', { name: zh.studio.refresh, exact: true }).click();
      await uiExpect(ui.getByTestId('studio-automatic-knowledge-notice')).toHaveCount(0);
      await ui.getByTestId('studio-materials-done').click();
      await chooseMedia(mediaFiles[1]);
      await ui.getByTestId('studio-transcription-start').click();
      await uiExpect.poll(async () => (await control(app, { operation: 'snapshot' })).tasks.length).toBe(2);
      const secondNative = (await control(app, { operation: 'snapshot' })).tasks[1];
      await control(app, { operation: 'complete', taskId: secondNative.taskId, texts: ['We reached the savepoint.'] });
      await uiExpect.poll(async () => (await control(app, { operation: 'snapshot' })).tasks[1].automaticTranslation?.status).toBe('needs_configuration');
      const secondState = (await control(app, { operation: 'snapshot' })).tasks[1];
      const blocked = await repository.readSnapshot(secondState.documentId!);
      expect(blocked.tasks[0]).toMatchObject({ status: 'failed', attempts: 0, translation: { error: 'knowledge_check_failed' } });
      expect(blocked.document.translationTracks[0].entries).toEqual({});
      expect(provider.requests).toHaveLength(1);
      const failedTrackId = blocked.document.translationTracks[0].id;
      const report = await ui.evaluate(async request => {
        const result = await window.subtitleStudio.readAutomaticKnowledgeReport(request); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
      }, { documentId: secondState.documentId!, trackId: failedTrackId });
      if (report.state !== 'available') throw new Error(`Expected an available automatic failure report, got ${report.state}`);
      expect(report.material).toMatchObject({ collectionCount: 2, collections: [game.name, common.name] });
      expect(report.issues.find(issue => issue.code === 'term_conflict')).toMatchObject({ severity: 'error', entryCount: 2, cueCount: 1, cues: [{ cueId: blocked.document.cues[0].id, number: 1, text: 'We reached the savepoint.' }] });
      expect(report.seed).toMatchObject({ documentId: secondState.documentId, trackId: failedTrackId, selection: { version: 2, collectionIds: preset.collectionIds, disabledEntryIds: [] } });
      expect(Object.keys(report.seed!.selection).sort()).toEqual(['collectionIds', 'context', 'disabledEntryIds', 'instructions', 'languagePair', 'version']);
      evidence.report = report;

      const blockedRow = ui.getByTestId('studio-transcription-task-row').filter({ hasText: path.basename(mediaFiles[1]) });
      await uiExpect(blockedRow.locator('.studio-transcription-auto-label')).toHaveAttribute('data-state', 'needs_configuration');
      await uiExpect(blockedRow).toContainText(zh.studio.transcription.auto_translation_recovery_short);
      await blockedRow.getByRole('button', { name: zh.studio.transcription.open_document, exact: true }).click();
      await uiExpect(ui.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', 'documents');
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed');

      // The report names the reason, the collections and each issue in the locale's words.
      await ui.getByTestId('studio-automatic-knowledge-report').click();
      const reportDialog = ui.getByRole('dialog').filter({ has: ui.getByTestId('automatic-knowledge-report-content') });
      await uiExpect(ui.getByTestId('automatic-knowledge-report-content')).toHaveAttribute('data-state', 'available');
      await uiExpect(ui.getByTestId('automatic-knowledge-report-reason')).toHaveText(zh.studio.errors.knowledge_check_failed);
      await uiExpect(reportDialog).toContainText(zh.knowledge.recovery.materials.replace('{{collections}}', '2'));
      await uiExpect(reportDialog).toContainText(`${game.name} / ${common.name}`);
      const issue = ui.locator('[data-testid="automatic-knowledge-report-issue"][data-issue-code="term_conflict"]');
      await uiExpect(issue).toContainText(zh.knowledge.trial.issue.term_conflict);
      await uiExpect(issue).toContainText('We reached the savepoint.');
      for (const row of await ui.getByTestId('automatic-knowledge-report-issue').all()) {
        const code = (await row.getAttribute('data-issue-code'))!;
        await uiExpect(row).toContainText(zh.knowledge.trial.issue[code]);
      }
      expect(await reportDialog.innerText()).not.toMatch(/方案|主题|条件/);
      await fits(reportDialog);
      await capture('automatic-knowledge-report-light');

      // Re-check carries the direction and collections into the translation dialog; nothing is sent until started.
      await ui.getByTestId('automatic-knowledge-report-recheck').click();
      const repairDialog = ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
      await uiExpect(repairDialog.getByRole('heading', { name: zh.studio.translation.title, exact: true })).toBeVisible();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await uiExpect(repairDialog.getByTestId('studio-materials-source')).toHaveText(zh.knowledge.languages.en);
      await uiExpect(repairDialog.getByTestId('studio-translation-language')).toHaveText(zh.studio.translation.languages.zh);
      for (const collection of [game, common]) await uiExpect(repairDialog.locator('.studio-materials-chip').filter({ hasText: collection.name })).toHaveCount(1);
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(preset.instructions);
      await repairDialog.getByTestId('studio-materials-more').locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(repairDialog.getByTestId('studio-materials-context')).toHaveValue(preset.context);
      await ui.getByTestId('studio-translation-check').click();
      const preview = ui.getByTestId('knowledge-full-preview');
      await uiExpect(preview.locator('[data-issue-code="term_conflict"]')).toContainText(zh.knowledge.trial.issue.term_conflict);
      await uiExpect(ui.getByTestId('studio-translation-review-start')).toBeDisabled();
      expect(provider.requests).toHaveLength(1); expect(await repository.readSnapshot(secondState.documentId!)).toEqual(blocked);
      await ui.getByTestId('studio-translation-review-close').click();
      await repairDialog.getByTestId('studio-materials-exclusions').locator('[data-slot=accordion-trigger]').first().click();
      await repairDialog.getByTestId(`studio-materials-exclude-${savepoints[0].id}`).check();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(preview).toBeVisible();
      await uiExpect(preview.locator('[data-issue-code="term_conflict"]')).toHaveCount(0);
      await capture('automatic-knowledge-repair-checked-light');
      await ui.getByTestId('studio-translation-review-start').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
      await uiExpect.poll(async () => (await repository.readSnapshot(secondState.documentId!)).tasks.at(-1)?.status).toBe('completed');
      expect(provider.requests).toHaveLength(2);
      const repaired = await repository.readSnapshot(secondState.documentId!), repairedTrack = repaired.document.translationTracks.at(-1)!;
      expect(repaired.document.translationTracks).toHaveLength(2); expect(repaired.tasks[0]).toEqual(blocked.tasks[0]);
      const repairedExecution = validateExecutionRecord(repaired.executionRecords![repairedTrack.executionRef!.id]);
      expect(repairedExecution.knowledge?.selection).toMatchObject({ ...report.seed!.selection, disabledEntryIds: [savepoints[0].id] });
      expect(Object.values(repairedTrack.entries)[0].text.plain).toContain('保存站');
      const after = await ui.evaluate(async request => {
        const result = await window.subtitleStudio.readAutomaticKnowledgeReport(request); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
      }, { documentId: secondState.documentId!, trackId: failedTrackId });
      expect(after).toEqual(report);

      // English, dark and 900 × 700: the kept report can still be re-checked.
      await preparePage(ui, { lang: 'en', theme: 'dark', hash: '/tools/subtitle/studio' });
      await ui.getByTestId('subtitle-studio').waitFor();
      await ui.locator(`[data-testid="studio-library-row"][data-document-id="${secondState.documentId}"] .studio-document`).click();
      await ui.getByRole('combobox', { name: en.studio.translation_track, exact: true }).click();
      await ui.getByRole('option', { name: `${blocked.document.translationTracks[0].language} · 1`, exact: true }).click();
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed');
      await launched.resize(900, 700); await settled(ui);
      await ui.getByTestId('studio-automatic-knowledge-report').click();
      const retained = ui.getByRole('dialog').filter({ has: ui.getByTestId('automatic-knowledge-report-content') });
      await uiExpect(ui.getByTestId('automatic-knowledge-report-content')).toHaveAttribute('data-state', 'available');
      await uiExpect(ui.locator('[data-testid="automatic-knowledge-report-issue"][data-issue-code="term_conflict"]')).toContainText(en.knowledge.trial.issue.term_conflict);
      await fits(retained);
      await capture('automatic-knowledge-report-dark-english-900');
      await ui.getByTestId('automatic-knowledge-report-recheck').click();
      const retainedRepair = ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
      await uiExpect(retainedRepair.getByRole('heading', { name: en.studio.translation.title, exact: true })).toBeVisible();
      await uiExpect(retainedRepair.locator('.studio-materials-chip')).toHaveCount(2);
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeEnabled();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toHaveCount(0);
      await fits(retainedRepair);
      await capture('automatic-knowledge-repair-form-dark-english-900');
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(provider.requests).toHaveLength(2);
      expect((await readLibrary(ui)).generation).toBe(edited.generation);
      expect([...launched.errors, ...provider.errors]).toEqual([]); passed = true;
    } finally {
      if (!passed && page) await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-failure.png'), animations: 'disabled' }).catch(() => undefined);
      await writeFile(path.join(fixture.artifacts, 'automatic-knowledge-evidence.json'), JSON.stringify({ passed, ...evidence, requests: provider?.requests ?? [], errors: launched?.errors ?? [] }, null, 2));
      try { if (launched) expect(await launched.close()).toBe(true); }
      finally { await provider?.close(); await fixture.cleanup(); }
    }
  }, 180000);
});
