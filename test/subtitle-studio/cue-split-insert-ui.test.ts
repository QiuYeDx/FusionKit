import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';

async function tone(file: string, seconds: number) {
  const samples = new Int16Array(8000 * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / 8000) * 2000));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, 8000, 1), new Uint8Array(samples.buffer)]));
  return file;
}
/** Moves on a little after landing, as a real pointer does, so a Radix tooltip is left behind. */
async function leaveTo(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 3 });
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('splitting and inserting cues', () => {
  it('splits a cue where the text is clicked, at the word time, inserts a cue in a gap, and undoes both', async () => {
    const artifacts = path.resolve('test-results/studio-cue-split-insert'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const media = await tone(path.join(root, 'media', 'Talk.wav'), 12);
    const doc = transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Talk.wav', durationMs: 12000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
      segments: [
        { id: 's0', startMs: 1000, endMs: 4000, text: 'Hello there world', words: [{ text: ' Hello', startMs: 1000, endMs: 1500 }, { text: ' there', startMs: 1600, endMs: 2400 }, { text: ' world', startMs: 2600, endMs: 4000 }] },
        { id: 's1', startMs: 5000, endMs: 6000, text: 'Again' },
        { id: 's2', startMs: 8000, endMs: 9000, text: 'Done here' }] }, { newId: randomUUID });
    doc.translationTracks.push({ id: randomUUID(), language: 'zh', revision: 1, origin: 'ai',
      entries: { [doc.cues[0].id]: { sourceRevision: 1, sourceHash: sourceDigest(doc.cues[0]), text: { plain: '你好，那边的世界', spans: [{ text: '你好，那边的世界', marks: [] }] }, origin: 'ai', reviewStatus: 'unreviewed' } } });
    await new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents')).create(doc, undefined, await captureSourceInput(media));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      // Records what the window asks the main process to play.
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, input: unknown) => unknown> })._invokeHandlers;
        const channel = 'subtitle-studio:read-cue-audio', handler = handlers.get(channel)!;
        (globalThis as any).__played = [];
        handlers.set(channel, (event, input) => { (globalThis as any).__played.push((input as { payload: unknown }).payload); return handler(event, input); });
      });
      const played = () => app!.evaluate(() => (globalThis as any).__played as Array<{ target: unknown }>);
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const source = (index: number) => rows.nth(index).locator('[data-field=source]');
      const menu = async (index: number, item: string) => {
        await rows.nth(index).locator('.studio-cue-time').click({ button: 'right' });
        await page.getByTestId('studio-cue-context-menu').getByTestId(item).click();
      };
      const split = page.getByRole('dialog', { name: '拆分字幕' });
      const insert = page.getByRole('dialog', { name: '插入字幕' });
      const close = async (dialog: Locator) => { await leaveTo(page, dialog.getByRole('heading')); await page.keyboard.press('Escape'); await uiExpect(dialog).toBeHidden(); };
      await page.getByTestId('studio-library-row').filter({ hasText: 'Talk.wav' }).locator('button.studio-document').click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');
      await uiExpect(rows).toHaveCount(3);

      // Split: the default place is after the space nearest the middle, at the next word's time.
      await rows.nth(0).locator('.studio-cue-time').click();
      await menu(0, 'studio-cue-split');
      await uiExpect(split).toBeVisible();
      const time = split.getByTestId('studio-cue-split-time');
      const parts = split.getByTestId('studio-cue-split-part');
      await uiExpect(time).toHaveValue('00:00:01.600');
      await uiExpect(split.getByTestId('studio-cue-split-basis')).toHaveText('按字词时间');
      await uiExpect(parts.nth(0)).toContainText('Hello');
      await uiExpect(parts.nth(1)).toContainText('there world');
      // Moving the caret five characters from the end splits before "world", at its time.
      const text = split.getByTestId('studio-cue-split-source');
      await text.focus(); await page.keyboard.press('End');
      for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowLeft');
      await uiExpect(time).toHaveValue('00:00:02.600');
      // The text itself cannot be changed here.
      await page.keyboard.type('x'); await page.keyboard.press('Backspace');
      await uiExpect(text).toHaveValue('Hello there world');
      await uiExpect(parts.nth(1)).toContainText('00:00:02.600 → 00:00:04.000');
      await uiExpect(parts.nth(1)).toContainText('world');
      await parts.nth(1).getByTestId('studio-cue-split-play').click();
      await uiExpect.poll(async () => (await played()).at(-1)?.target).toEqual({ range: { startMs: 2600, endMs: 4000 } });
      // A time outside the cue cannot be used.
      await time.fill('00:00:05.000');
      await uiExpect(split.getByTestId('studio-cue-split-problem')).toHaveText('拆分时刻需在这条字幕的开始与结束之间。');
      await uiExpect(split.getByTestId('studio-cue-split-apply')).toBeDisabled();
      await time.fill('00:00:02.600');
      // The translation is split too by default; keeping it on the first part instead.
      await uiExpect(split.getByTestId('studio-cue-split-target')).toBeVisible();
      await shot('studio-cue-split-insert--01-split-1280-light');
      await split.getByTestId('studio-cue-split-target-toggle').click();
      await uiExpect(split).toContainText('译文留在第一条');
      await split.getByTestId('studio-cue-split-apply').click();
      await uiExpect(split).toBeHidden();
      await uiExpect(rows).toHaveCount(4);
      await uiExpect(source(0)).toHaveText('Hello there');
      await uiExpect(source(1)).toHaveText('world');
      await uiExpect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：拆分字幕');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows).toHaveCount(3);
      await uiExpect(source(0)).toHaveText('Hello there world');

      // Insert after "Again": the gap up to the next cue, at most two seconds.
      await menu(1, 'studio-cue-insert-after');
      await uiExpect(insert).toBeVisible();
      await uiExpect(insert.getByTestId('studio-cue-insert-start')).toHaveValue('00:00:06.000');
      await uiExpect(insert.getByTestId('studio-cue-insert-end')).toHaveValue('00:00:08.000');
      await uiExpect(insert.getByTestId('studio-cue-insert-apply')).toBeDisabled();
      await insert.getByTestId('studio-cue-insert-source').fill('补上的一句');
      await insert.getByTestId('studio-cue-insert-start').fill('00:00:08.500');
      await uiExpect(insert.getByTestId('studio-cue-insert-problem')).toBeVisible();
      await uiExpect(insert.getByTestId('studio-cue-insert-apply')).toBeDisabled();
      await insert.getByTestId('studio-cue-insert-start').fill('00:00:06.000');
      await insert.getByTestId('studio-cue-insert-play').click();
      await uiExpect.poll(async () => (await played()).at(-1)?.target).toEqual({ range: { startMs: 6000, endMs: 8000 } });
      await insert.getByTestId('studio-cue-insert-apply').click();
      await uiExpect(insert).toBeHidden();
      await uiExpect(rows).toHaveCount(4);
      await uiExpect(source(2)).toHaveText('补上的一句');
      await uiExpect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：插入字幕');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows).toHaveCount(3);
      // Undoing an insertion is not reported as a deletion to undo.
      await uiExpect(page.getByText('已删除 1 条字幕')).toHaveCount(0);

      // Several selected: splitting needs one cue.
      await rows.nth(0).locator('.studio-cue-time').click();
      await rows.nth(1).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
      await rows.nth(0).locator('.studio-cue-time').click({ button: 'right' });
      await uiExpect(page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-split')).toHaveAttribute('data-disabled', '');
      await page.keyboard.press('Escape');

      // Narrow and dark.
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await rows.nth(0).locator('.studio-cue-time').click();
      await menu(0, 'studio-cue-insert-before');
      await uiExpect(insert).toBeVisible();
      await uiExpect(insert.getByTestId('studio-cue-insert-start')).toHaveValue('00:00:00.000');
      await uiExpect(insert.getByTestId('studio-cue-insert-end')).toHaveValue('00:00:01.000');
      await insert.getByTestId('studio-cue-insert-source').fill('A much longer line that is added before the first cue, to see how the text box wraps it in a narrow window');
      await shot('studio-cue-split-insert--02-insert-786-dark');
      await close(insert);
      await menu(0, 'studio-cue-split');
      await uiExpect(split).toBeVisible();
      // The split was undone: the cue again matches the transcript, so its word times apply.
      await uiExpect(split.getByTestId('studio-cue-split-basis')).toHaveText('按字词时间');
      await shot('studio-cue-split-insert--03-split-786-dark');
      await close(split);
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 180_000);
});
