import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_MODEL_PROFILE_UI === '1';
const later = ['large-v3-turbo-q8_0', 'belle-large-v3-turbo-zh', 'anime-whisper-q8_0'];
type Snapshot = { traces: { operation: string; detail?: any }[] };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function drop(page: Page, filePaths: string[]) {
  await uiExpect(page.locator('[data-slot=select-content]')).toHaveCount(0);
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.dataset.studioMediaDrop = ''; document.body.append(input); });
  await page.locator('[data-studio-media-drop]').setInputFiles(filePaths);
  await page.evaluate(() => {
    const input = document.querySelector('[data-studio-media-drop]') as HTMLInputElement;
    const transfer = new DataTransfer(); Array.from(input.files!).forEach(file => transfer.items.add(file));
    const target = document.querySelector('[data-testid=studio-transcription-picker]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    input.remove();
  });
}
/** The open model list against its trigger: names, what each suits, and any overflow. */
const options = (page: Page) => page.evaluate(async () => {
  const element = document.querySelector('[data-slot=select-content]')!;
  await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  const content = element.getBoundingClientRect(), trigger = document.querySelector('#studio-transcription-model')!.getBoundingClientRect();
  return { contentWidth: content.width, triggerWidth: trigger.width, contentLeft: content.left, triggerLeft: trigger.left, items: Array.from(document.querySelectorAll('[data-slot=select-item]')).map(item => {
    const small = item.querySelector('small'), r = item.getBoundingClientRect(), name = item.querySelector<HTMLElement>('.studio-transcription-model-option > span')!;
    return { name: name.textContent, nameLines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
      description: small?.textContent ?? null, descriptionSize: small ? getComputedStyle(small).fontSize : null, height: r.height, overflow: item.scrollWidth > item.clientWidth + 1 };
  }) };
});
/** The settings fields the model limits, with their reasons. */
const settings = (page: Page) => page.evaluate(() => {
  const rect = (element: Element | null) => { if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const hint = document.querySelector('[data-testid=studio-transcription-task-mode-hint]') as HTMLElement | null;
  const trigger = document.querySelector('#studio-transcription-task-mode');
  return { viewport: { width: innerWidth, height: innerHeight }, dark: document.documentElement.classList.contains('dark'),
    modelTrigger: document.querySelector('#studio-transcription-model')?.textContent, taskModeTrigger: trigger?.textContent,
    taskModeTriggerBox: rect(trigger), hint: hint ? { ...rect(hint), text: hint.textContent, fontSize: getComputedStyle(hint).fontSize, lineHeight: getComputedStyle(hint).lineHeight,
      marginTop: getComputedStyle(hint).marginTop, gapToTrigger: hint.getBoundingClientRect().top - trigger!.getBoundingClientRect().bottom } : null,
    noHorizontalOverflow: Array.from(document.querySelectorAll('.studio-transcription-layout, .studio-transcription-settings, .studio-transcription-workspace'))
      .every(element => element.scrollWidth <= element.clientWidth + 1) };
});
/** Resource rows: height, overflow, where the notes and actions sit. */
const rows = (page: Page) => page.locator('.studio-transcription-resource-dialog').evaluate(surface => {
  const viewport = surface.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]')!;
  return { viewportOverflow: viewport.scrollWidth - viewport.clientWidth, rows: [...surface.querySelectorAll<HTMLElement>('[data-resource-id]')].map(row => {
    const r = row.getBoundingClientRect(), identity = row.querySelector('.studio-resource-identity')!.getBoundingClientRect();
    const name = row.querySelector('.studio-resource-name')!.getBoundingClientRect(), actions = row.querySelector('.studio-resource-actions')!.getBoundingClientRect();
    const meta = row.querySelector('.studio-resource-heading')!.getBoundingClientRect();
    const notes = [...row.querySelectorAll<HTMLElement>('.studio-resource-note')].map(note => ({ text: note.textContent, left: note.getBoundingClientRect().left - name.left,
      right: note.getBoundingClientRect().right, height: note.getBoundingClientRect().height, gapAbove: note.getBoundingClientRect().top - meta.bottom,
      fontSize: getComputedStyle(note).fontSize, lineHeight: getComputedStyle(note).lineHeight }));
    return { id: row.dataset.resourceId, name: row.querySelector('.studio-resource-name')!.textContent, height: r.height, overflow: row.scrollWidth - row.clientWidth,
      badges: [...row.querySelectorAll('.studio-resource-meta [data-slot=badge]')].map(badge => badge.textContent), notes,
      // Notes start where the name starts and stay inside the row's padding.
      notesInside: notes.every(note => Math.abs(note.left) <= 1 && note.right <= r.right - 7), actionTopDelta: actions.top - name.top, actionGap: actions.left - identity.right };
  }) };
});

