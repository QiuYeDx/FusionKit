import { afterAll, describe, expect, it } from 'vitest';
import { expect as uiExpect, type Locator } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import { launchStudioApp, openSubtitles, preparePage, readDocuments, readLibrary, seedLibrary, settled, startProvider } from './studio-e2e';
import type { Collection, Entry, Preset } from '../../src/translation-knowledge/schemas';

const json = async (file: string) => JSON.parse(await readFile(path.resolve(file), 'utf8'));
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('materials picker, presets and layout through native Electron', () => {
  let launched: Awaited<ReturnType<typeof launchStudioApp>> | undefined, provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  const artifacts = path.resolve('test-results/translation-knowledge-materials-layout');
  afterAll(async () => {
    try {
      if (launched) {
        expect(path.dirname(launched.root)).toBe(path.resolve(tmpdir()));
        expect(path.basename(launched.root)).toMatch(/^fusionkit-materials-layout-/);
        expect(await launched.close()).toBe(true);
      }
    } finally { await provider?.close(); }
  });

  it('picks collections, saves, applies, renames and deletes presets, recovers removed sets, and stays inside the window', async () => {
    await mkdir(artifacts, { recursive: true });
    const zh = { studio: await json('src/locales/zh/studio.json'), materials: await json('src/locales/zh/materials.json'), knowledge: await json('src/locales/zh/knowledge.json') };
    const en = { studio: await json('src/locales/en/studio.json'), materials: await json('src/locales/en/materials.json') };
    provider = await startProvider(item => `试译：${item.text}`);
    const fixture = knowledgeFixture();
    const [game, common, archived] = fixture.collections;
    game.name = '游戏 X · 系列视频翻译资料与人物固定译法 · Game X terminology and dialogue references for every episode';
    const removable: Collection = { ...common, id: '30000000-0000-4000-8000-000000000301', name: '稍后删除的资料集' };
    const otherDirection: Collection = { ...common, id: '30000000-0000-4000-8000-000000000302', name: '日语方向资料集', languagePair: { source: 'ja', target: 'zh-Hans' } };
    // Enough actual library rows to overflow the portalled picker at both sizes.
    const filler: Collection[] = Array.from({ length: 18 }, (_, index) => ({ ...common, id: `30000000-0000-4000-8000-${String(index + 400).padStart(12, '0')}`,
      name: `${index < 6 ? '六条样本 · ' : ''}滚轮验证资料集 ${index + 1}${index === 17 ? ' · 用较长的末条名称检查自然换行后，名称和语言说明仍能完整显示' : ''}` }));
    fixture.collections.push(removable, otherDirection, ...filler);
    const relay: Entry = { id: '50000000-0000-4000-8000-000000000301', revision: 1, collectionId: removable.id, enabled: true, kind: 'term',
      payload: { source: 'relay', target: '中继站', aliases: [], note: '', strength: 'preferred', match: { mode: 'whole_term', caseSensitive: false } } };
    fixture.entries.push(relay);
    const livePreset = fixture.presets[0];
    livePreset.context = '实况解说的背景：玩家正在推进北境远征。';
    // An archived collection stays in the library, so a preset may still name it.
    const archivedPreset: Preset = { ...livePreset, id: '60000000-0000-4000-8000-000000000301', name: '含归档资料集的预设', collectionIds: [game.id, archived.id], instructions: '', context: '' };
    fixture.presets.push(archivedPreset);

    launched = await launchStudioApp('fusionkit-materials-layout-');
    const { app, ui } = launched;
    const subtitleFiles = ['First episode with a fairly long file name for the materials picker.lrc', 'Second episode reuses the same materials.lrc'].map(name => path.join(launched!.root, name));
    const lines = ['We reached the checkpoint.', 'The boss is waiting at the relay.', 'Ready when you are.'];
    for (const file of subtitleFiles) await writeFile(file, lines.map((text, index) => `[00:${String(index * 2 + 1).padStart(2, '0')}]${text}`).join('\n'));
    const form = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
    const review = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-review-dialog') });
    const picker = ui.getByTestId('studio-materials-picker');
    const collection = (id: string) => ui.getByTestId(`studio-materials-collection-${id}`);
    const chips = () => ui.getByTestId('studio-materials-summary').locator('.studio-materials-chip');
    const geometry = async (target: Locator) => {
      expect(await target.evaluate(element => {
        const r = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
      })).toBe(true);
      expect(await target.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    };
    const visualMeasurements: Array<{ name: string; metrics: unknown }> = [];
    const waitForGeometry = (target: Locator) => target.evaluate(element => new Promise<void>((resolve, reject) => {
      let previous: number[] = [], stable = 0;
      const started = performance.now();
      const sample = () => {
        const nodes = [element, element.closest('[role=dialog]')].filter((node): node is Element => !!node);
        const current = nodes.flatMap(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height, node.scrollHeight]; });
        const moving = [...element.querySelectorAll('[data-flow-animating="true"]')].some(node => node.getClientRects().length > 0);
        stable = !moving && previous.length === current.length && current.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 0;
        previous = current;
        if (stable >= 4) resolve();
        else if (performance.now() - started > 5000) reject(new Error('Geometry did not settle before visual capture'));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    const capture = async (name: string, target: Locator) => {
      await settled(ui); await target.scrollIntoViewIfNeeded(); await waitForGeometry(target);
      await geometry(target);
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const wheelPicker = async (name: string) => {
      const body = picker.locator('.studio-materials-picker-body');
      await waitForGeometry(picker);
      expect(await body.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
      const background = () => ui.getByTestId('studio-translation-form').evaluate(node => [...node.closest('[role="dialog"]')!.querySelectorAll('[data-slot="scroll-area-viewport"]')].map(viewport => viewport.scrollTop));
      const before = await background();
      expect(before.length).toBeGreaterThan(0);
      const box = (await body.boundingBox())!;
      await ui.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // Real wheel input: assigning scrollTop cannot detect a modal scroll lock.
      await ui.mouse.wheel(0, 280);
      await uiExpect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(30);
      await capture(`${name}-wheel-down`, picker);
      await ui.mouse.wheel(0, 10000);
      await uiExpect.poll(() => body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      const end = await picker.locator('.studio-materials-collection-row').last().evaluate(row => {
        const box = row.getBoundingClientRect();
        const clips = [];
        for (let parent = row.parentElement; parent; parent = parent.parentElement) {
          if (!['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowY)) continue;
          const bounds = parent.getBoundingClientRect();
          clips.push({ className: parent.className, top: bounds.top, bottom: bounds.top + parent.clientTop + parent.clientHeight });
        }
        return { top: box.top, bottom: box.bottom, clips, overflow: row.scrollWidth > row.clientWidth + 1 };
      });
      visualMeasurements.push({ name: `${name}-last-row`, metrics: end });
      await capture(`${name}-wheel-bottom`, picker);
      expect(end.overflow).toBe(false);
      for (const clip of end.clips) {
        expect(end.top, `Last row above ${clip.className}`).toBeGreaterThanOrEqual(clip.top - 1);
        expect(end.bottom, `Last row clipped by ${clip.className}`).toBeLessThanOrEqual(clip.bottom + 1);
      }
      const bottomGap = await body.evaluate((node, rowBottom) => node.getBoundingClientRect().bottom - rowBottom, end.bottom);
      expect(bottomGap).toBeGreaterThanOrEqual(11);
      expect(bottomGap).toBeLessThanOrEqual(14);
      const footer = picker.locator('.studio-materials-picker-footer');
      const buttonSizes = await footer.locator('[data-slot="button"]').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, font: getComputedStyle(node).fontSize })));
      visualMeasurements.push({ name: `${name}-footer`, metrics: { height: (await footer.boundingBox())!.height, buttonSizes } });
      expect(buttonSizes.length).toBeGreaterThanOrEqual(3);
      for (const size of buttonSizes) { expect(size.height).toBe(28); expect(size.font).toBe('12px'); }
      await ui.mouse.wheel(0, 300);
      await ui.mouse.wheel(0, -10000);
      await uiExpect.poll(() => body.evaluate(node => node.scrollTop)).toBeLessThan(2);
      await ui.mouse.wheel(0, -300);
      expect(await background()).toEqual(before);
      await uiExpect(ui.getByTestId('studio-materials-done')).toBeVisible();
    };
    const showLibrary = async () => {
      // Compact Studio renders its document list in the library dialog.
      await uiExpect(ui.getByTestId('subtitle-studio')).toBeVisible();
      const trigger = ui.locator('#studio-library-trigger');
      if (await trigger.isVisible() && !(await ui.locator('.studio-library-dialog').isVisible())) await trigger.click();
    };
    const openDocument = async (id: string) => {
      await showLibrary();
      await ui.locator(`[data-testid="studio-library-row"][data-document-id="${id}"] .studio-document`).click();
      await uiExpect(ui.locator('.studio-library-dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    };
    const openTranslation = async (label: string) => {
      await ui.getByRole('button', { name: label, exact: true }).click();
      await uiExpect(form()).toBeVisible();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
    };
    const openPicker = async () => {
      await ui.getByTestId('studio-materials-choose').click();
      await uiExpect(picker).toBeVisible();
    };
    const done = async () => { await ui.getByTestId('studio-materials-done').click(); await uiExpect(picker).toHaveCount(0); };
    // Presets and recent sets live on the second tab; applying one returns to the collections tab.
    const showTab = async (index: 0 | 1) => { await picker.getByTestId('studio-materials-tabs').getByRole('tab').nth(index).click(); };
    const presetMenu = async (id: string, item: 'rename' | 'delete') => {
      await ui.getByTestId(`studio-materials-preset-more-${id}`).click();
      await ui.getByTestId(`studio-materials-preset-${item}`).click();
    };
    const closeTranslation = async () => {
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
    };
    const preferences = () => ui.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1') ?? '{}').state);
    const presetNamed = async (name: string) => (await readLibrary(ui)).data.presets.find(preset => preset.name === name);

    try {
      await preparePage(ui, { lang: 'zh', port: provider.port });
      await openSubtitles(app, ui, subtitleFiles, zh.studio.open_file);
      const documents = await readDocuments(ui);
      const [first, second] = subtitleFiles.map(file => documents.find(document => document.summary.origin.displayName === path.basename(file))!);

      // An empty library gives a way to the translation materials page, not an empty list.
      await openDocument(first.summary.id);
      await openTranslation(zh.studio.translation.action);
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(zh.studio.materials.none);
      await openPicker();
      await uiExpect(picker).toContainText(zh.materials.selection.empty_library);
      await uiExpect(picker).toContainText(zh.materials.selection.empty_library_help);
      await uiExpect(picker.locator('[data-testid^="studio-materials-collection-"]')).toHaveCount(0);
      await uiExpect(picker.getByRole('checkbox')).toHaveCount(0);
      await showTab(1);
      await uiExpect(picker).toContainText(zh.materials.selection.presets_empty_help);
      await uiExpect(ui.getByTestId('studio-materials-save-preset')).toBeDisabled();
      await showTab(0);
      const manage = picker.getByRole('link', { name: zh.materials.selection.manage });
      await uiExpect(manage).toBeVisible();
      await capture('picker-empty-library-zh-light', picker);
      await manage.click();
      await uiExpect(ui).toHaveURL(/#\/tools\/translation-knowledge$/);
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);

      await seedLibrary(ui, fixture);
      await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await openDocument(first.summary.id);
      await openTranslation(zh.studio.translation.action);
      await openPicker();
      // Archived collections are hidden. Until a source language is settled every target-matching collection is open.
      await uiExpect(collection(archived.id)).toHaveCount(0);
      await uiExpect(collection(otherDirection.id)).toBeEnabled();
      await uiExpect(picker.locator('.studio-materials-collection-row')).toHaveCount(fixture.collections.length - 1);
      await wheelPicker('picker-zh-light-1280');
      await ui.getByTestId('studio-materials-search').fill('六条样本');
      await uiExpect(picker.locator('.studio-materials-collection-row')).toHaveCount(6);
      await ui.getByTestId('studio-materials-search').fill('There is no collection with this title');
      await uiExpect(ui.getByTestId('studio-materials-search-empty')).toBeVisible();
      await uiExpect(picker.locator('[data-testid^="studio-materials-collection-"]')).toHaveCount(0);
      await capture('picker-search-empty-zh-light-1280', picker);
      await ui.getByTestId('studio-materials-search-empty').getByRole('button').click();
      await uiExpect(ui.getByTestId('studio-materials-search')).toHaveValue('');

      // Two ticked collections become two chips and are what a trial sends.
      await collection(common.id).check();
      await collection(removable.id).check();
      await uiExpect(collection(game.id)).not.toBeChecked();
      // The first collection settles English as the source; the Japanese one is now another direction.
      await uiExpect(collection(otherDirection.id)).toBeDisabled();
      await uiExpect(picker.locator('.studio-materials-collection-row').filter({ hasText: otherDirection.name })).toContainText(zh.materials.selection.other_direction);
      await uiExpect(picker).toContainText(fill(zh.materials.selection.selected_count, { count: 2 }));
      await ui.keyboard.press('Escape');
      await uiExpect(picker).toHaveCount(0); await uiExpect(form()).toBeVisible();
      await uiExpect(ui).toHaveURL(/#\/tools\/subtitle\/studio$/);
      await uiExpect(chips()).toHaveCount(2);
      await uiExpect(chips().filter({ hasText: common.name })).toHaveCount(1);
      await uiExpect(chips().filter({ hasText: removable.name })).toHaveCount(1);
      await uiExpect(ui.getByTestId('studio-materials-source')).toHaveText(zh.knowledge.languages.en);
      await capture('selected-two-zh-light-1280', form());
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toBeVisible();
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0].raw).toContain('首领');
      expect(provider.requests[0].raw).toContain('中继站');
      expect(provider.requests[0].raw).not.toContain('存档点');
      // The run is remembered as a recent set, in Studio preferences.
      expect((await preferences()).recentKnowledgeSets[0]).toMatchObject({ languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [common.id, removable.id] });
      await ui.getByTestId('studio-translation-review-close').click();
      await uiExpect(review()).toHaveCount(0);
      await closeTranslation();

      // The used collection is deleted; reusing the recent set skips it with a notice.
      await ui.evaluate(async id => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        const result = await window.translationKnowledge.deleteRecords({ generation: read.value.generation, items: [{ group: 'collections', id }] });
        if (!result.ok) throw new Error(result.error);
      }, removable.id);
      await openDocument(second.summary.id);
      await openTranslation(zh.studio.translation.action);
      await uiExpect(chips()).toHaveCount(0);
      await openPicker();
      await showTab(1);
      const recent = ui.getByTestId('studio-materials-recent-item');
      await uiExpect(recent).toHaveCount(1);
      await uiExpect(recent).toContainText(common.name);
      await recent.click();
      await uiExpect(ui.getByTestId('studio-materials-skipped')).toHaveText(fill(zh.materials.selection.preset_missing, { count: 1 }));
      await uiExpect(collection(common.id)).toBeChecked();
      await uiExpect(collection(removable.id)).toHaveCount(0);
      await uiExpect(chips()).toHaveCount(1);
      await capture('picker-recent-skipped-zh-light-1280', picker);

      // Applying a preset fills collections, requirements and context.
      await showTab(1);
      await ui.getByTestId(`studio-materials-preset-${livePreset.id}`).click();
      await uiExpect(ui.getByTestId('studio-materials-skipped')).toHaveCount(0);
      for (const id of livePreset.collectionIds) await uiExpect(collection(id)).toBeChecked();
      await done();
      await uiExpect(chips()).toHaveCount(2);
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(livePreset.instructions);
      await ui.getByTestId('studio-materials-more').locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(ui.getByTestId('studio-materials-context')).toHaveValue(livePreset.context);
      // A preset naming an archived collection applies the rest and says what it skipped.
      await openPicker();
      await showTab(1);
      await ui.getByTestId(`studio-materials-preset-${archivedPreset.id}`).click();
      await uiExpect(ui.getByTestId('studio-materials-skipped')).toHaveText(fill(zh.materials.selection.preset_missing, { count: 1 }));
      await uiExpect(collection(game.id)).toBeChecked();
      await uiExpect(collection(common.id)).not.toBeChecked();
      // Changing the selection after applying never edits the preset.
      await showTab(1);
      await ui.getByTestId(`studio-materials-preset-${livePreset.id}`).click();
      await collection(filler[0].id).check();
      await collection(common.id).uncheck();
      await done();
      expect(await presetNamed(livePreset.name)).toEqual(livePreset);

      // Save the current selection as a preset; it is stored in the library's presets.
      const instructions = 'Keep each subtitle concise and retain all information.';
      await ui.getByTestId('studio-translation-instructions').fill(instructions);
      await openPicker();
      await showTab(1);
      await ui.getByTestId('studio-materials-save-preset').click();
      const savedName = '系列视频的长名称预设，用来检查重命名和删除都能在选择器里完成';
      await ui.getByTestId('studio-materials-preset-name').fill(savedName);
      await ui.getByTestId('studio-materials-preset-confirm').click();
      await uiExpect.poll(async () => !!(await presetNamed(savedName))).toBe(true);
      const saved = (await presetNamed(savedName))!;
      expect(saved).toMatchObject({ revision: 1, languagePair: { source: 'en', target: 'zh-Hans' }, collectionIds: [game.id, filler[0].id], instructions, context: livePreset.context });
      await uiExpect(ui.getByTestId(`studio-materials-preset-${saved.id}`)).toBeVisible();
      await capture('picker-presets-zh-light-1280', picker);
      await done();
      await closeTranslation();

      // Next time the preset applies directly, then is renamed and deleted in the picker.
      await openDocument(first.summary.id);
      await openTranslation(zh.studio.translation.action);
      await openPicker();
      await showTab(1);
      await ui.getByTestId(`studio-materials-preset-${saved.id}`).click();
      await uiExpect(collection(game.id)).toBeChecked();
      await uiExpect(collection(filler[0].id)).toBeChecked();
      await uiExpect(collection(common.id)).not.toBeChecked();
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(instructions);
      await showTab(1);
      await presetMenu(saved.id, 'rename');
      await uiExpect(ui.getByTestId('studio-materials-preset-name')).toHaveValue(savedName);
      const renamed = '改名后的系列预设';
      await ui.getByTestId('studio-materials-preset-name').fill(renamed);
      await ui.getByTestId('studio-materials-preset-confirm').click();
      await uiExpect(picker.locator('.studio-materials-preset-name').filter({ hasText: renamed })).toBeVisible();
      await uiExpect.poll(async () => (await readLibrary(ui)).data.presets.find(preset => preset.id === saved.id)?.name).toBe(renamed);
      expect((await readLibrary(ui)).data.presets.find(preset => preset.id === saved.id)).toMatchObject({ collectionIds: saved.collectionIds, instructions, context: saved.context });
      await presetMenu(saved.id, 'delete');
      await uiExpect(picker).toContainText(fill(zh.materials.selection.preset_delete_confirm, { name: renamed }));
      expect((await readLibrary(ui)).data.presets.some(preset => preset.id === saved.id)).toBe(true);
      await capture('picker-preset-delete-confirm-zh-light-1280', picker);
      await ui.getByTestId('studio-materials-preset-delete-confirm').click();
      await uiExpect(ui.getByTestId(`studio-materials-preset-${saved.id}`)).toHaveCount(0);
      await uiExpect.poll(async () => (await readLibrary(ui)).data.presets.some(preset => preset.id === saved.id)).toBe(false);
      expect((await readLibrary(ui)).data.collections.map(item => item.id)).toEqual(expect.arrayContaining([game.id, filler[0].id]));
      await done();
      await closeTranslation();

      // Automatic translation uses the same picker and writes its choice to preferences.
      await ui.getByRole('tab', { name: zh.studio.workspace_transcription, exact: true }).click();
      const autoSwitch = ui.locator('#studio-transcription-auto-translation');
      if (await autoSwitch.getAttribute('aria-checked') !== 'true') await autoSwitch.click();
      const automatic = ui.getByTestId('studio-automatic-materials');
      await automatic.getByTestId('studio-materials-choose').click();
      await collection(game.id).check();
      await done();
      await uiExpect.poll(async () => (await preferences()).transcription.autoTranslation.knowledge).toMatchObject({ enabled: true, sourceLanguage: 'en', collectionIds: [game.id], disabledEntryIds: [] });
      await automatic.getByTestId('studio-materials-choose').click();
      await showTab(1);
      await ui.getByTestId(`studio-materials-preset-${livePreset.id}`).click();
      await done();
      await uiExpect.poll(async () => (await preferences()).transcription.autoTranslation.knowledge).toMatchObject({ enabled: true, sourceLanguage: 'en', collectionIds: livePreset.collectionIds, instructions: livePreset.instructions, context: livePreset.context });
      await uiExpect(ui.getByTestId('studio-automatic-instructions')).toHaveValue(livePreset.instructions);
      await capture('automatic-materials-zh-light-1280', automatic);

      // English, dark and 900 × 700: the saved automatic choice returns and the picker still fits.
      await preparePage(ui, { lang: 'en', theme: 'dark' });
      await launched.resize(900, 700); await settled(ui);
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await ui.getByRole('tab', { name: en.studio.workspace_transcription, exact: true }).click();
      await uiExpect(ui.getByTestId('studio-automatic-materials').locator('.studio-materials-chip')).toHaveCount(2);
      await ui.getByRole('tab', { name: en.studio.workspace_documents, exact: true }).click();
      await openDocument(first.summary.id);
      await openTranslation(en.studio.translation.action);
      await ui.getByRole('combobox', { name: en.studio.translation.language, exact: true }).click();
      await ui.getByRole('option', { name: en.studio.translation.languages.zh, exact: true }).click();
      await openPicker();
      await collection(game.id).check();
      await uiExpect(collection(otherDirection.id)).toBeDisabled();
      await uiExpect(picker.locator('.studio-materials-collection-row').filter({ hasText: otherDirection.name })).toContainText(en.materials.selection.other_direction);
      await capture('picker-selected-en-dark-900', picker);
      await wheelPicker('picker-en-dark-900');
      await done();
      await capture('form-selected-en-dark-900', form());
      const outerViewport = form().locator('[data-slot="scroll-area-viewport"]').first();
      expect(await outerViewport.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(50);
      const outerBefore = await outerViewport.evaluate(node => node.scrollTop);
      const outerBox = (await outerViewport.boundingBox())!;
      await ui.mouse.move(outerBox.x + 8, outerBox.y + outerBox.height / 2);
      await ui.mouse.wheel(0, outerBefore > 30 ? -200 : 200);
      await uiExpect.poll(() => outerViewport.evaluate(node => node.scrollTop)).not.toBe(outerBefore);
      await closeTranslation();
      for (const document of await readDocuments(ui)) { expect(document.tasks).toHaveLength(0); expect(document.translationTracks).toHaveLength(0); }
      expect(provider.requests).toHaveLength(1);
      expect([...launched.errors, ...provider.errors]).toEqual([]);
      await writeFile(path.join(artifacts, 'visual-metrics.json'), JSON.stringify(visualMeasurements, null, 2));
    } catch (error) {
      await writeFile(path.join(artifacts, 'visual-metrics.json'), JSON.stringify(visualMeasurements, null, 2));
      await ui.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 180000);
});

