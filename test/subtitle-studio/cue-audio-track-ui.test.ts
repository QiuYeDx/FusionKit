import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

type Snapshot = { traces: Array<{ operation: string; detail?: any }>; tasks: Array<{ taskId: string; displayName: string; documentId?: string }> };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> =>
  app.evaluate(async (_electron, value) => (globalThis as any).__studioT06Control(value), command);
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('the audio track transcribed', () => {
  it('is remembered by the transcribed document and shown with its original audio', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const artifacts = path.resolve('test-results/studio-cue-audio-track'); await mkdir(artifacts, { recursive: true });
    const t = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8')).transcription;
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await ready(page);
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };

      // Two files: the interpretation track of one, the automatic choice of the other.
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await page.getByTestId('studio-transcription').waitFor();
      await uiExpect.poll(() => app!.evaluate(() => typeof (globalThis as any).__studioT06Control)).toBe('function');
      await control(app, { operation: 'resources-ready' });
      // The page reads the installed resources when it opens.
      await page.reload(); await ready(page);
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await page.getByTestId('studio-transcription').waitFor();
      const files = ['Interview.mkv', 'Talk.mkv'].map(name => path.join(fixture.artifacts, name));
      await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
      await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
      await page.getByTestId('studio-transcription-picker').getByRole('button', { name: t.choose_media, exact: true }).click();
      const media = page.getByTestId('studio-transcription-media-row');
      await uiExpect(media).toHaveCount(2);
      await media.filter({ hasText: 'Interview.mkv' }).getByRole('combobox').click();
      await page.getByRole('option').filter({ hasText: 'interpretation' }).click();
      const start = page.getByTestId('studio-transcription-start');
      await uiExpect(start).toBeEnabled();
      await start.click();
      const rows = page.getByTestId('studio-transcription-task-row');
      await uiExpect(rows).toHaveCount(2);
      const snapshot = await control(app, { operation: 'snapshot' });
      expect(snapshot.traces.findLast(trace => trace.operation === 'enqueue')!.detail.files.map((file: { audioStreamId?: string }) => file.audioStreamId)).toEqual(['audio-1', 'audio-0']);
      for (const task of snapshot.tasks) await control(app, { operation: 'complete', taskId: task.taskId, cueCount: 3 });

      const open = async (name: string) => {
        const row = rows.filter({ hasText: name });
        await uiExpect(row).toHaveAttribute('data-state', 'completed');
        await row.getByRole('button', { name: t.open_document, exact: true }).click();
        await page.getByTestId('studio-cue-media').click();
        await uiExpect(page.getByTestId('studio-cue-media-panel')).toBeVisible();
        await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText(name);
      };
      const track = page.getByTestId('studio-cue-media-track');
      await open('Interview.mkv');
      await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText('转写来源');
      await uiExpect(track).toHaveText('音轨 2 · ja · 通訳音声 · interpretation');
      await shot('studio-cue-audio-track--01-panel-1280-light');
      await page.keyboard.press('Escape');

      // The other file's track (the default one, sent as chosen) is remembered too.
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await open('Talk.mkv');
      await uiExpect(track).toHaveText('音轨 1 · en · Original interview');
      await page.keyboard.press('Escape');

      // Narrow and dark.
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByRole('tab', { name: '转写', exact: true }).click();
      await open('Interview.mkv');
      await uiExpect(track).toHaveText('音轨 2 · ja · 通訳音声 · interpretation');
      // One line inside the panel.
      expect(await track.evaluate(element => element.scrollHeight <= 18 && element.getBoundingClientRect().right <= element.closest('[data-testid=studio-cue-media-panel]')!.getBoundingClientRect().right)).toBe(true);
      await shot('studio-cue-audio-track--02-panel-786-dark');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); await fixture.cleanup(); }
  }, 180_000);
});