describe.runIf(enabled)('T-ASRQ-06 model profiles in the actual Electron transcription settings and resource manager', () => {
  it('lists the new models with their use and licence, offers only whole-media models, and disables English output for the fast one', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')), t = locale.transcription;
    const englishLocale = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8')), english = englishLocale.transcription;
    const pageErrors: string[] = [], logs: string[] = [];
    const evidence: Record<string, unknown> = { boundary: 'Only the native transcription runtime is controlled; renderer, preload, Studio IPC and preferences are real.' };
    let passed = false, app: ElectronApplication | undefined, page: Page | undefined;
    const shot = (name: string) => page!.screenshot({ path: path.join(fixture.artifacts, `asrq06-${name}.png`), animations: 'disabled' });
    const launch = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test'; env.FUSIONKIT_TEST_VC_RUNTIME = 'ok'; env.FUSIONKIT_TEST_GPU = 'nvidia';
      const instance = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [instance.process().stdout, instance.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      const window = await instance.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => pageErrors.push(error.message));
      window.on('console', message => { logs.push(`[console.${message.type()}] ${message.text()}\n`); });
      // The controlled resource adapter also answers the application-wide resource status.
      await instance.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('speech-resources:status');
        ipcMain.handle('speech-resources:status', async () => ({ shared: true, revision: 0, busyResourceIds: [], migrationIssues: [], cleanupPending: false }));
      });
      return { app: instance, page: window };
    };
    // As in the audio type test: correct the outer size by what the page reports.
    const size = async (width: number, height: number) => {
      const win = await app!.browserWindow(page!);
      const viewport = () => page!.evaluate(() => [innerWidth, innerHeight] as const);
      await win.evaluate((window, [w, h]) => window.setSize(w, h), [width, height] as const);
      await page!.waitForTimeout(300);
      const [innerW, innerH] = await viewport();
      await win.evaluate((window, [w, h]) => window.setSize(w, h), [width * 2 - innerW, height * 2 - innerH] as const);
      await page!.waitForFunction(([w, h]) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1, [width, height] as const);
    };
    const openTranscription = async (tab: string = locale.workspace_transcription) => {
      await page!.getByRole('tab', { name: tab, exact: true }).click();
      await control(app!, { operation: 'resources-ready' });
      // The later catalog models, with only the fast one installed.
      await control(app!, { operation: 'catalog-models' });
      await control(app!, { operation: 'resource-complete', resourceId: 'large-v3-turbo-q8_0' });
      await page!.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await page!.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
    };
    const modelTrigger = () => page!.locator('#studio-transcription-model');
    const taskMode = () => page!.locator('#studio-transcription-task-mode');
    // An option's name starts with the model's (its use follows); names contain parentheses.
    const option = (name: string) => page!.getByRole('option', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
    const chooseModel = async (name: string) => { await modelTrigger().click(); await option(name).click(); };
    const dialog = () => page!.locator('.studio-transcription-resource-dialog');
    const openResources = async () => {
      await page!.getByTestId('studio-transcription-manage-resources').click();
      await uiExpect(dialog().locator('[data-resource-id]')).toHaveCount(7);
      await page!.waitForTimeout(400);
    };
    const closeResources = async () => { await page!.keyboard.press('Escape'); await uiExpect(dialog()).toHaveCount(0); };
    const scrollRow = async (id: string) => { await dialog().locator(`[data-resource-id="${id}"]`).scrollIntoViewIfNeeded(); await page!.waitForTimeout(250); };
    try {
      ({ app, page } = await launch());
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await ready(page); await size(1280, 800); await openTranscription();
      // The default model is unchanged and English output is available with it.
      await uiExpect(modelTrigger()).toHaveText(t.resource_name_standard);
      await taskMode().click();
      await uiExpect(page.getByRole('option', { name: t.mode_english })).not.toHaveAttribute('data-disabled');
      await page.getByRole('option', { name: t.mode_english }).click();
      await uiExpect(taskMode()).toHaveText(t.mode_english);
      // Only whole-media models are offered, in catalog order; the fast one says what it suits.
      await modelTrigger().click();
      await uiExpect(page.getByRole('option')).toHaveCount(3);
      const list = await options(page); evidence.optionsLight1280 = list;
      expect(list.items.map(item => item.name)).toEqual([t.resource_name_standard, t.resource_name_best, t.resource_name_fast]);
      expect(list.items.map(item => item.description)).toEqual([null, null, t.model_scenario_fast]);
      expect(list.contentWidth).toBeGreaterThanOrEqual(list.triggerWidth - 1); expect(list.items.every(item => !item.overflow)).toBe(true);
      await shot('light-1280-model-options');
      await option(t.resource_name_fast).click();
      // English output falls back to the original language, is disabled, and says why.
      await uiExpect(modelTrigger()).toHaveText(t.resource_name_fast);
      await uiExpect(taskMode()).toHaveText(t.mode_transcribe);
      await uiExpect(page.getByTestId('studio-transcription-task-mode-hint')).toHaveText(t.model_no_translate);
      await uiExpect(page.getByTestId('studio-transcription-language-hint')).toHaveCount(0);
      await uiExpect(page.locator('#studio-transcription-prompt')).toBeEnabled();
      evidence.fastLight1280 = await settings(page);
      await shot('light-1280-fast');
      await taskMode().click();
      await uiExpect(page.getByRole('option', { name: t.mode_english })).toHaveAttribute('data-disabled', '');
      await shot('light-1280-task-mode-disabled'); await page.keyboard.press('Escape');
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1')!));
      expect(persisted.state.transcription.config).toMatchObject({ modelId: 'large-v3-turbo-q8_0', taskMode: 'transcribe' });
      // The task is submitted with what the model can do.
      const file = path.join(fixture.artifacts, '01-fast.wav'); await writeFile(file, Buffer.alloc(44));
      await drop(page, [file]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      await uiExpect(page.getByTestId('studio-transcription-task-row')).toHaveCount(1);
      const enqueued = (await control(app, { operation: 'snapshot' })).traces.filter(item => item.operation === 'enqueue').map(item => item.detail.config);
      expect(enqueued.map(config => [config.modelId, config.taskMode])).toEqual([['large-v3-turbo-q8_0', 'transcribe']]);
      await uiExpect(page.getByTestId('studio-transcription-task-row').locator('.studio-task-model')).toContainText(t.resource_name_fast_short);
      // The resource manager lists all three with name, size, use, marks and licence; the recognize-only ones stay downloadable.
      await openResources();
      const light = await rows(page); evidence.rowsLight1280 = light;
      expect(light.rows.map(row => row.id).slice(2, 5)).toEqual(later);
      expect(light.rows.find(row => row.id === 'large-v3-turbo-q8_0')).toMatchObject({ name: t.resource_name_fast, badges: [t.resource_ready], notes: [{ text: t.model_scenario_fast }] });
      expect(light.rows.find(row => row.id === 'belle-large-v3-turbo-zh')).toMatchObject({ name: t.resource_name_chinese,
        badges: [t.resource_not_installed, t.model_recognize_only, t.model_experimental], notes: [{ text: t.model_scenario_chinese }, { text: t.model_license_belle }] });
      expect(light.rows.find(row => row.id === 'anime-whisper-q8_0')).toMatchObject({ name: t.resource_name_anime,
        badges: [t.resource_not_installed, t.model_recognize_only, t.model_experimental], notes: [{ text: t.model_scenario_anime }, { text: t.model_license_anime }] });
      for (const id of later.slice(1)) {
        const row = dialog().locator(`[data-resource-id="${id}"]`);
        await uiExpect(row.getByRole('button', { name: t.download, exact: true })).toBeEnabled();
        await uiExpect(row.getByRole('button', { name: t.import_model, exact: true })).toBeEnabled();
      }
      expect(light.viewportOverflow).toBeLessThanOrEqual(1);
      expect(light.rows.every(row => row.overflow <= 1 && Math.abs(row.actionTopDelta) <= 1 && row.notesInside)).toBe(true);
      await shot('light-1280-resources');
      await scrollRow('anime-whisper-q8_0'); await shot('light-1280-resources-later');
      await closeResources();
      await size(1024, 700); await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      evidence.fastLight1024 = await settings(page); await shot('light-1024-fast');
      await modelTrigger().click(); evidence.optionsLight1024 = await options(page); await shot('light-1024-model-options'); await page.keyboard.press('Escape');
      await openResources(); evidence.rowsLight1024 = await rows(page); await scrollRow('belle-large-v3-turbo-zh'); await shot('light-1024-resources'); await closeResources();
      // Dark: reopened, the fast model and its fallback are kept.
      await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await app.close(); app = undefined; ({ app, page } = await launch());
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await size(1280, 800); await openTranscription();
      await uiExpect(modelTrigger()).toHaveText(t.resource_name_fast); await uiExpect(taskMode()).toHaveText(t.mode_transcribe);
      evidence.fastDark1280 = await settings(page); await shot('dark-1280-fast');
      await modelTrigger().click(); evidence.optionsDark1280 = await options(page); await shot('dark-1280-model-options'); await page.keyboard.press('Escape');
      await openResources(); evidence.rowsDark1280 = await rows(page); await scrollRow('belle-large-v3-turbo-zh'); await shot('dark-1280-resources'); await closeResources();
      await size(1024, 700); await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      evidence.fastDark1024 = await settings(page); await shot('dark-1024-fast');
      await openResources(); evidence.rowsDark1024 = await rows(page); await scrollRow('anime-whisper-q8_0'); await shot('dark-1024-resources'); await closeResources();
      // Choosing the standard model again offers English output again (the choice itself was set back).
      await chooseModel(t.resource_name_standard);
      await uiExpect(page.getByTestId('studio-transcription-task-mode-hint')).toHaveCount(0);
      await taskMode().click(); await uiExpect(page.getByRole('option', { name: t.mode_english })).not.toHaveAttribute('data-disabled'); await page.keyboard.press('Escape');
      // English: the longest names, uses and licences.
      await page.evaluate(() => { localStorage.setItem('lang', 'en'); }); await page.reload(); await ready(page);
      await size(1024, 700); await openTranscription(englishLocale.workspace_transcription);
      await chooseModel(english.resource_name_fast);
      await uiExpect(page.getByTestId('studio-transcription-task-mode-hint')).toHaveText(english.model_no_translate);
      evidence.english1024 = await settings(page); await shot('dark-1024-english-fast');
      await modelTrigger().click(); evidence.optionsEnglish1024 = await options(page); await shot('dark-1024-english-model-options'); await page.keyboard.press('Escape');
      await openResources(); evidence.rowsEnglish1024 = await rows(page); await scrollRow('anime-whisper-q8_0'); await shot('dark-1024-english-resources'); await closeResources();
      for (const key of ['fastLight1280', 'fastLight1024', 'fastDark1280', 'fastDark1024', 'english1024']) expect((evidence[key] as { noHorizontalOverflow: boolean }).noHorizontalOverflow, key).toBe(true);
      // Model names stay on one line, English included; the list is never narrower than its trigger nor wider than 22rem.
      for (const key of ['optionsLight1280', 'optionsLight1024', 'optionsDark1280', 'optionsEnglish1024']) {
        const value = evidence[key] as Awaited<ReturnType<typeof options>>;
        expect(value.items.map(item => item.nameLines), key).toEqual([1, 1, 1]);
        expect(value.contentWidth >= value.triggerWidth - 1 && value.contentWidth <= 352 + 1 && value.items.every(item => !item.overflow), key).toBe(true);
      }
      for (const key of ['rowsLight1024', 'rowsDark1280', 'rowsDark1024', 'rowsEnglish1024']) {
        const value = evidence[key] as Awaited<ReturnType<typeof rows>>;
        expect(value.viewportOverflow, key).toBeLessThanOrEqual(1);
        expect(value.rows.every(row => row.overflow <= 1 && row.notesInside), key).toBe(true);
      }
      expect(pageErrors).toEqual([]);
      passed = true;
    } finally {
      if (!passed && app && page) {
        await shot('failure').catch(() => undefined);
        evidence.failureTraces = await control(app, { operation: 'snapshot' }).then(value => value.traces.map(item => item.operation)).catch(error => String(error));
      }
      await writeFile(path.join(fixture.artifacts, 'asrq06-result.json'), JSON.stringify({ outcome: passed ? 'passed' : 'failed', ...evidence, pageErrors }, null, 2));
      await writeFile(path.join(fixture.artifacts, 'asrq06-electron.log'), logs.join(''));
      try { await app?.close(); } finally { await fixture.cleanup(); }
    }
  }, 300000);
});
