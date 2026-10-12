import { afterAll, describe, expect, it } from 'vitest';
import { expect as uiExpect, type Locator } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import { launchStudioApp, openSubtitles, preparePage, readDocuments, seedLibrary, settled, startProvider } from './studio-e2e';

const json = async (file: string) => JSON.parse(await readFile(path.resolve(file), 'utf8'));
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('formal knowledge translation through native Electron', () => {
  let launched: Awaited<ReturnType<typeof launchStudioApp>> | undefined, provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  const artifacts = path.resolve('test-results/translation-knowledge-formal');
  afterAll(async () => {
    try { if (launched) expect(await launched.close()).toBe(true); } finally { await provider?.close(); }
  });

  it('translates with two collections and records them, with entry summaries, in a frozen execution record', async () => {
    await mkdir(artifacts, { recursive: true });
    const zh = { studio: await json('src/locales/zh/studio.json'), knowledge: await json('src/locales/zh/knowledge.json'), materials: await json('src/locales/zh/materials.json') };
    const en = { studio: await json('src/locales/en/studio.json'), materials: await json('src/locales/en/materials.json') };
    provider = await startProvider(item => `正式译文：${item.text.replace(/checkpoint/gi, '存档点').replace(/boss/gi, '首领')}`);
    const fixture = knowledgeFixture();
    const [game, common] = fixture.collections;
    const checkpoint = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'checkpoint')!;
    const boss = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'boss')!;
    const disabledRule = fixture.entries.find(entry => !entry.enabled)!;

    launched = await launchStudioApp('fusionkit-knowledge-formal-e2e-');
    const { app, ui } = launched;
    const subtitle = path.join(launched.root, 'Formal knowledge across twenty cues.lrc');
    await writeFile(subtitle, Array.from({ length: 24 }, (_, index) => {
      const number = index + 1;
      const text = number === 1 || number === 21 ? `We reached checkpoint ${number}.` : number === 2 ? 'The boss is waiting.' : `Dialogue line ${number}.`;
      return `[00:${String(number).padStart(2, '0')}]${text}`;
    }).join('\n'));
    const capture = (name: string) => ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    const dialogFor = (testId: string) => ui.locator('[role="dialog"][data-state="open"]:not([data-dialog-exiting="true"])').filter({ has: ui.getByTestId(testId) });
    const geometry = async (dialog: Locator) => {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    };
    const readRecord = (batchOffset: number) => ui.evaluate(async offset => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
      const document = list.value.documents[0];
      const page = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!page.ok) throw new Error(page.error);
      const record = await window.subtitleStudio.readExecutionRecord({ documentId: document.id, trackId: page.value.translationTracks[0].id, batchOffset: offset });
      if (!record.ok) throw new Error(record.error);
      if (record.value.state !== 'available') throw new Error(`Unexpected record state: ${record.value.state}`);
      return record.value;
    }, batchOffset);
    // Shows collections and what was included; recipes, topics and conditions are gone.
    const checkKnowledgeSection = async (knowledge: Locator, issues: Record<string, string>, collectionsLabel: string) => {
      await uiExpect(knowledge.locator('.studio-execution-facts dt')).toHaveText([collectionsLabel]);
      await uiExpect(knowledge.locator('.studio-execution-facts dd')).toHaveText(`${game.name} / ${common.name}`);
      expect(await knowledge.innerText()).not.toMatch(/方案|主题|条件|recipe|topic|condition/i);
      const issueLines = await knowledge.locator('.studio-execution-issues li > p:first-child').allInnerTexts();
      for (const line of issueLines) { expect(Object.values(issues)).toContain(line); expect(line).not.toContain('trial.issue'); }
      return issueLines;
    };

    try {
      await preparePage(ui, { lang: 'zh', port: provider.port });
      await seedLibrary(ui, fixture);
      await openSubtitles(app, ui, [subtitle], zh.studio.open_file);
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(24);
      const [original] = await readDocuments(ui);
      expect(original.translationTracks).toHaveLength(0);
      await ui.getByRole('button', { name: zh.studio.translation.action, exact: true }).click();
      const dialog = dialogFor('studio-translation-form');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(zh.studio.materials.none);
      await ui.getByTestId('studio-materials-choose').click();
      await ui.getByTestId(`studio-materials-collection-${game.id}`).check();
      await ui.getByTestId(`studio-materials-collection-${common.id}`).check();
      await ui.getByTestId('studio-materials-done').click();
      await uiExpect(ui.getByTestId('studio-materials-summary').locator('.studio-materials-chip')).toHaveCount(2);
      const requirements = 'Keep every line concise and preserve all information. Use natural dialogue.';
      await ui.getByTestId('studio-translation-instructions').fill(requirements);
      await ui.getByTestId('studio-translation-advanced').click();
      await dialog.getByRole('spinbutton', { name: zh.studio.translation.batch_cues, exact: true }).fill('20');
      await ui.getByTestId('studio-translation-advanced').click();
      await uiExpect(dialog.locator('[data-testid="studio-materials-topics"], [data-testid^="studio-materials-role-"], [data-testid^="studio-materials-confirm-"]')).toHaveCount(0);
      await capture('form-light');

      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toContainText('24');
      await uiExpect(ui.getByTestId('studio-translation-review-start')).toBeEnabled();
      expect(provider.requests).toHaveLength(0);
      await ui.getByTestId('knowledge-full-preview').scrollIntoViewIfNeeded();
      await capture('preview-light');
      await ui.getByTestId('studio-translation-review-start').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      await uiExpect(ui.locator('.studio-target-text').filter({ hasText: '正式译文：' })).toHaveCount(24);
      const [completed] = await readDocuments(ui);
      expect(completed.tasks).toHaveLength(1);
      expect(completed.translationTracks).toHaveLength(1);
      expect(Object.keys(completed.translationTracks[0].entries)).toHaveLength(24);
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests.flatMap(request => request.payload.items.map(item => item.id))).toEqual(Array.from({ length: 24 }, (_, index) => `u${index + 1}`));
      expect(provider.requests.every(request => request.payload.translationRequirements === requirements)).toBe(true);
      const sentTerms = provider.requests.flatMap(request => request.payload.translationKnowledge!.items.filter(item => item.kind === 'term').flatMap(item => item.applicableItemIds));
      expect(sentTerms.sort()).toEqual(['u1', 'u2', 'u21'].sort());
      expect(provider.requests.map(request => request.raw).join('\n')).toContain('首领');
      if (disabledRule.kind === 'rule') expect(provider.requests.map(request => request.raw).join('\n')).not.toContain(disabledRule.payload.text);
      for (const privateValue of [checkpoint.id, game.id, common.name, path.basename(subtitle)]) expect(provider.requests.map(request => request.raw).join('\n')).not.toContain(privateValue);

      // The record keeps the collection names and the entries each batch included.
      const firstRecord = await readRecord(0);
      expect(firstRecord.totalBatches).toBe(2);
      expect(firstRecord.knowledge?.collections).toEqual([game.name, common.name]);
      expect(Object.keys(firstRecord.knowledge!).sort()).toEqual(['collections', 'compiled', 'cues', 'digest', 'entries', 'generation', 'resourceCount']);
      expect(firstRecord.knowledge?.compiled.items.map(item => item.entryId)).toEqual(expect.arrayContaining([checkpoint.id, boss.id]));
      expect(firstRecord.batch.request?.httpBody).toBe(provider.requests[0].raw);
      await ui.getByTestId('studio-execution-record').click();
      const execution = dialogFor('studio-execution-record-content');
      // A paginated record keeps the previous batch for its exit; only the live stage counts.
      const knowledge = execution.locator('[data-testid="studio-execution-knowledge"]:not([data-dialog-exiting="true"] *)');
      await uiExpect(knowledge).toHaveCount(1);
      await uiExpect(execution.locator('[data-dialog-exiting="true"]')).toHaveCount(0);
      const issueLines = await checkKnowledgeSection(knowledge, zh.knowledge.trial.issue, zh.materials.selection.collections);
      expect(issueLines).toContain(zh.knowledge.trial.issue.no_match);
      const entryTrigger = knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'checkpoint → 存档点' });
      await uiExpect(entryTrigger).toContainText(zh.studio.execution.knowledge_required);
      await uiExpect(knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'boss → 首领' })).toContainText(zh.studio.execution.knowledge_reference);
      await entryTrigger.click();
      if (checkpoint.kind === 'term') await uiExpect(knowledge).toContainText(checkpoint.payload.note);
      await uiExpect(knowledge).toContainText(fill(zh.studio.execution.knowledge_scope, { count: 1, revision: 1 }));
      await uiExpect(knowledge).toContainText('We reached checkpoint 1.');
      await knowledge.scrollIntoViewIfNeeded();
      await capture('execution-knowledge-light');
      await execution.getByRole('button', { name: zh.studio.next, exact: true }).click();
      await uiExpect(execution.getByTestId('studio-execution-record-content')).toHaveAttribute('aria-busy', 'false');
      await uiExpect(execution.getByRole('heading', { name: fill(zh.studio.execution.batch, { current: 2, total: 2 }), exact: true })).toBeVisible();
      await uiExpect(execution.locator('[data-dialog-exiting="true"]')).toHaveCount(0);
      await uiExpect(knowledge).toHaveCount(1);
      await uiExpect(knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'checkpoint → 存档点' })).toBeVisible();
      await uiExpect(knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'boss → 首领' })).toHaveCount(0);
      const lastRecord = await readRecord(1);
      expect(lastRecord.knowledge?.compiled.items.filter(item => item.kind === 'term').flatMap(item => item.applicableCueIds)).toEqual([completed.cues[20].id]);
      expect(lastRecord.batch.request?.httpBody).toBe(provider.requests[1].raw);
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);

      // Cleaning up the task and deleting a used collection leave the frozen record as it was.
      await ui.evaluate(async ({ documentId, revision, taskId }) => {
        const result = await window.subtitleStudio.removeTask({ documentId, revision, taskId });
        if (!result.ok) throw new Error(result.error);
      }, { documentId: completed.summary.id, revision: completed.summary.revision, taskId: completed.tasks[0].id });
      await ui.evaluate(async id => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        const result = await window.translationKnowledge.deleteRecords({ generation: read.value.generation, items: [{ group: 'collections', id }] });
        if (!result.ok) throw new Error(result.error);
      }, game.id);
      await uiExpect(ui.getByTestId('studio-execution-record')).toBeVisible();
      expect((await readDocuments(ui))[0].tasks).toHaveLength(0);
      expect(await readRecord(1)).toEqual(lastRecord);
      expect(await readRecord(0)).toEqual(firstRecord);

      await preparePage(ui, { lang: 'en', theme: 'dark' });
      await launched.resize(900, 700); await settled(ui);
      await ui.getByTestId('studio-execution-record').click();
      await uiExpect(knowledge).toHaveCount(1);
      await checkKnowledgeSection(knowledge, (await json('src/locales/en/knowledge.json')).trial.issue, en.materials.selection.collections);
      await uiExpect(knowledge.locator('[data-slot="accordion-trigger"]').filter({ hasText: 'checkpoint → 存档点' })).toContainText(en.studio.execution.knowledge_required);
      await knowledge.scrollIntoViewIfNeeded();
      await capture('execution-knowledge-dark-english-900');
      await geometry(execution);
      await ui.keyboard.press('Escape');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect([...launched.errors, ...provider.errors]).toEqual([]);
    } catch (error) { await capture('failure').catch(() => undefined); throw error; }
  }, 180000);
});
