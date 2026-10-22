import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_AUDIO_PROFILE_UI === '1';
type Snapshot = { tasks: { taskId: string; status: string; audioProfile?: string }[]; traces: { operation: string; detail?: any }[] };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
async function drop(page: Page, filePaths: string[]) {
  // A closing select still hides the page from assistive technology (and so from the drop scope).
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
/** The settings column's geometry: the audio type field against its neighbours, the trigger and any overflow. */
const geometry = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const field = (id: string) => document.getElementById(id)?.closest('[class*=space-y]') as HTMLElement | null;
  const rect = (element: Element | null | undefined) => { if (!element) return null; const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const hint = document.querySelector('[data-testid=studio-transcription-audio-hint], [data-testid=studio-transcription-audio-reset]') as HTMLElement | null;
  return { viewport: { width: innerWidth, height: innerHeight }, dark: document.documentElement.classList.contains('dark'),
    language: rect(field('studio-transcription-language')), device: rect(field('studio-transcription-device')),
    audio: rect(field('studio-transcription-audio-type')), taskMode: rect(field('studio-transcription-task-mode')),
    trigger: box('#studio-transcription-audio-type'), languageTrigger: box('#studio-transcription-language'),
    hint: hint ? { ...rect(hint), fontSize: getComputedStyle(hint).fontSize, lineHeight: getComputedStyle(hint).lineHeight, color: getComputedStyle(hint).color } : null,
    noHorizontalOverflow: Array.from(document.querySelectorAll('.studio-transcription-layout, .studio-transcription-settings, .studio-transcription-workspace'))
      .every(element => element.scrollWidth <= element.clientWidth + 1) };
});
const options = (page: Page) => page.evaluate(async () => {
  // Measure after the opening zoom, not part way through it.
  const element = document.querySelector('[data-slot=select-content]')!;
  await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  const content = element.getBoundingClientRect();
  const trigger = document.querySelector('#studio-transcription-audio-type')!.getBoundingClientRect();
  return { contentWidth: content.width, triggerWidth: trigger.width, contentLeft: content.left, triggerLeft: trigger.left,
    items: Array.from(document.querySelectorAll('[data-slot=select-item]')).map(item => {
      const small = item.querySelector('small'), r = item.getBoundingClientRect();
      // The name, then the "experimental" mark the profiles carry (records/polish.md).
      return { text: item.querySelector('.studio-transcription-audio-option > span')?.firstChild?.textContent, description: small?.textContent,
        experimental: item.querySelector('[data-testid=studio-transcription-audio-experimental]')?.textContent ?? null,
        descriptionSize: small ? getComputedStyle(small).fontSize : null, height: r.height, right: r.right, overflow: item.scrollWidth > item.clientWidth + 1 };
    }) };
});

