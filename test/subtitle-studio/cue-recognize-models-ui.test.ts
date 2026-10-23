import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { createTestRun } from '../support/testRun';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

type Snapshot = { traces: Array<{ operation: string; detail?: Record<string, unknown> }> };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> =>
  app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
/** 130 lines on two pages; lines 2, 5, 8 and 120 are transcribed with low confidence, so the review flags them. */
const FLAGGED = [1, 4, 7, 119];
const PAGED = Array.from({ length: 130 }, (_, index) => ({ text: `第${index + 1}句のせりふです`, startMs: index * 2000, endMs: index * 2000 + 1500,
  confidence: FLAGGED.includes(index) ? 0.3 : 0.9 }));
const QUIET = ['ふふっ、聞こえる？', 'ちょっと、すべすべでしょ', 'おやすみなさい'].map((text, index) => ({ text, startMs: 2000 + index * 2500, endMs: 3500 + index * 2500, confidence: 0.9 }));

/** A tone WAV: about -24 dBFS, or `amplitude` for a quieter one. */
async function tone(file: string, seconds: number, rate: number, amplitude = 3000) {
  const samples = new Int16Array(rate * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * amplitude));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, rate, 1), new Uint8Array(samples.buffer)]));
  return file;
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('recognizing cues again with another model', () => {
  it('chooses an installed model, follows its profile, flags doubtful results and recognizes the review bar\'s cues across pages', async () => {
    const fixture = await buildTranscriptionUiApp('controlled', { mediaRuntime: true });
    const artifacts = await createTestRun(path.resolve('test-results/studio-cue-recognize-models'));
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio', 'documents'));
    // The media lives in the profile, which the fixture removes; only screenshots stay.
    const media = path.join(fixture.profile, 'media');
    const create = async (name: string, segments: typeof PAGED, durationMs: number, file: string) => repository.create(transcriptToDocument({ schemaVersion: 1,
      source: { displayName: name, durationMs }, model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cuda' }, detectedLanguage: 'ja',
      segments: segments.map((segment, index) => ({ id: `s${index}`, ...segment })) }, { newId: randomUUID }), undefined, await captureSourceInput(file));
    const paged = await create('Paged.wav', PAGED, 262_000, await tone(path.join(media, 'Paged.wav'), 262, 8000));
    // The same lines again, for the screenshots in the other sizes and themes.
    await create('Screens.wav', PAGED, 262_000, path.join(media, 'Paged.wav'));
    await create('Quiet.wav', QUIET, 10_000, await tone(path.join(media, 'Quiet.wav'), 10, 16000, 300));
    // Every line doubtful: more than one run takes.
    await create('Many.wav', PAGED.map(segment => ({ ...segment, confidence: 0.2 })), 262_000, path.join(media, 'Paged.wav'));
    // 600 short lines, one doubtful on each page of 100.
    await create('Spread.wav', Array.from({ length: 600 }, (_, index) => ({ text: `line ${index + 1}`, startMs: index * 400, endMs: index * 400 + 380,
      confidence: index % 100 === 49 ? 0.3 : 0.9 })), 262_000, path.join(media, 'Paged.wav'));
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const r = locale.cue_recognize, names = locale.transcription;
    const errors: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      const page: Page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15_000);
      const win = await app.browserWindow(page);
      await win.evaluate(window => window.webContents.setBackgroundThrottling(false));
      // The page's viewport is the target size; the frame is corrected by what the page reports.
      const size = async (width: number, height: number) => {
        await win.evaluate((window, [w, h]) => window.setSize(w, h), [width, height] as const);
        await page.waitForTimeout(300);
        const [innerW, innerH] = await page.evaluate(() => [innerWidth, innerHeight] as const);
        await win.evaluate((window, [w, h]) => window.setSize(w, h), [width * 2 - innerW, height * 2 - innerH] as const);
        await page.waitForFunction(([w, h]) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1, [width, height] as const);
      };
      const start = async (theme: 'light' | 'dark', lang = 'zh') => {
        await page.evaluate(([value, language]) => {
          localStorage.setItem('lang', language); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: value }, version: 0 }));
          location.hash = '/tools/subtitle/studio';
        }, [theme, lang] as const);
        await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      };
      const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr[data-cue-id]');
      const row = (number: number) => rows.filter({ has: page.locator('.studio-cue-number-text', { hasText: new RegExp(`^${number}$`) }) });
      // Found by what it holds rather than its title, which changes with the language.
      const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('studio-cue-recognize-result') });
      const items = dialog.getByTestId('studio-cue-recognize-item');
      const recognizeTraces = async () => (await control(app!, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'recognize').map(trace => trace.detail!);
      const open = async (name: string) => {
        await page.getByTestId('studio-library-row').filter({ hasText: name }).locator('button.studio-document').click();
        await uiExpect(page.locator('.studio-document-heading')).toContainText(name);
        await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');
      };
      const chooseModel = async (label: string) => {
        await dialog.getByTestId('studio-cue-recognize-model').click();
        await page.getByRole('option', { name: label }).click();
        // A closing select leaves the rest of the page hidden from assistive technology for a moment.
        await uiExpect(page.locator('[data-slot=select-content]')).toHaveCount(0);
      };
      const finish = async () => {
        await uiExpect(dialog.getByTestId('studio-cue-recognize-summary')).toBeVisible({ timeout: 10_000 });
      };
      const closeDialog = async () => {
        await page.mouse.move(4, 4, { steps: 3 }); await page.mouse.move(8, 8);
        await page.keyboard.press('Escape');
        await uiExpect(dialog).toBeHidden();
      };
      await size(1280, 800);
      await start('light');
      // The fixture runtime starts with the first transcription request.
      await page.evaluate(() => window.subtitleStudio.listTranscriptionResources({}));
      await control(app, { operation: 'catalog-models' });
      await control(app, { operation: 'resources-ready' });
      await open('Paged.wav');

      // The review bar hands every flagged cue to the dialog, those on the second page too.
      await page.getByTestId('studio-cue-toolbar-review').click();
      const bar = page.getByTestId('studio-cue-review');
      const batch = bar.getByTestId('studio-cue-review-recognize-filtered');
      await uiExpect(batch).toHaveAccessibleName(locale.cue_review.recognize_filtered.replace('{{count}}', '4'));
      await bar.screenshot({ path: path.join(artifacts, '00-review-bar-1280-light.png') });
      await batch.click();
      await uiExpect(dialog).toBeVisible();
      await uiExpect(items).toHaveCount(4);
      expect(await items.locator('.studio-cue-revision-number').allTextContents()).toEqual(['2', '5', '8', '120']);
      // No choice yet this session: the model its preserved transcript names (large-v3), not the transcription setting's.
      await uiExpect(dialog.getByTestId('studio-cue-recognize-model')).toHaveText(names.resource_name_best);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-model-hint')).toHaveCount(0);

      // Only installed models are offered; the recognize-only ones say so and what they suit.
      await dialog.getByTestId('studio-cue-recognize-model').click();
      const options = page.getByRole('option');
      expect(await options.allTextContents()).toHaveLength(5);
      const anime = page.getByRole('option', { name: names.resource_name_anime });
      await uiExpect(anime).toContainText(names.model_recognize_only);
      await uiExpect(anime).toContainText(names.model_experimental);
      await uiExpect(anime).toContainText(names.model_scenario_anime);
      await shot('01-models-1280-light');
      /** Rendered sizes of the parts this task adds, for design.md's measurements. */
      const measure = () => page.evaluate(() => {
        const box = (selector: string) => { const node = document.querySelector<HTMLElement>(selector); if (!node) return null;
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          return { width: Math.round(rect.width), height: Math.round(rect.height), font: `${style.fontSize}/${style.lineHeight}`, padding: style.padding, opacity: style.opacity, color: style.color }; };
        return { dialog: box('.studio-cue-recognize-dialog'), trigger: box('[data-testid=studio-cue-recognize-model]'), language: box('[data-testid=studio-cue-recognize-language]'),
          list: box('[data-testid=studio-cue-recognize-models]'), option: box('[data-slot=select-item]'), hint: box('[data-testid=studio-cue-recognize-model-hint]'),
          note: box('[data-testid=studio-cue-recognize-flagged]'), flag: box('[data-testid=studio-cue-recognize-flag]'),
          flaggedText: box('li[data-flagged]:not([data-accepted]) .studio-cue-revision-text'), flaggedTexts: box('li[data-flagged]:not([data-accepted]) .studio-cue-revision-texts'),
          batch: box('[data-testid=studio-cue-review-recognize-filtered]') };
      });
      const measurements: Record<string, unknown> = { models: await measure() };
      await anime.click();
      await uiExpect(page.locator('[data-slot=select-content]')).toHaveCount(0);
      // anime-whisper: Japanese only and no prompt, with the reasons and how to use it.
      await uiExpect(dialog.getByTestId('studio-cue-recognize-language')).toHaveText(names.language_ja);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-prompt')).toBeDisabled();
      const hint = dialog.getByTestId('studio-cue-recognize-model-hint');
      await uiExpect(hint).toContainText(r.recognize_only_hint);
      await uiExpect(hint).toContainText(names.model_language_locked.replace('{{languages}}', names.language_ja));
      await uiExpect(hint).toContainText(names.model_prompt_forbidden);

      // Two results are doubtful: they are marked, explained and left unchosen.
      await control(app, { operation: 'recognitions', delayMs: 400, recognitions: [{ text: '第2句のせりふですね' },
        { text: '第5句のせりふ', segments: [{ startMs: 0, endMs: 1900, text: '第5句のせりふ', averageLogProbability: -1.3 }] },
        { text: 'ご視聴ありがとうございました' }, { text: '第120句のせりふですよ' }] });
      await dialog.getByTestId('studio-cue-recognize-start').click();
      // The first cue with another model waits for it to load.
      await uiExpect(dialog.getByTestId('studio-cue-recognize-progress')).toContainText(r.loading_model.replace('{{done}}', '1').replace('{{total}}', '4'));
      await finish();
      await uiExpect(items.nth(0)).toHaveAttribute('data-accepted', 'true');
      await uiExpect(items.nth(1)).toHaveAttribute('data-flagged', '');
      await uiExpect(items.nth(1)).not.toHaveAttribute('data-accepted');
      await uiExpect(items.nth(1).getByTestId('studio-cue-recognize-flag')).toHaveText(locale.cue_review.reasons.low_confidence);
      await uiExpect(items.nth(2).getByTestId('studio-cue-recognize-flag')).toHaveText(locale.cue_review.reasons.phantom_phrase);
      await uiExpect(items.nth(2)).not.toHaveAttribute('data-accepted');
      await uiExpect(items.nth(3)).toHaveAttribute('data-accepted', 'true');
      await uiExpect(dialog.getByTestId('studio-cue-recognize-flagged')).toHaveText(r.flagged.replace('{{count}}', '2'));
      await uiExpect(dialog.getByTestId('studio-cue-recognize-apply')).toHaveText('应用 2 条');
      const sent = (await recognizeTraces()).slice(-4);
      // Text only, in Japanese, without the prompt; 1.5 s cues plus 0.2 s on each side, never gained here.
      expect(sent.map(detail => detail.modelId)).toEqual(Array(4).fill('anime-whisper-q8_0'));
      for (const detail of sent) expect(detail).toMatchObject({ language: 'ja', initialPrompt: null, noTimestamps: true, vadSpeechPadMs: null, bytes: 44 + 1.9 * 32000 });
      await items.nth(1).getByTestId('studio-cue-recognize-flag').hover();
      await uiExpect(page.locator('.studio-cue-review-tip')).toContainText(locale.cue_review.details.low_confidence.replace('{{confidence}}', '0.27'));
      await shot('02-results-1280-light');
      measurements.results = await measure();
      // The tooltip stays below line 5's text, its deletion mark included.
      measurements.tip = await page.evaluate(() => {
        const tip = document.querySelector('.studio-cue-review-tip')!.getBoundingClientRect();
        const text = document.querySelector('li[data-flagged] .studio-cue-revision-text')!.getBoundingClientRect();
        const flag = document.querySelector('li[data-flagged] [data-testid=studio-cue-recognize-flag]')!.getBoundingClientRect();
        return { textBottom: Math.round(text.bottom), flagLeft: Math.round(flag.left), flagBottom: Math.round(flag.bottom), tipLeft: Math.round(tip.left), tipTop: Math.round(tip.top) };
      });
      expect((measurements.tip as { tipTop: number }).tipTop).toBeGreaterThan((measurements.tip as { textBottom: number }).textBottom);
      await writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2));

      // Choosing a doubtful result is the user's call; the chosen ones replace their cues on both pages and undo as one edit.
      await items.nth(1).getByRole('checkbox').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-apply')).toHaveText('应用 3 条');
      await dialog.getByTestId('studio-cue-recognize-apply').click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：重新识别 3 条字幕');
      const saved = await repository.read(paged.id);
      expect([1, 4, 7, 119].map(index => saved.cues[index].source.plain)).toEqual(['第2句のせりふですね', '第5句のせりふ', '第8句のせりふです', '第120句のせりふですよ']);
      await bar.getByTestId('studio-cue-review-close').click();

      // A model with timestamps hears a second on each side; only the segment over the cue makes the result.
      await row(3).locator('.studio-cue-time').click();
      await row(3).locator('.studio-cue-time').click({ button: 'right' });
      await page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-recognize-menu').click();
      await uiExpect(dialog).toBeVisible();
      // The last choice is kept for the session.
      await uiExpect(dialog.getByTestId('studio-cue-recognize-model')).toHaveText(names.resource_name_anime);
      await chooseModel(names.resource_name_best);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-prompt')).toBeEnabled();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-model-hint')).toHaveCount(0);
      await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ text: '第2句。第3句のせりふです！第4句', segments: [
        { startMs: 0, endMs: 900, text: '第2句。' }, { startMs: 1000, endMs: 2500, text: '第3句のせりふです！' }, { startMs: 2600, endMs: 3500, text: '第4句' }] }] });
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await finish();
      await uiExpect(items.nth(0).locator('[data-field=source]')).toHaveText('第3句のせりふです！');
      await uiExpect(items.nth(0).locator('ins')).toHaveText('！');
      // Line 3 is 4.0–5.5 s: the clip is 3.0–6.5 s.
      expect((await recognizeTraces()).at(-1)).toMatchObject({ modelId: 'large-v3', language: 'auto', noTimestamps: false, vadSpeechPadMs: null, bytes: 44 + 3.5 * 32000 });
      // One segment over line 3 and line 2 before it cannot be split: line 3 is heard again with only its padding, 3.8–5.7 s.
      await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ text: '第2句のせりふです第3句のせりふです',
        segments: [{ startMs: 0, endMs: 2500, text: '第2句のせりふです第3句のせりふです' }] }, { text: '第3句のせりふですね' }] });
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await uiExpect(items.nth(0).locator('[data-field=source]')).toHaveText('第3句のせりふですね');
      await finish();
      expect((await recognizeTraces()).slice(-2).map(detail => detail.bytes)).toEqual([44 + 3.5 * 32000, 44 + 1.9 * 32000]);
      await uiExpect(items.nth(0)).toHaveAttribute('data-accepted', 'true');
      await closeDialog();

      // A quiet clip is gained in the main process and sent with voice padding.
      await open('Quiet.wav');
      await row(2).locator('.studio-cue-time').click();
      await row(2).locator('.studio-cue-time').click({ button: 'right' });
      await page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-recognize-menu').click();
      await uiExpect(dialog).toBeVisible();
      await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ text: 'ちょっと、すべすべでしょ？' }] });
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await finish();
      expect((await recognizeTraces()).at(-1)).toMatchObject({ modelId: 'large-v3', vadSpeechPadMs: 1000, noTimestamps: false });
      await closeDialog();

      // Busy: a transcription with another load keeps the server; the dialog says so and stops.
      await row(1).locator('.studio-cue-time').click();
      await row(3).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
      await row(1).locator('.studio-cue-time').click({ button: 'right' });
      await page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-recognize-menu').click();
      await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ error: 'resource_busy' }, { text: 'x' }] });
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await finish();
      await uiExpect(items.nth(0).getByTestId('studio-cue-recognize-error')).toHaveText(r.errors.resource_busy);
      await uiExpect(items.nth(1)).toHaveAttribute('data-state', 'waiting');
      await closeDialog();

      // The review bar hands over every flagged line; the dialog takes the first 100, as from a selection.
      await open('Many.wav');
      await page.getByTestId('studio-cue-toolbar-review').click();
      await uiExpect(bar.getByTestId('studio-cue-review-recognize-filtered')).toHaveAccessibleName(locale.cue_review.recognize_filtered.replace('{{count}}', '130'));
      await bar.getByTestId('studio-cue-review-recognize-filtered').click();
      await uiExpect(items).toHaveCount(100);
      await uiExpect(dialog.getByText(r.limited.replace('{{limit}}', '100'))).toBeVisible();
      expect(await items.locator('.studio-cue-revision-number').last().textContent()).toBe('100');
      await closeDialog();
      await bar.getByTestId('studio-cue-review-close').click();

      // Flagged lines on six pages: the other five are read a few at a time, and one that cannot be read is named, not dropped silently.
      await open('Spread.wav');
      await page.getByTestId('studio-cue-toolbar-review').click();
      await uiExpect(bar.getByTestId('studio-cue-review-recognize-filtered')).toHaveAccessibleName(locale.cue_review.recognize_filtered.replace('{{count}}', '6'));
      await app.evaluate(({ ipcMain }) => {
        // The window sends its capability with each request.
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, input: { payload: { offset: number } }) => unknown> })._invokeHandlers;
        const channel = 'subtitle-studio:read-page', handler = handlers.get(channel)!;
        const reads = (globalThis as any).__pageReads = { open: 0, most: 0, offsets: [] as number[] };
        handlers.set(channel, async (event, input) => {
          reads.offsets.push(input.payload.offset); reads.most = Math.max(reads.most, ++reads.open);
          try {
            await new Promise(resolve => setTimeout(resolve, 150));
            return input.payload.offset === 300 ? { ok: false, error: 'revision_conflict' } : await handler(event, input);
          } finally { reads.open--; }
        });
        (globalThis as any).__restorePageReads = () => handlers.set(channel, handler);
      });
      await bar.getByTestId('studio-cue-review-recognize-filtered').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-unread')).toHaveText(r.unread.replace('{{count}}', '1'));
      expect(await items.locator('.studio-cue-revision-number').allTextContents()).toEqual(['50', '150', '250', '450', '550']);
      const reads = await app.evaluate(() => { (globalThis as any).__restorePageReads(); return (globalThis as any).__pageReads as { most: number; offsets: number[] }; });
      expect([...reads.offsets].sort((a, b) => a - b)).toEqual([100, 200, 300, 400, 500]);
      expect(reads.most).toBe(4);
      await shot('04-unread-1280-light');
      await closeDialog();
      await bar.getByTestId('studio-cue-review-close').click();

      // The other sizes and themes, and the longer English text.
      const english = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8'));
      for (const [width, height, theme, lang] of [[1024, 700, 'light', 'zh'], [1024, 700, 'dark', 'zh'], [1280, 800, 'dark', 'zh'], [1024, 700, 'light', 'en']] as const) {
        await size(width, height);
        await start(theme, lang);
        await open('Screens.wav');
        await page.getByTestId('studio-cue-toolbar-review').click();
        const reviewBar = page.getByTestId('studio-cue-review');
        await uiExpect(reviewBar.getByTestId('studio-cue-review-count')).not.toHaveText((lang === 'en' ? english : locale).cue_review.loading);
        await reviewBar.screenshot({ path: path.join(artifacts, `00-review-bar-${width}-${theme}${lang === 'en' ? '-en' : ''}.png`) });
        await reviewBar.getByTestId('studio-cue-review-recognize-filtered').click();
        await uiExpect(items).toHaveCount(4);
        await chooseModel((lang === 'en' ? english : locale).transcription.resource_name_anime);
        await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ text: '第2句のせりふですね' },
          { text: '第5句のせりふ', segments: [{ startMs: 0, endMs: 1900, text: '第5句のせりふ', averageLogProbability: -1.3 }] },
          { text: 'ご視聴ありがとうございました' }, { text: '第120句のせりふですよ' }] });
        await dialog.getByTestId('studio-cue-recognize-start').click();
        await finish();
        await uiExpect(dialog.getByTestId('studio-cue-recognize-flagged')).toBeVisible();
        // The flag's tooltip opens below it, clear of the result it explains.
        await items.nth(1).getByTestId('studio-cue-recognize-flag').hover();
        await uiExpect(page.locator('.studio-cue-review-tip')).toBeVisible();
        await shot(`03-results-${width}-${theme}${lang === 'en' ? '-en' : ''}`);
        // Escape would close the tooltip first.
        await page.mouse.move(4, 4, { steps: 3 });
        await uiExpect(page.locator('.studio-cue-review-tip')).toHaveCount(0);
        await closeDialog();
        await reviewBar.getByTestId('studio-cue-review-close').click();
      }
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); await fixture.cleanup(); }
  }, 300_000);
});
