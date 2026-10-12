import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeFixture } from './fixtures';
import type { SaveItem } from '../../src/translation-knowledge/ipc-contract';
import type { TermEntry } from '../../src/translation-knowledge/schemas';
import zh from '../../src/locales/zh/knowledge.json';
import en from '../../src/locales/en/knowledge.json';

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(values[key]));

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('translation materials page in Electron', () => {
  let application: ElectronApplication | undefined;
  let page: Page;
  let root: string;
  const screenshots = path.resolve('test-results/translation-knowledge-page');
  const errors: string[] = [];
  afterAll(async () => {
    try {
      const process = application?.process();
      await application?.close();
      if (process) expect(process.exitCode !== null || process.signalCode !== null).toBe(true);
    }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  const read = () => page.evaluate(async () => {
    const result = await window.translationKnowledge.read();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
  /** Writes behind the page's back, the way another window or the assistant would. */
  const saveBehind = (items: SaveItem[]) => page.evaluate(async items => {
    const current = await window.translationKnowledge.read();
    if (!current.ok) throw new Error(current.error);
    const result = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items });
    if (!result.ok) throw new Error(`${result.error} ${JSON.stringify(result.diagnostics ?? [])}`);
  }, items);
  const termBySource = async (collectionId: string, source: string) => (await read()).data.entries.find((entry): entry is TermEntry => entry.kind === 'term' && entry.collectionId === collectionId && entry.payload.source === source);
  const capture = async (name: string, target?: Locator) => {
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    if (target) await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
  };
  /** Soft so the rest of the journey still runs; a miss still fails the test. */
  const focusReturnsTo = async (target: Locator) => {
    try { await uiExpect(target).toBeFocused({ timeout: 3000 }); return true; } catch { return false; }
  };
  const setPreferences = async (lang: 'zh' | 'en', theme: 'light' | 'dark') => {
    await page.evaluate(({ lang, theme }) => {
      localStorage.setItem('lang', lang);
      localStorage.setItem('translation-knowledge-tour-done', '1');
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
      location.hash = '/tools/translation-knowledge';
    }, { lang, theme });
    await page.reload();
    await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
  };

  it('creates, edits, pastes, searches and pages terms and notes with immediate saves', async ({ onTestFailed }) => {
    onTestFailed(async () => { await page?.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => undefined); });
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-page-e2e-'));
    await mkdir(screenshots, { recursive: true });
    application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate(win => win.setSize(1280, 800));
    await setPreferences('zh', 'light');
    const sidebar = page.locator('#knowledge-collection-list');
    const header = page.getByTestId('knowledge-collection-header');
    const table = page.getByTestId('knowledge-term-table');
    const rowOf = (id: string) => table.locator(`[role=row][data-entry-id="${id}"]`);
    const collectionRow = (id: string) => sidebar.locator(`[data-collection-id="${id}"]`);
    const toastText = (text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text });

    // AC-PAGE-01-4: an empty library explains collections and offers create / import.
    const empty = page.getByTestId('knowledge-empty-library');
    await uiExpect(empty).toContainText(zh.empty.title);
    await uiExpect(empty).toContainText(zh.empty.help);
    await uiExpect(page.getByTestId('knowledge-empty-import')).toBeEnabled();
    await capture('01-empty-zh-light');

    // AC-PAGE-04-1: name and direction are enough; the new collection is selected with its add row.
    await page.getByTestId('knowledge-empty-create').click();
    const form = page.getByTestId('knowledge-collection-form');
    await form.getByRole('textbox', { name: zh.collection.name, exact: true }).fill('字幕测试集');
    await form.getByRole('combobox', { name: zh.collection.source_language, exact: true }).click();
    await page.getByRole('option', { name: zh.languages.en, exact: true }).click();
    await form.getByRole('combobox', { name: zh.collection.target_language, exact: true }).click();
    await page.getByRole('option', { name: zh.languages['zh-Hans'], exact: true }).click();
    await capture('02-collection-dialog-zh-light');
    await page.getByTestId('knowledge-collection-save').click();
    await uiExpect(form).toHaveCount(0);
    const created = (await read()).data.collections.find(item => item.name === '字幕测试集')!;
    expect(created).toMatchObject({ languagePair: { source: 'en', target: 'zh-Hans' }, archived: false });
    await uiExpect(collectionRow(created.id)).toHaveAttribute('aria-current', 'true');
    await uiExpect(header.getByRole('heading')).toHaveText('字幕测试集');
    await uiExpect(table).toContainText(zh.terms.empty);
    const addSource = page.getByTestId('knowledge-add-source'), addTarget = page.getByTestId('knowledge-add-target');
    await uiExpect(addSource).toBeVisible();

    // AC-PAGE-02-1: Enter adds an enabled manual term, clears the row and returns to the source input.
    for (const [source, target, from] of [['save slot', '存档槽', addTarget], ['starport', '星港', addSource], ['hub', '枢纽', addTarget]] as const) {
      await addSource.fill(source);
      await addTarget.fill(target);
      await from.press('Enter');
      await uiExpect(table.locator('[role=row][data-entry-id]').filter({ hasText: source })).toHaveCount(1);
      await uiExpect(addSource).toHaveValue('');
      await uiExpect(addTarget).toHaveValue('');
      await uiExpect(addSource).toBeFocused();
    }
    const slot = (await termBySource(created.id, 'save slot'))!;
    expect(slot).toMatchObject({ enabled: true, origin: { kind: 'manual' }, payload: { target: '存档槽', strength: 'preferred' } });
    const starport = (await termBySource(created.id, 'starport'))!, hub = (await termBySource(created.id, 'hub'))!;

    // AC-PAGE-02-2: click the target, type, Enter saves.
    const hubRow = rowOf(hub.id);
    await hubRow.getByRole('button', { name: `${zh.terms.target}: 枢纽`, exact: true }).click();
    await hubRow.getByRole('textbox', { name: zh.terms.target, exact: true }).fill('中枢');
    await page.keyboard.press('Enter');
    await uiExpect(hubRow.getByRole('button', { name: `${zh.terms.target}: 中枢`, exact: true })).toBeVisible();
    await uiExpect.poll(async () => (await termBySource(created.id, 'hub'))?.payload.target).toBe('中枢');
    // A revision conflict keeps nothing of the attempt: the error shows and the newest library replaces the stale row.
    const hubSaved = (await termBySource(created.id, 'hub'))!;
    await saveBehind([{ group: 'entries', record: { ...hubSaved, payload: { ...hubSaved.payload, target: '别处译法' } } }]);
    await hubRow.getByRole('button', { name: `${zh.terms.target}: 中枢`, exact: true }).click();
    await hubRow.getByRole('textbox', { name: zh.terms.target, exact: true }).fill('冲突译法');
    await page.keyboard.press('Enter');
    await uiExpect(hubRow.getByRole('alert')).toHaveText(zh.errors.changed_elsewhere);
    await uiExpect(toastText(zh.errors.changed_elsewhere)).toBeVisible();
    await uiExpect(hubRow.getByRole('button', { name: `${zh.terms.target}: 别处译法`, exact: true })).toBeVisible();
    await uiExpect(hubRow).not.toContainText('冲突译法');
    expect((await termBySource(created.id, 'hub'))?.payload.target).toBe('别处译法');
    await capture('03-revision-conflict-zh-light', hubRow);

    // AC-PAGE-02-3: the requirement and the switch save at once (also proves the refresh above took effect).
    await hubRow.getByTestId('knowledge-term-strength').click();
    await page.getByRole('option', { name: zh.strength.required, exact: true }).click();
    await uiExpect(hubRow.getByTestId('knowledge-term-strength')).toHaveText(zh.strength.required);
    await uiExpect.poll(async () => (await termBySource(created.id, 'hub'))?.payload.strength).toBe('required');
    await hubRow.getByTestId('knowledge-term-enabled').click();
    await uiExpect(hubRow).toHaveAttribute('data-enabled', 'false');
    await uiExpect(hubRow.getByText(zh.terms.disabled, { exact: true })).toBeVisible();
    await uiExpect(hubRow.getByTestId('knowledge-term-enabled')).toHaveAttribute('aria-checked', 'false');
    await uiExpect.poll(async () => (await termBySource(created.id, 'hub'))?.enabled).toBe(false);
    // Only the earlier cell message remains; the immediate saves themselves reported nothing.
    await uiExpect(hubRow.getByRole('alert')).toHaveCount(1);

    // AC-PAGE-02-4: the drawer edits aliases, note and matching; closing returns focus to the same "more" button.
    const starRow = rowOf(starport.id);
    const starMore = starRow.getByTestId('knowledge-term-more');
    await starMore.click();
    const drawer = page.getByTestId('knowledge-entry-drawer');
    await uiExpect(drawer).toBeVisible();
    await uiExpect(drawer.getByTestId('knowledge-drawer-origin')).toContainText(zh.origin.manual);
    await drawer.getByLabel(zh.drawer.aliases, { exact: true }).fill('star port\nspace port\n');
    await drawer.getByLabel(zh.drawer.note, { exact: true }).fill('太空港口');
    await drawer.getByRole('combobox', { name: zh.drawer.match, exact: true }).click();
    await page.getByRole('option', { name: zh.match.whole_term, exact: true }).click();
    await capture('04-drawer-zh-light');
    await drawer.getByTestId('knowledge-drawer-save').click();
    await uiExpect(drawer).toHaveCount(0);
    await uiExpect(starRow).toContainText(`${fill(zh.terms.aliases_count, { count: 2 })} · 太空港口`);
    expect.soft(await focusReturnsTo(starMore), 'focus returns to the "more" button after the drawer saves').toBe(true);
    expect((await termBySource(created.id, 'starport'))?.payload).toMatchObject({ aliases: ['star port', 'space port'], note: '太空港口', match: { mode: 'whole_term' }, target: '星港' });

    // AC-PAGE-02-5: the preview tells new / same / different apart; only new rows are written unless overwrite is chosen.
    const pasted = 'save slot\t存档槽\nstarport\t星际港口\nwarp gate\t跃迁门';
    const pasteDialog = page.getByRole('dialog').filter({ has: page.getByTestId('knowledge-paste-preview').or(page.getByTestId('knowledge-paste-save')) });
    const paste = async () => {
      await page.getByTestId('knowledge-paste-open').click();
      await page.getByTestId('knowledge-paste-input').fill(pasted);
      await page.getByTestId('knowledge-paste-preview').click();
      await uiExpect(page.getByTestId('knowledge-paste-rows')).toBeVisible();
    };
    await paste();
    const statuses = () => page.getByTestId('knowledge-paste-rows').locator('[data-paste-status]').evaluateAll(rows => rows.map(row => row.getAttribute('data-paste-status')));
    expect(await statuses()).toEqual(['same', 'conflict', 'new']);
    await uiExpect(page.getByTestId('knowledge-paste-summary')).toHaveText(fill(zh.paste.summary, { added: 1, same: 1, conflict: 1, invalid: 0 }));
    await uiExpect(page.getByTestId('knowledge-paste-save')).toHaveText(fill(zh.paste.save, { count: 1 }));
    await capture('05-paste-preview-zh-light');
    await page.getByTestId('knowledge-paste-save').click();
    await uiExpect(pasteDialog).toHaveCount(0);
    expect(await termBySource(created.id, 'warp gate')).toMatchObject({ enabled: true, payload: { target: '跃迁门' } });
    expect((await termBySource(created.id, 'starport'))?.payload.target).toBe('星港');
    await paste();
    expect(await statuses()).toEqual(['same', 'conflict', 'same']);
    await uiExpect(page.getByTestId('knowledge-paste-save')).toBeDisabled();
    await page.getByRole('checkbox', { name: fill(zh.paste.overwrite, { count: 1 }), exact: true }).check();
    await uiExpect(page.getByTestId('knowledge-paste-save')).toHaveText(fill(zh.paste.save, { count: 1 }));
    await page.getByTestId('knowledge-paste-save').click();
    await uiExpect(pasteDialog).toHaveCount(0);
    await uiExpect(starRow.getByRole('button', { name: `${zh.terms.target}: 星际港口`, exact: true })).toBeVisible();
    const afterPaste = await read();
    expect(afterPaste.data.entries.filter(entry => entry.collectionId === created.id && entry.kind === 'term')).toHaveLength(4);
    expect((await termBySource(created.id, 'starport'))?.payload).toMatchObject({ target: '星际港口', aliases: ['star port', 'space port'] });
    await capture('06-terms-zh-light', table);

    // AC-PAGE-03-1..3: requirements with 重要, editing, empty text, and the enable switch.
    await page.getByRole('tab', { name: new RegExp(`^${zh.views.notes}`) }).click();
    const rules = page.getByTestId('knowledge-notes-rule');
    const addRule = page.getByTestId('knowledge-add-rule');
    await addRule.getByRole('textbox', { name: zh.notes.new_rule, exact: true }).fill('称呼保留敬称');
    await addRule.getByRole('checkbox', { name: zh.notes.required, exact: true }).check();
    await addRule.getByRole('textbox', { name: zh.notes.new_rule, exact: true }).press('Control+Enter');
    const ruleRow = rules.locator('li[data-entry-id]').filter({ hasText: '称呼保留敬称' });
    await uiExpect(ruleRow.getByTestId('knowledge-note-required')).toHaveText(zh.notes.required_badge);
    await uiExpect(ruleRow).toHaveAttribute('data-enabled', 'true');
    await uiExpect(addRule.getByRole('textbox', { name: zh.notes.new_rule, exact: true })).toHaveValue('');
    await uiExpect(addRule.getByRole('checkbox', { name: zh.notes.required, exact: true })).not.toBeChecked();
    const ruleId = (await ruleRow.getAttribute('data-entry-id'))!;
    expect((await read()).data.entries.find(entry => entry.id === ruleId)).toMatchObject({ kind: 'rule', enabled: true, origin: { kind: 'manual' }, payload: { text: '称呼保留敬称', required: true } });
    const ruleById = rules.locator(`li[data-entry-id="${ruleId}"]`);
    await ruleById.getByTestId('knowledge-note-more').click();
    await page.getByTestId('knowledge-note-edit-action').click();
    const noteEditor = ruleById.getByTestId('knowledge-note-edit').getByRole('textbox');
    await noteEditor.fill('   ');
    await noteEditor.press('Control+Enter');
    await uiExpect(ruleById.getByRole('alert')).toHaveText(zh.notes.empty_text);
    expect((await read()).data.entries.find(entry => entry.id === ruleId)).toMatchObject({ payload: { text: '称呼保留敬称' } });
    await noteEditor.fill('称呼保留「さん」等敬称');
    await noteEditor.press('Control+Enter');
    await uiExpect(ruleById.getByTestId('knowledge-note-edit')).toHaveCount(0);
    await uiExpect(ruleById).toContainText('称呼保留「さん」等敬称');
    await uiExpect.poll(async () => (await read()).data.entries.find(entry => entry.id === ruleId)).toMatchObject({ enabled: true, payload: { text: '称呼保留「さん」等敬称', required: true } });
    await ruleById.getByTestId('knowledge-note-enabled').click();
    await uiExpect(ruleById).toHaveAttribute('data-enabled', 'false');
    await uiExpect(ruleById.getByText(zh.terms.disabled, { exact: true })).toBeVisible();
    await uiExpect.poll(async () => (await read()).data.entries.find(entry => entry.id === ruleId)?.enabled).toBe(false);
    await capture('07-notes-disabled-zh-light', rules);
    await ruleById.getByTestId('knowledge-note-enabled').click();
    await uiExpect(ruleById).toHaveAttribute('data-enabled', 'true');
    await uiExpect(ruleById.getByText(zh.terms.disabled, { exact: true })).toHaveCount(0);
    await uiExpect.poll(async () => (await read()).data.entries.find(entry => entry.id === ruleId)?.enabled).toBe(true);

    // Seed a larger library: the multi-collection example (two live, one archived) plus 300 terms for paging.
    const fixture = knowledgeFixture();
    const paging = { id: randomUUID(), revision: 1, name: '分页术语', description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: false };
    const many: TermEntry[] = Array.from({ length: 300 }, (_, index) => ({ id: randomUUID(), revision: 1, kind: 'term', collectionId: paging.id, enabled: true, origin: { kind: 'import' },
      payload: { source: `item ${String(index + 1).padStart(3, '0')}`, target: `条目 ${index + 1}`, aliases: [], note: '', strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } } }));
    await saveBehind([...fixture.collections.map(record => ({ group: 'collections' as const, record })), { group: 'collections', record: paging },
      ...fixture.entries.map(record => ({ group: 'entries' as const, record })), ...fixture.presets.map(record => ({ group: 'presets' as const, record }))]);
    await saveBehind(many.slice(0, 200).map(record => ({ group: 'entries', record })));
    await saveBehind(many.slice(200).map(record => ({ group: 'entries', record })));
    await page.reload();

    // AC-PAGE-01-2: live collections by name, archived ones apart; the first live one opens.
    const library = await read();
    const liveNames = await page.evaluate(names => [...names].sort((a, b) => a.localeCompare(b)), library.data.collections.filter(item => !item.archived).map(item => item.name));
    const firstLive = library.data.collections.find(item => item.name === liveNames[0])!;
    await uiExpect(page.locator('#knowledge-tour-collections [data-collection-id]').first()).toBeVisible();
    expect(await page.getByTestId('knowledge-collections-scroll').locator('[data-collection-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-collection-id'))))
      .toEqual(liveNames.map(name => library.data.collections.find(item => item.name === name)!.id));
    await uiExpect(collectionRow(firstLive.id)).toHaveAttribute('aria-current', 'true');
    await uiExpect(header.getByRole('heading')).toHaveText(firstLive.name);
    await uiExpect(page.getByTestId('knowledge-archived')).toContainText(fill(zh.sidebar.archived, { count: 1 }));
    await capture('08-library-zh-light-1280x800');

    // AC-PAGE-01-3: results grouped by collection; choosing one opens its collection and tab and highlights the row.
    const search = page.getByTestId('knowledge-global-search');
    const results = page.getByTestId('knowledge-search-results');
    await search.fill('存档');
    const groups = await results.getByRole('group').evaluateAll(items => items.map(item => item.getAttribute('aria-label')));
    expect([...groups].sort()).toEqual(['字幕测试集', '游戏 X'].sort());
    expect(groups).toEqual(liveNames.filter(name => groups.includes(name)));
    const checkpoint = fixture.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'checkpoint')!;
    await uiExpect(results.getByRole('group', { name: '游戏 X', exact: true }).locator(`[data-entry-id="${checkpoint.id}"]`)).toContainText('存档点');
    await uiExpect(results.getByRole('group', { name: '字幕测试集', exact: true }).locator(`[data-entry-id="${slot.id}"]`)).toContainText('存档槽');
    await capture('09-global-search-zh-light');
    const pick = firstLive.id === created.id ? { entry: checkpoint.id, collection: checkpoint.collectionId } : { entry: slot.id, collection: created.id };
    await results.locator(`[data-entry-id="${pick.entry}"]`).click();
    await uiExpect(results).toHaveCount(0);
    await uiExpect(collectionRow(pick.collection)).toHaveAttribute('aria-current', 'true');
    await uiExpect(page.getByRole('tab', { name: new RegExp(`^${zh.views.terms}`) })).toHaveAttribute('aria-selected', 'true');
    await uiExpect(rowOf(pick.entry)).toHaveAttribute('data-highlighted', 'true');
    await uiExpect(rowOf(pick.entry)).toBeInViewport();
    // A note result in another collection opens the notes tab there.
    const unitRule = fixture.entries.find(entry => entry.kind === 'rule' && entry.payload.text.includes('数值'))!;
    await search.fill('数值 单位');
    await results.locator(`[data-entry-id="${unitRule.id}"]`).click();
    await uiExpect(collectionRow(unitRule.collectionId)).toHaveAttribute('aria-current', 'true');
    await uiExpect(page.getByRole('tab', { name: new RegExp(`^${zh.views.notes}`) })).toHaveAttribute('aria-selected', 'true');
    await uiExpect(page.locator(`[data-testid=knowledge-notes-rule] li[data-entry-id="${unitRule.id}"]`)).toHaveAttribute('data-highlighted', 'true');

    // AC-PAGE-02-6: 300 terms page at 100.
    await collectionRow(paging.id).click();
    await uiExpect(header.getByRole('heading')).toHaveText(paging.name);
    await page.getByRole('tab', { name: new RegExp(`^${zh.views.terms}`) }).click();
    await uiExpect(page.getByRole('tab', { name: new RegExp(`^${zh.views.terms}`) })).toHaveText(`${zh.views.terms} 300`);
    const pageRows = table.locator('[role=row][data-entry-id]');
    await uiExpect(pageRows).toHaveCount(100);
    await uiExpect(table).toContainText(fill(zh.pagination, { count: 300, page: 1, pages: 3 }));
    await uiExpect(pageRows.first()).toHaveAttribute('data-entry-id', many[0].id);
    await table.getByRole('button', { name: zh.actions.next, exact: true }).click();
    await uiExpect(table).toContainText(fill(zh.pagination, { count: 300, page: 2, pages: 3 }));
    await uiExpect(pageRows).toHaveCount(100);
    await uiExpect(pageRows.first()).toHaveAttribute('data-entry-id', many[100].id);
    await table.getByRole('button', { name: zh.actions.next, exact: true }).click();
    await uiExpect(pageRows.last()).toHaveAttribute('data-entry-id', many[299].id);
    await uiExpect(table.getByRole('button', { name: zh.actions.next, exact: true })).toBeDisabled();
    await capture('10-pagination-zh-light', table.getByRole('button', { name: zh.actions.next, exact: true }));

    // English, dark: the same library reads in English.
    await setPreferences('en', 'dark');
    await uiExpect(sidebar).toContainText(en.sidebar.collections);
    await collectionRow(created.id).click();
    await uiExpect(page.getByRole('tab', { name: new RegExp(`^${en.views.terms}`) })).toBeVisible();
    await uiExpect(rowOf(hub.id).getByText(en.terms.disabled, { exact: true })).toBeVisible();
    await capture('11-terms-en-dark');
    await rowOf(starport.id).getByTestId('knowledge-term-more').click();
    await uiExpect(page.getByTestId('knowledge-entry-drawer')).toContainText(en.drawer.title);
    await capture('12-drawer-en-dark');
    await page.keyboard.press('Escape');
    await uiExpect(page.getByTestId('knowledge-entry-drawer')).toHaveCount(0);
    expect.soft(await focusReturnsTo(rowOf(starport.id).getByTestId('knowledge-term-more')), 'focus returns to the "more" button after Esc').toBe(true);
    await page.getByRole('tab', { name: new RegExp(`^${en.views.notes}`) }).click();
    await uiExpect(page.getByTestId('knowledge-notes-rule')).toContainText(en.notes.rules);
    await capture('13-notes-en-dark');
    expect(errors).toEqual([]);
  }, 240000);
});
