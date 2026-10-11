import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';

const LINES = 120;
/** One line a second: 0.6 s of tone, then 0.4 s of silence. The app is muted under test. */
async function tones(file: string) {
  const samples = new Int16Array(48000 * LINES).map((_, i) => (i % 48000) < 28800 ? Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 3000) : 0);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, 48000, 1), new Uint8Array(samples.buffer)]));
  return file;
}
const parseTime = (text: string) => { const [h, m, s] = text.trim().split(':'); return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000; };
async function times(row: Locator) {
  const parts = await row.locator('.studio-time-range > span').allTextContents();
  // While an edit is open or saving there is no time range yet; polls try again.
  if (parts.length < 2) return { startMs: NaN, endMs: NaN };
  return { startMs: Math.round(parseTime(parts[0])), endMs: Math.round(parseTime(parts[1])) };
}
/** Moves on a little after landing, as a real pointer does, so a Radix tooltip is left behind. */
async function leaveTo(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 3 });
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('listening while proofreading', () => {
  it('follows continuous playback across pages, slows or repeats it, and sets times from what is heard', async () => {
    const artifacts = path.resolve('test-results/studio-cue-listening'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const media = await tones(path.join(root, 'media', 'Long talk.wav'));
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    await repository.create(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Long talk.wav', durationMs: LINES * 1000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: Array.from({ length: LINES }, (_, index) => ({ id: `s${index}`, startMs: index * 1000, endMs: index * 1000 + 600, text: `第 ${index + 1} 句。` })) }, { newId: randomUUID }),
      undefined, await captureSourceInput(media));
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
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
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const list = page.getByTestId('studio-cue-list');
      const following = page.locator('.studio-cue-table tbody tr[data-following]');
      const status = page.getByTestId('studio-cue-selected-count');
      const media = page.getByTestId('studio-cue-media');
      const followingNumber = async () => Number(await following.locator('.studio-cue-number-text').textContent());
      /** Waits frame by frame (polling backs off to a second) until the highlighted line is at least `line`. */
      const followingReaches = (line: number) => page.waitForFunction(at => Number(document.querySelector('.studio-cue-table tr[data-following] .studio-cue-number-text')?.textContent) >= at,
        line, { polling: 'raf', timeout: 8000 });
      await page.getByTestId('studio-library-row').filter({ hasText: 'Long talk.wav' }).locator('button.studio-document').click();
      await uiExpect(media).toHaveAttribute('data-status', 'ready');
      await uiExpect(rows).toHaveCount(100);

      // Shift+P plays on from the keyboard row; the highlight moves line by line and P stops it.
      await rows.nth(1).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press('Shift+P');
      await uiExpect(following).toHaveCount(1);
      await uiExpect.poll(followingNumber, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
      // Following does not change the selection.
      await uiExpect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      await shot('studio-cue-listening--01-following-1280-light');
      await page.keyboard.press('p');
      await uiExpect(following).toHaveCount(0);

      // [ and ] while playing set the keyboard row's times from what is heard; ] moves on; both undo.
      const before = await times(rows.nth(4));
      expect(before).toEqual({ startMs: 4000, endMs: 4600 });
      await rows.nth(4).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press('Shift+P');
      // Line 5 is heard from 4.0 s to 4.6 s: mark its start as soon as it is highlighted.
      await followingReaches(5);
      await page.keyboard.press('[');
      await uiExpect.poll(async () => (await times(rows.nth(4))).startMs).not.toBe(4000);
      const marked = await times(rows.nth(4));
      expect(marked.startMs).toBeGreaterThan(3700); expect(marked.startMs).toBeLessThan(4600);
      await page.waitForTimeout(250);
      await page.keyboard.press(']');
      await uiExpect.poll(async () => (await times(rows.nth(4))).endMs).not.toBe(4600);
      const ended = await times(rows.nth(4));
      expect(ended.endMs).toBeGreaterThan(marked.startMs); expect(ended.endMs).toBeLessThan(5000);
      await uiExpect(rows.nth(5)).toHaveAttribute('aria-selected', 'true');
      await uiExpect(rows.nth(4)).not.toHaveAttribute('aria-selected', 'true');
      // A mark that would end a line before it starts is refused with the usual reason.
      await rows.nth(20).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press(']');
      await uiExpect(status).toHaveText(locale.cue_structure.end_before_start);
      expect(await times(rows.nth(20))).toEqual({ startMs: 20000, endMs: 20600 });
      await shot('studio-cue-listening--02-mark-refused-1280-light');
      await page.keyboard.press('p');
      await uiExpect(following).toHaveCount(0);
      await page.keyboard.press('Control+z');
      await uiExpect.poll(async () => (await times(rows.nth(4))).endMs).toBe(4600);
      await page.keyboard.press('Control+z');
      await uiExpect.poll(async () => (await times(rows.nth(4))).startMs).toBe(4000);
      // Without playback, [ explains itself.
      await page.keyboard.press('[');
      await uiExpect(status).toHaveText(locale.cue_listen.mark_needs_playback);

      // The menu offers continuous playback with its shortcut.
      await rows.nth(2).locator('.studio-cue-time').click({ button: 'right' });
      const followItem = page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-follow-menu');
      await uiExpect(followItem).toContainText(locale.cue_listen.follow);
      await uiExpect(followItem).toContainText('Shift+P');
      await shot('studio-cue-listening--03-menu-1280-light');
      await followItem.click();
      await uiExpect(following).toHaveCount(1);
      await list.focus(); await page.keyboard.press('p');
      await uiExpect(following).toHaveCount(0);

      // Past the last line of the page, the next page opens and the highlight goes on there.
      await rows.nth(98).locator('.studio-cue-time').click();
      await list.focus();
      await page.keyboard.press('Shift+P');
      await followingReaches(100);
      await uiExpect(rows.first().locator('.studio-cue-number-text')).toHaveText('101', { timeout: 8000 });
      await uiExpect.poll(followingNumber, { timeout: 5000 }).toBeGreaterThanOrEqual(101);
      await shot('studio-cue-listening--04-next-page-1280-light');
      await list.focus(); await page.keyboard.press('p');
      await uiExpect(following).toHaveCount(0);

      // Speed and repeat are preferences shown on the toolbar button.
      await media.click();
      const panel = page.getByTestId('studio-cue-media-panel');
      await page.getByTestId('studio-cue-media-tempo-0.75').click();
      await panel.getByRole('switch', { name: locale.cue_listen.loop }).click();
      await uiExpect(panel.getByRole('switch', { name: locale.cue_listen.loop })).toHaveAttribute('aria-checked', 'true');
      await shot('studio-cue-listening--05-panel-1280-light');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('studio-cue-media-tempo-badge')).toHaveText('.75');
      // A repeated stretch keeps playing past its length (0.6 s + 0.3 s on each side, slowed to 1.6 s).
      await rows.nth(0).hover(); await rows.nth(0).getByTestId('studio-cue-play').click();
      await uiExpect(rows.nth(0).getByTestId('studio-cue-play')).toHaveAttribute('data-state', 'playing');
      await page.waitForTimeout(2600);
      await uiExpect(rows.nth(0).getByTestId('studio-cue-play')).toHaveAttribute('data-state', 'playing');
      await rows.nth(0).getByTestId('studio-cue-play').click();
      await uiExpect(rows.nth(0).getByTestId('studio-cue-play')).toHaveAttribute('data-state', 'idle');
      // The settings outlive a restart of the page.
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await uiExpect(page.getByTestId('studio-cue-media-tempo-badge')).toHaveText('.75');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1') ?? '{}').state)).toMatchObject({ cueAudioTempo: 0.75, cueAudioLoop: true });

      // Narrow and dark: following, then the panel.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await uiExpect(rows.first()).toBeVisible();
      await rows.nth(2).locator('.studio-cue-time').click();
      await list.focus(); await page.keyboard.press('Shift+P');
      await uiExpect(following).toHaveCount(1);
      await shot('studio-cue-listening--06-following-786-dark');
      await page.keyboard.press('p');
      await page.getByTestId('studio-cue-media').click();
      await uiExpect(page.getByTestId('studio-cue-media-panel')).toBeVisible();
      await shot('studio-cue-listening--07-panel-786-dark');
      await leaveTo(page, page.getByTestId('studio-cue-media-panel').getByText(locale.cue_listen.tempo));
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 150_000);
  it('shows the waveform while retiming a line and moves its start and end by dragging', async () => {
    const artifacts = path.resolve('test-results/studio-cue-listening'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const media = await tones(path.join(root, 'media', 'Long talk.wav'));
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    await repository.create(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Long talk.wav', durationMs: LINES * 1000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, startMs: index * 1000, endMs: index * 1000 + 600, text: `第 ${index + 1} 句。` })) }, { newId: randomUUID }),
      undefined, await captureSourceInput(media));
    const notes = path.join(root, 'notes', 'Notes.srt');
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, '1\n00:00:01,000 --> 00:00:02,000\nA note without media\n');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
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
      const shot = async (name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      await page.getByTestId('studio-library-row').filter({ hasText: 'Long talk.wav' }).locator('button.studio-document').click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');

      // Line 5 is 4.0–4.6 s; the waveform shows 2.5–6.1 s with sound in 4.0–4.6 and silence after it.
      await rows.nth(4).locator('.studio-cue-time').dblclick();
      const wave = rows.nth(4).getByTestId('studio-cue-waveform');
      await uiExpect(wave).toHaveAttribute('data-loaded', 'true', { timeout: 1500 });
      const canvas = wave.locator('canvas');
      const box = (await wave.locator('.studio-cue-waveform-canvas').boundingBox())!;
      const x = (ms: number) => box.x + (ms - 2500) / 3600 * box.width;
      // Bars have gaps between them: the tallest of the columns around the point.
      const inked = (ms: number) => canvas.evaluate((element, column) => {
        const target = element as HTMLCanvasElement, scale = target.width / target.clientWidth;
        let tallest = 0;
        for (let offset = -3; offset <= 3; offset++) {
          const data = target.getContext('2d')!.getImageData(Math.max(0, Math.round((column + offset) * scale)), 0, 1, target.height).data;
          let painted = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
          tallest = Math.max(tallest, painted / target.height);
        }
        return tallest;
      }, (ms - 2500) / 3600 * box.width);
      expect(await inked(4300)).toBeGreaterThan(0.3);
      expect(await inked(4800)).toBeLessThan(0.1);
      // The start and end are bracket markers; the length is shown beside the play button.
      await uiExpect(wave.locator('.studio-cue-wave-marker[data-which=start]')).toHaveCount(1);
      await uiExpect(wave.locator('.studio-cue-wave-marker[data-which=end]:not([data-implied])')).toHaveCount(1);
      await uiExpect(wave.getByTestId('studio-cue-waveform-length')).toHaveText(locale.cue_listen.length.replace('{{seconds}}', '0.60'));
      // The strip sits in the row's wide text cell, so the row grows by one strip only.
      const textCell = (await rows.nth(4).locator('td.studio-cue-text').boundingBox())!;
      const waveCard = (await wave.boundingBox())!;
      expect(waveCard.x).toBeGreaterThanOrEqual(textCell.x - 1);
      expect(waveCard.width).toBeGreaterThan(textCell.width * 0.8);
      expect((await rows.nth(4).boundingBox())!.height).toBeLessThan(110);
      await shot('studio-cue-listening--08-waveform-1280-light');
      // Dragging the end marker writes the end field (to 10 ms); Enter saves and Ctrl+Z undoes.
      await page.mouse.move(x(4600), box.y + 18); await page.mouse.down();
      await page.mouse.move(x(4750), box.y + 18, { steps: 4 }); await page.mouse.move(x(4900), box.y + 18, { steps: 4 }); await page.mouse.up();
      const end = page.getByTestId('studio-cue-time-end');
      const endMs = Math.round(parseTime(await end.inputValue()));
      expect(Math.abs(endMs - 4900)).toBeLessThanOrEqual(30);
      expect(endMs % 10).toBe(0);
      // The fields keep focus, so the edit stays open; the play button tries the stretch without saving.
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeVisible();
      await wave.getByTestId('studio-cue-waveform-play').click();
      await uiExpect(wave.getByTestId('studio-cue-waveform-play')).toHaveAttribute('data-state', 'playing');
      await uiExpect(wave.getByTestId('studio-cue-waveform-playhead')).toBeVisible();
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeVisible();
      await end.press('Enter');
      await uiExpect.poll(async () => (await times(rows.nth(4))).endMs).toBe(endMs);
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect.poll(async () => (await times(rows.nth(4))).endMs).toBe(4600);
      // Dragging the end before the start is refused when saving, as typing it is.
      await rows.nth(4).locator('.studio-cue-time').dblclick();
      await uiExpect(wave).toHaveAttribute('data-loaded', 'true', { timeout: 1500 });
      await page.mouse.move(x(4600), box.y + 18); await page.mouse.down(); await page.mouse.move(x(3600), box.y + 18, { steps: 6 }); await page.mouse.up();
      await page.getByTestId('studio-cue-time-end').press('Enter');
      await uiExpect(rows.nth(4).locator('.studio-cue-editor-error')).toHaveText(locale.cue_structure.end_before_start);
      await page.getByTestId('studio-cue-time-end').press('Escape');
      expect(await times(rows.nth(4))).toEqual({ startMs: 4000, endMs: 4600 });

      // Narrow and dark: the waveform stays inside the time column.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await rows.nth(2).locator('.studio-cue-time').dblclick();
      await uiExpect(rows.nth(2).getByTestId('studio-cue-waveform')).toHaveAttribute('data-loaded', 'true', { timeout: 1500 });
      const column = (await rows.nth(2).locator('td.studio-cue-text').boundingBox())!;
      const waveBox = (await rows.nth(2).getByTestId('studio-cue-waveform').boundingBox())!;
      expect(waveBox.x + waveBox.width).toBeLessThanOrEqual(column.x + column.width + 1);
      await shot('studio-cue-listening--09-waveform-786-dark');
      await page.getByTestId('studio-cue-time-start').press('Escape');

      // An LRC line has no end: it plays until the next line starts (a dashed marker), and pressing
      // the play button, a disabled one or the space around it keeps the edit open.
      const songs = path.join(root, 'songs');
      await tones(path.join(songs, 'Song.wav'));
      const lrc = path.join(songs, 'Song.lrc');
      await writeFile(lrc, '[00:01.00]第一句\n[00:03.00]第二句\n[00:06.50]第三句\n');
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, lrc);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).first().click();
      await uiExpect(rows).toHaveCount(3);
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');
      await rows.nth(1).locator('.studio-cue-time').dblclick();
      const lrcWave = rows.nth(1).getByTestId('studio-cue-waveform');
      await uiExpect(lrcWave).toHaveAttribute('data-loaded', 'true', { timeout: 1500 });
      await uiExpect(page.getByTestId('studio-cue-time-end')).toHaveValue('');
      await uiExpect(lrcWave.locator('.studio-cue-wave-marker[data-which=end][data-implied]')).toHaveCount(1);
      await uiExpect(lrcWave.getByTestId('studio-cue-waveform-length')).toHaveText(new RegExp('^' + locale.cue_listen.length.replace('{{seconds}}', '3.50')));
      await uiExpect(lrcWave.getByTestId('studio-cue-waveform-length')).toHaveAttribute('title', locale.cue_listen.end_at_next);
      const lrcPlay = lrcWave.getByTestId('studio-cue-waveform-play');
      await uiExpect(lrcPlay).toBeEnabled();
      await lrcPlay.click();
      await uiExpect(lrcPlay).toHaveAttribute('data-state', 'playing');
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeVisible();
      await shot('studio-cue-listening--10-waveform-lrc-786-dark');
      await lrcPlay.click();
      await uiExpect(lrcPlay).toHaveAttribute('data-state', 'idle');
      await page.getByTestId('studio-cue-time-start').fill('x');
      await uiExpect(lrcPlay).toBeDisabled();
      await lrcPlay.click({ force: true });
      await lrcWave.getByTestId('studio-cue-waveform-length').click();
      await lrcWave.click({ position: { x: 2, y: 2 } });
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeVisible();
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeFocused();
      await page.getByTestId('studio-cue-time-start').press('Escape');
      // The last line has no next one: it plays for five seconds.
      await rows.nth(2).locator('.studio-cue-time').dblclick();
      await uiExpect(rows.nth(2).getByTestId('studio-cue-waveform-length')).toHaveAttribute('title', locale.cue_listen.end_default);
      await uiExpect(rows.nth(2).getByTestId('studio-cue-waveform-length')).toHaveText(new RegExp('^' + locale.cue_listen.length.replace('{{seconds}}', '5.00')));
      await page.getByTestId('studio-cue-time-start').press('Escape');

      // Without media the editor is as before.
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, notes);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).first().click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'missing');
      await rows.nth(0).locator('.studio-cue-time').dblclick();
      await uiExpect(page.getByTestId('studio-cue-time-start')).toBeVisible();
      await uiExpect(page.getByTestId('studio-cue-waveform')).toHaveCount(0);
      await page.getByTestId('studio-cue-time-start').press('Escape');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 120_000);
});
