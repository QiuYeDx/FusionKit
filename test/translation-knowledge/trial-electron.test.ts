import { afterAll, describe, expect, it } from 'vitest';
import { expect as uiExpect, type Locator } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import { launchStudioApp, openSubtitles, preparePage, readDocuments, readLibrary, seedLibrary, settled, startProvider } from './studio-e2e';
import type { Entry } from '../../src/translation-knowledge/schemas';

const json = async (file: string) => JSON.parse(await readFile(path.resolve(file), 'utf8'));
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('knowledge trial through native Electron', () => {
  let launched: Awaited<ReturnType<typeof launchStudioApp>> | undefined, provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  let release: (() => void) | undefined;
  const artifacts = path.resolve('test-results/translation-knowledge-trial');
  afterAll(async () => {
    release?.();
    try { if (launched) expect(await launched.close()).toBe(true); } finally { await provider?.close(); }
  });

  it('shows only participating materials and issues, sends the selected collections, and leaves documents and library untouched', async () => {
    await mkdir(artifacts, { recursive: true });
    const zh = { studio: await json('src/locales/zh/studio.json'), knowledge: await json('src/locales/zh/knowledge.json') };
    const en = { studio: await json('src/locales/en/studio.json'), knowledge: await json('src/locales/en/knowledge.json') };
    let mode: 'success' | 'malformed' | 'hold' = 'success';
    // The checkpoint line deliberately omits the required target so the result reports a suspect term.
    provider = await startProvider(item => mode === 'malformed' ? undefined : item.id === 'u1' ? '我们到了。' : '首领在等着。',
      () => mode === 'hold' ? new Promise<void>(resolve => { release = resolve; }) : undefined);
    const fixture = knowledgeFixture();
    const [game, common] = fixture.collections;
    const checkpoint = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'checkpoint')!;
    const boss = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'boss')!;
    const background = fixture.entries.find(entry => entry.kind === 'context')!;
    // Another selected collection fixes a different required translation for the same word.
    const conflicting: Entry = { id: '50000000-0000-4000-8000-000000000311', revision: 1, collectionId: common.id, enabled: true, kind: 'term',
      payload: { source: 'checkpoint', target: '检查点', aliases: [], note: '', strength: 'required', match: { mode: 'whole_term', caseSensitive: false } } };
    fixture.entries.push(conflicting);

    launched = await launchStudioApp('fusionkit-knowledge-trial-e2e-');
    const { app, ui } = launched;
    const subtitle = path.join(launched.root, 'trial.lrc');
    await writeFile(subtitle, '[00:01]We reached the checkpoint.\n[00:03]The boss is waiting.');
    const form = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
    const reviewDialog = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-review-dialog') });
    const preview = ui.getByTestId('knowledge-trial-preview'), result = ui.getByTestId('knowledge-trial-result');
    const capture = (name: string) => ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    // Every issue line is the locale's text for its code, never a raw key or the unknown-code fallback.
    const issueTexts = async (scope: Locator, issues: Record<string, string>) => {
      const rows = await scope.locator('[data-issue-code]').evaluateAll(nodes => nodes.map(node => ({ code: node.getAttribute('data-issue-code')!, text: node.textContent ?? '' })));
      for (const row of rows) {
        expect(issues[row.code], `Locale text for ${row.code}`).toBeTruthy();
        expect(row.text).toContain(issues[row.code]);
        expect(row.text).not.toContain('trial.issue');
      }
      return rows.map(row => row.code);
    };
    const openIssueGroups = async (scope: Locator) => {
      for (const id of ['studio-materials-issues-errors', 'studio-materials-issues-excluded']) {
        const trigger = scope.getByTestId(id).locator('[data-slot=accordion-trigger]').first();
        if (await trigger.count() && await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      }
    };
    const selectMaterials = async () => {
      if (!(await ui.getByTestId('studio-translation-form').count())) await ui.getByRole('button', { name: /^(翻译|Translate)$/ }).click();
      await ui.getByTestId('studio-materials-choose').click();
      for (const id of [game.id, common.id]) {
        const box = ui.getByTestId(`studio-materials-collection-${id}`);
        if (!(await box.isChecked())) await box.check();
      }
      await ui.getByTestId('studio-materials-done').click();
      await uiExpect(ui.getByTestId('studio-materials-picker')).toHaveCount(0);
    };
    const checkTrial = async () => {
      if (await ui.getByTestId('studio-translation-review-dialog').count()) {
        await ui.getByTestId('studio-translation-review-close').click();
        await uiExpect(ui.getByTestId('studio-translation-review-dialog')).toHaveCount(0);
      }
      const trigger = ui.getByTestId('knowledge-trial-scopes').locator('[data-slot=accordion-trigger]').first();
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      await ui.getByTestId('studio-translation-check-trial').click();
    };

    try {
      await preparePage(ui, { lang: 'zh', port: provider.port });
      await seedLibrary(ui, fixture);
      const knowledgeBefore = await readLibrary(ui);
      await openSubtitles(app, ui, [subtitle], zh.studio.open_file);
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(2);
      const [docBefore] = await readDocuments(ui);
      await selectMaterials();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await ui.getByTestId('studio-translation-instructions').fill('Keep the dialogue concise.');

      // The sample panel only picks lines: no topic, speaker, mention or condition controls remain.
      const scopes = ui.getByTestId('knowledge-trial-scopes');
      await scopes.locator('[data-slot=accordion-trigger]').first().click();
      for (const cue of docBefore.cues) await uiExpect(ui.getByTestId(`studio-materials-cue-${cue.id}`)).toBeVisible();
      await uiExpect(scopes.getByRole('checkbox')).toHaveCount(docBefore.cues.length);
      await uiExpect(scopes.locator('[data-slot=select-trigger], [role=combobox]')).toHaveCount(0);
      await uiExpect(form().locator('[data-testid^="studio-materials-role-"], [data-testid^="studio-materials-confirm-"], [data-testid="studio-materials-topics"]')).toHaveCount(0);
      await uiExpect(form().getByRole('combobox')).toHaveCount(3); // model, target and source language only
      await scopes.scrollIntoViewIfNeeded();
      await capture('scope-light');

      // Checking a sample never calls the model. A required conflict blocks the trial.
      await checkTrial();
      await uiExpect(preview).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-review-start')).toBeDisabled();
      await openIssueGroups(preview);
      const blocked = await issueTexts(preview, zh.knowledge.trial.issue);
      expect(blocked).toEqual(expect.arrayContaining(['term_conflict', 'no_match']));
      await uiExpect(preview.getByTestId('studio-materials-issues-errors').locator('[data-issue-code="term_conflict"]')).toContainText('checkpoint → 检查点');
      await uiExpect(reviewDialog().locator('[data-slot=select-trigger], [role=switch]')).toHaveCount(0);
      expect(provider.requests).toHaveLength(0);
      await capture('preview-conflict-light');

      // Excluding one side resolves it; the panel lists what participates and why others are left out.
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId('studio-materials-more').locator('[data-slot=accordion-trigger]').first().click();
      await ui.getByTestId('studio-materials-exclusions').locator('[data-slot=accordion-trigger]').first().click();
      await ui.getByTestId(`studio-materials-exclude-${conflicting.id}`).check();
      await checkTrial();
      await uiExpect(preview).toBeVisible();
      await uiExpect(ui.getByTestId('studio-translation-review-start')).toBeEnabled();
      await uiExpect(preview.getByTestId('studio-materials-issues-errors')).toHaveCount(0);
      await openIssueGroups(preview);
      const codes = await issueTexts(preview, zh.knowledge.trial.issue);
      expect(codes).toEqual(expect.arrayContaining(['disabled', 'no_match']));
      expect(codes).not.toContain('term_conflict');
      const included = preview.getByTestId('studio-materials-included');
      await included.locator('[data-slot=accordion-trigger]').first().click();
      for (const entry of [checkpoint, boss]) if (entry.kind === 'term') await uiExpect(included).toContainText(`${entry.payload.source} → ${entry.payload.target}`);
      if (background.kind === 'context') await uiExpect(included).toContainText(background.payload.text);
      await uiExpect(included).not.toContainText('检查点');
      expect(provider.requests).toHaveLength(0);
      await preview.scrollIntoViewIfNeeded();
      await capture('preview-light');

      await ui.getByTestId('studio-translation-review-start').click();
      await uiExpect(result).toContainText('我们到了。');
      await uiExpect(result).toContainText(fill(zh.knowledge.trial.usage, { requests: 1, input: 120, output: 40 }));
      expect(provider.requests).toHaveLength(1);
      // The returned line lacks the required target, which the result explains with its own issue text.
      await uiExpect(result.locator('[data-issue-code="required_term_suspect"]').first()).toBeAttached();
      await openIssueGroups(result);
      expect(await issueTexts(result, zh.knowledge.trial.issue)).toContain('required_term_suspect');
      const payload = provider.requests[0].payload;
      expect(payload.translationRequirements).toBe('Keep the dialogue concise.');
      const sent = payload.translationKnowledge!.items as Array<Record<string, unknown> & { kind: string; applicableItemIds: string[] }>;
      expect(sent.filter(item => item.kind === 'term').map(item => item.applicableItemIds)).toEqual(expect.arrayContaining([['u1'], ['u2']]));
      for (const item of sent) for (const key of ['condition', 'title', 'evidence', 'scope', 'origin']) expect(item).not.toHaveProperty(key);
      expect(provider.requests[0].raw).not.toContain('检查点');
      for (const privateValue of [checkpoint.id, game.id, common.name, '用户约定', 'trial.lrc']) expect(provider.requests[0].raw).not.toContain(privateValue);
      await result.scrollIntoViewIfNeeded();
      await capture('result-light');

      // Reopening shows the stored result; only the explicit rerun asks the model again.
      await ui.getByTestId('studio-translation-review-close').click();
      await uiExpect(ui.getByTestId('studio-translation-review-dialog')).toHaveCount(0);
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect(result).toContainText('我们到了。');
      expect(provider.requests).toHaveLength(1);
      mode = 'malformed';
      await ui.getByTestId('studio-translation-review-rerun-trial').click();
      await uiExpect(result).toContainText(zh.knowledge.trial.partial_result);
      await uiExpect(result).not.toContainText('我们到了。');
      mode = 'hold';
      await checkTrial();
      await ui.getByTestId('studio-translation-review-start').click();
      await uiExpect.poll(() => provider!.requests.length).toBe(3);
      await ui.getByTestId('studio-translation-review-cancel-trial').click();
      await uiExpect(result).toContainText(zh.knowledge.trial.partial_result);
      release?.(); mode = 'success';
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);

      // A trial never writes the document or the library.
      const [docAfter] = await readDocuments(ui);
      expect(docAfter).toEqual(docBefore);
      expect(await readLibrary(ui)).toEqual(knowledgeBefore);

      await preparePage(ui, { lang: 'en', theme: 'dark' });
      await launched.resize(900, 700); await settled(ui);
      await ui.getByRole('button', { name: en.studio.translation.action, exact: true }).click();
      await ui.getByRole('combobox', { name: en.studio.translation.language, exact: true }).click();
      await ui.getByRole('option', { name: en.studio.translation.languages.zh, exact: true }).click();
      await selectMaterials();
      await checkTrial();
      await uiExpect(preview).toBeVisible();
      await openIssueGroups(preview);
      expect(await issueTexts(preview, en.knowledge.trial.issue)).toEqual(expect.arrayContaining(['term_conflict', 'no_match']));
      expect(await reviewDialog().locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await reviewDialog().evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
      await capture('preview-english-dark-900');
      expect(provider.requests).toHaveLength(3);
      expect([...launched.errors, ...provider.errors]).toEqual([]);
    } catch (error) { await capture('failure').catch(() => {}); throw error; }
  }, 120000);
});
