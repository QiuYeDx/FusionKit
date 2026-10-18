import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const LINES = ['先輩、おはようございます。', 'って、もう眠そうじゃないですか。', 'まだ朝なのに。', 'ん?なんですか?', '君は白鸽だから?'];
type Snapshot = { traces: Array<{ operation: string; detail?: Record<string, unknown> }> };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> =>
  app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
async function tone(file: string, seconds: number) {
  const samples = new Int16Array(48000 * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 3000));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, 48000, 1), new Uint8Array(samples.buffer)]));
  return file;
}
/** Moves on a little after landing, as a real pointer does, so a Radix tooltip is left behind. */
async function leaveTo(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 3 });
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('recognizing cues again', () => {
  it('recognizes selected cues with a local model, compares them, applies the chosen ones and undoes them', async () => {
    const fixture = await buildTranscriptionUiApp('controlled', { mediaRuntime: true });
    const artifacts = path.resolve('test-results/studio-cue-recognize'); await mkdir(artifacts, { recursive: true });
    const media = await tone(path.join(fixture.artifacts, 'media', 'Meeting.wav'), 16);
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio', 'documents'));
    await repository.create(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Meeting.wav', durationMs: 16000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3-q5_0', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: LINES.map((text, index) => ({ id: `s${index}`, startMs: index * 3000, endMs: index * 3000 + 2000, text })) }, { newId: randomUUID }),
      undefined, await captureSourceInput(media));
    const notes = path.join(fixture.artifacts, 'notes', 'Notes.srt');
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, '1\n00:00:01,000 --> 00:00:02,000\nA note without media\n');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const source = (index: number) => rows.nth(index).locator('[data-field=source]');
      const dialog = page.getByRole('dialog', { name: locale.cue_recognize.title });
      const items = dialog.getByTestId('studio-cue-recognize-item');
      const openFor = async (from: number, to: number) => {
        await rows.nth(from).locator('.studio-cue-time').click();
        await rows.nth(to).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
        await rows.nth(from).locator('.studio-cue-time').click({ button: 'right' });
        await page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-recognize-menu').click();
        await uiExpect(dialog).toBeVisible();
      };
      const closeDialog = async () => {
        await leaveTo(page, dialog.getByRole('heading'));
        await page.keyboard.press('Escape');
        await uiExpect(dialog).toBeHidden();
      };
      await page.getByTestId('studio-library-row').filter({ hasText: 'Meeting.wav' }).locator('button.studio-document').click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');

      // No model installed: the dialog says so and offers to install one.
      await openFor(0, 2);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-no-model')).toContainText(locale.cue_recognize.no_model_hint);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-start')).toBeDisabled();
      await uiExpect(items).toHaveCount(3);
      await closeDialog();

      // With the model: three cues change, one is heard the same, one fails; the prompt and a 16 kHz clip reach the model.
      await control(app, { operation: 'resources-ready' });
      const heard = ['先輩、おはようございます！', 'って、もう眠そうじゃないですか？', 'ん？なんですか？'];
      await control(app, { operation: 'recognitions', delayMs: 400,
        recognitions: [{ text: heard[0] }, { text: heard[1] }, { text: LINES[2] }, { text: heard[2] }, { error: 'limit_exceeded' }] });
      await openFor(0, 4);
      // The defaults come from the transcription settings; the model has its plain name.
      await uiExpect(dialog.getByTestId('studio-cue-recognize-model')).toContainText(locale.transcription.resource_name_standard);
      await uiExpect(dialog.getByTestId('studio-cue-recognize-language')).toContainText('自动识别');
      await dialog.getByTestId('studio-cue-recognize-prompt').fill('先輩');
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-progress')).toContainText('正在识别 1 / 5');
      // Each cue takes 0.4 s here, shorter than the assertion's backed-off polling: watch every frame.
      await page.waitForFunction(() => document.querySelector('[data-testid=studio-cue-recognize-progress]')?.textContent?.includes('5 / 5'), undefined, { polling: 'raf', timeout: 8000 });
      await uiExpect(dialog.getByTestId('studio-cue-recognize-summary')).toHaveText('已识别 5 条，其中 3 条与原文不同', { timeout: 8000 });
      await uiExpect(items.nth(0)).toHaveAttribute('data-accepted', 'true');
      await uiExpect(items.nth(0).locator('ins')).toHaveText('！');
      await uiExpect(items.nth(2)).toContainText(locale.cue_recognize.same);
      await uiExpect(items.nth(4).getByTestId('studio-cue-recognize-error')).toHaveText(locale.cue_recognize.errors.limit_exceeded);
      const traces = (await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'recognize');
      expect(traces.at(-5)?.detail).toMatchObject({ modelId: 'large-v3-q5_0', language: 'auto', initialPrompt: '先輩', sampleRate: 16000 });
      // The first cue starts at 0 s, so it is padded by 0.2 s after only: 2.2 s at 16 kHz, 16-bit mono.
      expect(traces.at(-5)?.detail?.bytes).toBe(44 + 2.2 * 32000);
      // Later cues are padded on both sides: 2.4 s.
      expect(traces.at(-4)?.detail?.bytes).toBe(44 + 2.4 * 32000);
      await shot('studio-cue-recognize--01-results-1280-light');

      // Leaving one result out applies the other two only, and they undo as one edit.
      await items.nth(3).getByRole('checkbox').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-apply')).toHaveText('应用 2 条');
      await dialog.getByTestId('studio-cue-recognize-apply').click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(source(0)).toHaveText(heard[0]);
      await uiExpect(source(1)).toHaveText(heard[1]);
      await uiExpect(source(3)).toHaveText(LINES[3]);
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：重新识别 2 条字幕');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(source(0)).toHaveText(LINES[0]);
      await uiExpect(source(1)).toHaveText(LINES[1]);

      // Stopping keeps what was recognized; the rest stays as it was.
      await control(app, { operation: 'recognitions', delayMs: 1200, recognitions: [{ text: 'まだ朝なのに！' }, { text: 'x' }, { text: 'y' }] });
      await openFor(2, 4);
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await uiExpect(items.nth(0)).toHaveAttribute('data-state', 'done', { timeout: 5000 });
      await dialog.getByTestId('studio-cue-recognize-stop').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-summary')).toBeVisible({ timeout: 5000 });
      await uiExpect(items.nth(2)).toHaveAttribute('data-state', 'waiting');
      await uiExpect(dialog.getByTestId('studio-cue-recognize-apply')).toHaveText('应用 1 条');
      await closeDialog();

      // Closing the dialog while recognizing stops it: no later cue reaches the model.
      await control(app, { operation: 'recognitions', delayMs: 1200, recognitions: [] });
      const before = (await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'recognize').length;
      await openFor(0, 2);
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await uiExpect(items.nth(0)).toHaveAttribute('data-state', 'running');
      await closeDialog();
      await page.waitForTimeout(2000);
      expect((await control(app, { operation: 'snapshot' })).traces.filter(trace => trace.operation === 'recognize').length).toBe(before + 1);

      // Narrow and dark.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await control(app, { operation: 'recognitions', delayMs: 0, recognitions: [{ text: 'って、もう眠そうじゃないですか？ほんとに眠そうですよ、先輩。' }, { text: '' }] });
      await openFor(1, 2);
      await dialog.getByTestId('studio-cue-recognize-start').click();
      await uiExpect(dialog.getByTestId('studio-cue-recognize-summary')).toBeVisible({ timeout: 5000 });
      await uiExpect(items.nth(1)).toContainText(locale.cue_recognize.empty);
      await shot('studio-cue-recognize--02-results-786-dark');
      await closeDialog();

      // A document without media cannot be recognized.
      await app.evaluate(({ dialog: native }, input) => { native.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, notes);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).first().click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'missing');
      await rows.nth(0).locator('.studio-cue-time').click({ button: 'right' });
      await uiExpect(page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-recognize-menu')).toHaveAttribute('data-disabled', '');
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); await fixture.cleanup(); }
  }, 180_000);
});
