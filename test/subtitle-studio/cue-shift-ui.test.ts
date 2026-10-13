import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';
import { createTestRun } from '../support/testRun';

const LINES = 250;
/** A quiet tone at 8 kHz, long enough for every line; the app is muted under test. */
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

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('shifting the whole document', () => {
  it('shifts every page or from one line, nudges, plays the shifted line, explains refusals and undoes', async () => {
    const artifacts = path.resolve('test-results/studio-cue-shift'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    const profile = path.join(root, 'profile');
    const media = await tone(path.join(root, 'media', 'Episode.wav'), 110);
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    // Line n starts at (n − 1) × 0.4 s and lasts 0.3 s.
    await repository.create(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Episode.wav', durationMs: 110_000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: Array.from({ length: LINES }, (_, index) => ({ id: `s${index}`, startMs: index * 400, endMs: index * 400 + 300, text: `第 ${index + 1} 句。` })) }, { newId: randomUUID }),
      undefined, await captureSourceInput(media));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const played = () => app!.evaluate(() => ((globalThis as any).__played as Array<{ payload: { target: unknown } }>).map(call => call.payload));
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      // Records what the window asks the main process to play (Studio has registered its handlers by now).
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, input: unknown) => unknown> })._invokeHandlers;
        const channel = 'subtitle-studio:read-cue-audio', handler = handlers.get(channel)!;
        (globalThis as any).__played = [];
        handlers.set(channel, (event, input) => { (globalThis as any).__played.push(input); return handler(event, input); });
      });
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const list = page.getByTestId('studio-cue-list');
      const start = (index: number) => rows.nth(index).locator('.studio-time-range > span').first();
      const dialog = page.getByRole('dialog', { name: '平移时间' });
      const delta = dialog.getByTestId('studio-cue-shift-delta');
      const preview = dialog.getByTestId('studio-cue-shift-preview');
      const apply = dialog.getByTestId('studio-cue-shift-apply');
      const listen = dialog.getByTestId('studio-cue-shift-listen');
      const footer = page.locator('.studio-reader-footer');
      const close = async () => { await leaveTo(page, dialog.getByRole('heading')); await page.keyboard.press('Escape'); await uiExpect(dialog).toBeHidden(); };
      const fromMenu = async (index: number) => {
        await rows.nth(index).click({ button: 'right' });
        await page.getByTestId('studio-cue-context-menu').getByRole('menuitem', { name: '平移时间…' }).click();
        await uiExpect(dialog).toBeVisible();
      };
      await page.getByTestId('studio-library-row').filter({ hasText: 'Episode.wav' }).locator('button.studio-document').click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');
      await uiExpect(rows).toHaveCount(100);

      // Ctrl+A selects this page; shifting it means the whole document.
      await rows.nth(0).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press('Control+a');
      await fromMenu(0);
      await uiExpect(dialog.getByRole('radio', { name: '整篇（共 250 条）' })).toBeChecked();
      // Line 1 is selected first: from it to the end is the whole document, so it is not offered.
      await uiExpect(dialog.getByRole('radio')).toHaveCount(2);
      await delta.fill('1500');
      await uiExpect(preview).toHaveText('第 1 条从 00:00:00.000 移到 00:00:01.500，共 250 条。');
      // The line is heard where it will be.
      await listen.click();
      await uiExpect.poll(async () => (await played()).at(-1)?.target).toEqual({ range: { startMs: 1500, endMs: 1800 } });
      await uiExpect(listen).toHaveAttribute('data-state', 'idle', { timeout: 8000 });
      await dialog.getByTestId('studio-cue-shift-step-100').click();
      await uiExpect(delta).toHaveValue('1600');
      await uiExpect(preview).toHaveText('第 1 条从 00:00:00.000 移到 00:00:01.600，共 250 条。');
      await listen.click();
      await uiExpect.poll(async () => (await played()).at(-1)?.target).toEqual({ range: { startMs: 1600, endMs: 1900 } });
      await shot('studio-cue-shift--01-whole-1280-light');
      await apply.click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(start(0)).toHaveText('00:00:01.600');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：平移 250 条字幕的时间');
      // Lines on the last page moved too.
      await footer.getByRole('button', { name: '下一页', exact: true }).click();
      await footer.getByRole('button', { name: '下一页', exact: true }).click();
      await uiExpect(start(0)).toHaveText('00:01:21.600');
      await list.focus();
      await page.keyboard.press('Control+z');
      await uiExpect(start(0)).toHaveText('00:01:20.000');

      // Without a selection the toolbar shifts the whole document; the steps nudge, and a start before 0 is refused.
      await page.getByTestId('studio-cue-toolbar-shift').click();
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog.getByRole('radiogroup')).toHaveCount(0);
      await dialog.getByTestId('studio-cue-shift-step-1000').click();
      await dialog.getByTestId('studio-cue-shift-step--100').click();
      await uiExpect(delta).toHaveValue('900');
      await dialog.getByTestId('studio-cue-shift-step--1000').click();
      await uiExpect(delta).toHaveValue('-100');
      await uiExpect(preview).toHaveText('移动后开始时间会小于 0');
      await uiExpect(apply).toBeDisabled();
      await close();

      // From line 120 to the end: 131 lines, and not before line 119.
      await footer.getByRole('button', { name: '上一页', exact: true }).click();
      await uiExpect(start(19)).toHaveText('00:00:47.600');
      await rows.nth(19).locator('.studio-cue-time').click();
      await fromMenu(19);
      await uiExpect(dialog.getByRole('radio', { name: '所选 1 条' })).toBeChecked();
      await dialog.getByRole('radio', { name: '从第 120 条到结尾' }).click();
      await delta.fill('-401');
      await uiExpect(preview).toHaveText('移动后会早于上一条字幕');
      await uiExpect(apply).toBeDisabled();
      await delta.fill('-400');
      await uiExpect(preview).toHaveText('第 120 条从 00:00:47.600 移到 00:00:47.200，共 131 条。');
      await shot('studio-cue-shift--02-from-1280-light');
      await apply.click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(start(19)).toHaveText('00:00:47.200');
      await uiExpect(start(18)).toHaveText('00:00:47.200');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：平移 131 条字幕的时间');
      await list.focus();
      await page.keyboard.press('Control+z');
      await uiExpect(start(19)).toHaveText('00:00:47.600');

      // Narrow and dark.
      await page.keyboard.press('Escape');
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await rows.nth(19).locator('.studio-cue-time').click();
      await fromMenu(19);
      await delta.fill('-250');
      await uiExpect(preview).toHaveText('第 120 条从 00:00:47.600 移到 00:00:47.350，共 1 条。');
      await shot('studio-cue-shift--03-selected-786-dark');
      await close();
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 180_000);
});