describe.runIf(enabled)('T-ASRQ-02 audio type in the actual Electron transcription settings', () => {
  it('offers the audio types, couples them with voice detection, labels tasks and keeps the choice', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')), t = locale.transcription;
    const englishLocale = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8')), english = englishLocale.transcription;
    const pageErrors: string[] = [], logs: string[] = [];
    const evidence: Record<string, unknown> = { boundary: 'Only the native transcription runtime is controlled; renderer, preload, Studio IPC and preferences are real.' };
    let passed = false, app: ElectronApplication | undefined, page: Page | undefined;
    const shot = (name: string) => page!.screenshot({ path: path.join(fixture.artifacts, `asrq02-${name}.png`), animations: 'disabled' });
    const launch = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      const instance = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [instance.process().stdout, instance.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      const window = await instance.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => pageErrors.push(error.message));
      window.on('console', message => { logs.push(`[console.${message.type()}] ${message.text()}\n`); });
      return { app: instance, page: window };
    };
    // The page's viewport is the target size. Under test the hidden title bar can count resize borders into
    // the content area, so correct the outer size by what the page reports instead of trusting either size.
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
      await page!.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await page!.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
    };
    const vad = () => page!.locator('#studio-transcription-vad');
    const trigger = () => page!.locator('#studio-transcription-audio-type');
    const choose = async (name: string) => { await trigger().click(); await page!.getByRole('option', { name: new RegExp(`^${name}`) }).click(); };
    try {
      ({ app, page } = await launch());
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await ready(page); await size(1280, 800); await openTranscription();
      // Standard by default, with its hint; the audio type sits after the language/device fields.
      await uiExpect(trigger()).toHaveText(t.audio_standard);
      await uiExpect(page.getByTestId('studio-transcription-audio-hint')).toHaveText(t.audio_standard_hint);
      evidence.light1280 = await geometry(page);
      await shot('light-1280-standard');
      // Voice detection off, then a profile: choosing it turns detection back on.
      await vad().click(); await uiExpect(vad()).toHaveAttribute('aria-checked', 'false');
      await trigger().click();
      await uiExpect(page.getByRole('option')).toHaveCount(3);
      const list = await options(page); evidence.optionsLight1280 = list;
      expect(list.items.map(item => item.text)).toEqual([t.audio_standard, t.audio_quiet, t.audio_noisy]);
      expect(list.items.map(item => item.experimental)).toEqual([null, t.model_experimental, t.model_experimental]);
      expect(list.items.map(item => item.description)).toEqual([t.audio_standard_description, t.audio_quiet_description, t.audio_noisy_description]);
      expect(Math.abs(list.contentWidth - list.triggerWidth)).toBeLessThanOrEqual(1); expect(list.items.every(item => !item.overflow)).toBe(true);
      await shot('light-1280-options');
      await page.getByRole('option', { name: new RegExp(`^${t.audio_quiet}`) }).click();
      await uiExpect(vad()).toHaveAttribute('aria-checked', 'true');
      await uiExpect(trigger()).toHaveText(t.audio_quiet);
      await uiExpect(page.getByTestId('studio-transcription-audio-hint')).toHaveText(t.audio_quiet_hint);
      await shot('light-1280-quiet');
      // Turning detection off returns to standard and says why, in place.
      await vad().click();
      await uiExpect(trigger()).toHaveText(t.audio_standard);
      await uiExpect(page.getByTestId('studio-transcription-audio-reset')).toHaveText(t.audio_reset);
      evidence.resetLight1280 = await geometry(page);
      await shot('light-1280-reset');
      await choose(t.audio_noisy);
      await uiExpect(vad()).toHaveAttribute('aria-checked', 'true');
      await uiExpect(page.getByTestId('studio-transcription-audio-reset')).toHaveCount(0);
      // The submitted request and the task row carry the choice; a standard task shows no label.
      const files = ['01-noisy-pv.wav', '02-standard.wav'].map(name => path.join(fixture.artifacts, name));
      await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
      await drop(page, [files[0]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      await uiExpect(page.getByTestId('studio-transcription-task-row')).toHaveCount(1);
      await choose(t.audio_standard);
      await drop(page, [files[1]]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      await uiExpect(page.getByTestId('studio-transcription-task-row')).toHaveCount(2);
      const snapshot = await control(app, { operation: 'snapshot' });
      const enqueued = snapshot.traces.filter(item => item.operation === 'enqueue').map(item => item.detail.config);
      expect(enqueued.map(config => [config.vadEnabled, config.advanced.audioProfile ?? null])).toEqual([[true, 'noisy_music_v1'], [true, null]]);
      expect(enqueued[1].advanced).not.toHaveProperty('audioProfile');
      expect(snapshot.tasks.map(task => task.audioProfile ?? null)).toEqual(['noisy_music_v1', null]);
      const rows = page.getByTestId('studio-transcription-task-row');
      await uiExpect(rows.nth(0).getByTestId('studio-transcription-task-audio-type')).toHaveText(t.audio_noisy_short);
      await uiExpect(rows.nth(1).getByTestId('studio-transcription-task-audio-type')).toHaveCount(0);
      const rowHeights = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      evidence.taskRowHeights = rowHeights;
      await rows.nth(0).getByTestId('studio-transcription-task-audio-type').hover();
      await uiExpect(page.getByRole('tooltip')).toContainText(t.audio_task_label.replace('{{name}}', t.audio_noisy));
      await rows.nth(0).scrollIntoViewIfNeeded();
      await shot('light-1280-task-label');
      await page.mouse.move(5, 5);
      await choose(t.audio_quiet);
      await size(1024, 700); await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      evidence.light1024 = await geometry(page);
      await shot('light-1024-quiet');
      await trigger().click(); evidence.optionsLight1024 = await options(page); await shot('light-1024-options'); await page.keyboard.press('Escape');
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1')!));
      expect(persisted.state.transcription.config).toMatchObject({ vadEnabled: true, advanced: { audioProfile: 'quiet_whisper_v1' } });
      // Reopened in dark mode: the choice is still there.
      await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await app.close(); app = undefined; ({ app, page } = await launch());
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready(page);
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await size(1280, 800); await openTranscription();
      await uiExpect(trigger()).toHaveText(t.audio_quiet); await uiExpect(vad()).toHaveAttribute('aria-checked', 'true');
      evidence.dark1280 = await geometry(page);
      await shot('dark-1280-quiet');
      await trigger().click(); evidence.optionsDark1280 = await options(page); await shot('dark-1280-options'); await page.keyboard.press('Escape');
      await vad().click(); await uiExpect(page.getByTestId('studio-transcription-audio-reset')).toBeVisible();
      await size(1024, 700); await page.getByTestId('studio-transcription-config').scrollIntoViewIfNeeded();
      evidence.dark1024 = await geometry(page);
      await shot('dark-1024-reset');
      await choose(t.audio_quiet);
      // English: the longest names and hints.
      await page.evaluate(() => { localStorage.setItem('lang', 'en'); }); await page.reload(); await ready(page);
      await size(1024, 700); await openTranscription(englishLocale.workspace_transcription);
      await uiExpect(trigger()).toHaveText(english.audio_quiet);
      evidence.english1024 = await geometry(page);
      await trigger().click(); evidence.optionsEnglish1024 = await options(page); await shot('dark-1024-english-options'); await page.keyboard.press('Escape');
      await shot('dark-1024-english');
      for (const key of ['light1280', 'light1024', 'dark1280', 'dark1024', 'english1024']) expect((evidence[key] as { noHorizontalOverflow: boolean }).noHorizontalOverflow, key).toBe(true);
      expect(pageErrors).toEqual([]);
      passed = true;
    } finally {
      if (!passed && app && page) {
        await shot('failure').catch(() => undefined);
        evidence.failureTraces = await control(app, { operation: 'snapshot' }).then(value => value.traces.map(item => item.operation)).catch(error => String(error));
        evidence.failureAlerts = await page?.evaluate(() => Array.from(document.querySelectorAll('[role=alert], [role=status]')).map(element => element.textContent)).catch(error => String(error));
      }
      await writeFile(path.join(fixture.artifacts, 'asrq02-result.json'), JSON.stringify({ outcome: passed ? 'passed' : 'failed', ...evidence, pageErrors }, null, 2));
      await writeFile(path.join(fixture.artifacts, 'asrq02-electron.log'), logs.join(''));
      try { await app?.close(); } finally { await fixture.cleanup(); }
    }
  }, 240000);
});
