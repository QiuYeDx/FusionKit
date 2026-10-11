import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { captureSourceInput } from '../../electron/main/subtitle-studio/source-location-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { pcm16WavHeader } from '../../src/subtitle-studio/cue-audio';

/** A quiet tone that changes pitch every two seconds; the app is muted under test anyway. */
async function tone(file: string, seconds: number) {
  const samples = new Int16Array(48000 * seconds).map((_, i) => Math.round(Math.sin(2 * Math.PI * (330 + 110 * Math.floor(i / 96000)) * i / 48000) * 3000));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([pcm16WavHeader(samples.byteLength, 48000, 1), new Uint8Array(samples.buffer)]));
  return file;
}
const LINES = ['先輩、おはようございます。', 'って、もう眠そうじゃないですか。', 'まだ朝なのに。', 'ん?なんですか?', '君は白鸽だから?', '朝元気なだけ?',
  '私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、先輩みたいに朝から眠そうにしてる方、いますもん', 'そんなことないです。'];

/**
 * Moves the pointer onto an element and on a little further, as a real pointer
 * does: Radix keeps a tooltip open over the path to it until a later move.
 */
async function leaveTo(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 3 });
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('playing the original audio of cues', () => {
  it('plays rows, selections and menu items, finds or asks for media, and stays silent under test', async () => {
    const artifacts = path.resolve('test-results/studio-cue-audio'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const interview = await tone(path.join(root, 'media', 'Interview.wav'), 24);
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    const transcribed = transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Interview.wav', durationMs: 24000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: LINES.map((text, index) => ({ id: `s${index}`, startMs: index * 2500, endMs: index * 2500 + 1600, text })) }, { newId: randomUUID });
    await repository.create(transcribed, undefined, await captureSourceInput(interview));
    await tone(path.join(root, 'lyrics', 'Song.wav'), 12);
    const lyrics = path.join(root, 'lyrics', 'Song.en.lrc');
    await writeFile(lyrics, '[00:01.00]first line\n[00:03.50]second line\n[00:06.00]third line\n');
    const notes = path.join(root, 'notes', 'Notes.srt');
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, '1\n00:00:01,000 --> 00:00:02,500\nA note without media\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond note\n');
    const picked = await tone(path.join(root, 'picked', 'Picked take.wav'), 8);
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      expect(await app.evaluate(({ app: electronApp }) => electronApp.commandLine.hasSwitch('mute-audio'))).toBe(true);
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      const play = (index: number) => rows.nth(index).getByTestId('studio-cue-play');
      const playing = page.locator('.studio-cue-table tbody tr[data-playing]');
      const media = page.getByTestId('studio-cue-media');
      const openDocument = async (name: string) => {
        await page.getByTestId('studio-library-row').filter({ hasText: name }).locator('button.studio-document').click();
        await uiExpect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      };
      const importFile = async (file: string) => {
        await app!.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, file);
        await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
        await uiExpect(page.getByRole('heading', { name: path.basename(file), exact: true })).toBeVisible();
      };

      // A transcribed document plays from the file it was transcribed from.
      await openDocument('Interview.wav');
      await uiExpect(media).toHaveAttribute('data-status', 'ready');
      await uiExpect(media).toHaveAccessibleName('原始音频：Interview.wav');
      await rows.nth(1).hover();
      await uiExpect(play(1)).toBeVisible();
      await uiExpect(play(1)).toHaveCSS('opacity', '1');
      await uiExpect(play(1)).toHaveAccessibleName('播放第 2 条的原始音频');
      await uiExpect(play(3)).toHaveCSS('opacity', '0');
      await shot('studio-cue-audio--01-row-hover-1280-light');
      await play(1).click();
      await uiExpect(play(1)).toHaveAttribute('data-state', 'playing');
      await uiExpect(playing).toHaveCount(1);
      await uiExpect(rows.nth(1)).toHaveAttribute('data-playing', 'true');
      // Playing never selects or changes the row.
      await uiExpect(page.getByTestId('studio-cue-selected-count')).toHaveText('');
      // Several moves, as a real pointer makes: a Radix tooltip closes on a move after leaving.
      await page.mouse.move(640, 20, { steps: 4 });
      // Neither a tooltip nor focus stays on the button once the pointer leaves.
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
      await uiExpect(play(1)).not.toBeFocused();
      await shot('studio-cue-audio--02-playing-1280-light');
      // 1.6 s plus 0.3 s on each side, then the button returns to idle by itself.
      await uiExpect(play(1)).toHaveAttribute('data-state', 'idle', { timeout: 8000 });
      await uiExpect(playing).toHaveCount(0);

      // P plays consecutive selected cues as one stretch, and stops it again.
      await rows.nth(2).locator('.studio-cue-time').click();
      await rows.nth(4).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('p');
      await uiExpect(play(2)).toHaveAttribute('data-state', 'playing');
      await uiExpect(playing).toHaveCount(3);
      await page.keyboard.press('p');
      await uiExpect(playing).toHaveCount(0);
      await uiExpect(play(2)).toHaveAttribute('data-state', 'idle');

      // Starting another row stops the first.
      await rows.nth(5).hover(); await play(5).click();
      await uiExpect(play(5)).toHaveAttribute('data-state', 'playing');
      await rows.nth(6).hover(); await play(6).click();
      await uiExpect(play(6)).toHaveAttribute('data-state', 'playing');
      await uiExpect(play(5)).toHaveAttribute('data-state', 'idle');
      await uiExpect(playing).toHaveCount(1);

      // The cue menu plays too, and shows the shortcut.
      await rows.nth(0).locator('.studio-cue-time').click({ button: 'right' });
      const menuItem = page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-play-menu');
      await uiExpect(menuItem).toContainText('播放原始音频');
      await uiExpect(menuItem).toContainText('P');
      await shot('studio-cue-audio--03-menu-1280-light');
      await menuItem.click();
      await uiExpect(play(0)).toHaveAttribute('data-state', 'playing');
      await uiExpect(play(6)).toHaveAttribute('data-state', 'idle');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('p');
      await uiExpect(playing).toHaveCount(0);

      // While editing, P is just a letter.
      await rows.nth(7).locator('[data-field=source]').dblclick();
      const editor = rows.nth(7).locator('textarea');
      await uiExpect(editor).toBeFocused();
      await page.keyboard.press('End'); await page.keyboard.type('p');
      await uiExpect(editor).toHaveValue('そんなことないです。p');
      await uiExpect(playing).toHaveCount(0);
      await page.keyboard.press('Escape');

      // The panel names the media and how it was found; the padding is a preference.
      await media.click();
      const panel = page.getByTestId('studio-cue-media-panel');
      await uiExpect(panel).toBeVisible();
      await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText('Interview.wav');
      await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText('转写来源');
      await uiExpect(page.getByTestId('studio-cue-media-clear')).toHaveCount(0);
      await page.getByTestId('studio-cue-media-padding-1000').click();
      await uiExpect(page.getByTestId('studio-cue-media-padding-1000')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(panel).toBeVisible();
      await shot('studio-cue-audio--04-panel-ready-1280-light');
      await page.keyboard.press('Escape');
      await uiExpect(panel).toBeHidden();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit.subtitle-studio.preferences.v1') ?? '{}').state?.cueAudioPadMs)).toBe(1000);

      // In the expanded preview the same list plays.
      await page.getByTestId('studio-preview-expand').click();
      await uiExpect(page.getByTestId('studio-preview-expand')).toHaveAttribute('aria-pressed', 'true');
      await rows.nth(3).locator('.studio-cue-time').click();
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('p');
      await uiExpect(play(3)).toHaveAttribute('data-state', 'playing');
      await shot('studio-cue-audio--05-expanded-playing-1280-light');
      await page.getByTestId('studio-preview-expand').click();
      await uiExpect(page.getByTestId('studio-preview-expand')).toHaveAttribute('aria-pressed', 'false');

      // An imported LRC finds the same-named media beside it; switching documents stops playback.
      // Collapsing keeps the clip playing; another row takes over.
      await uiExpect(play(3)).toHaveAttribute('data-state', 'playing');
      await rows.nth(5).hover(); await play(5).click();
      await uiExpect(play(5)).toHaveAttribute('data-state', 'playing');
      await importFile(lyrics);
      await uiExpect(page.locator('.studio-cue-audio-button[data-state=playing], .studio-cue-audio-button[data-state=loading]')).toHaveCount(0);
      await uiExpect(media).toHaveAttribute('data-status', 'ready');
      await uiExpect(media).toHaveAccessibleName('原始音频：Song.wav');
      await rows.nth(0).hover(); await play(0).click();
      await uiExpect(play(0)).toHaveAttribute('data-state', 'playing');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('p');

      // Without media: no row buttons, P explains, and choosing a file enables playback.
      await importFile(notes);
      await uiExpect(media).toHaveAttribute('data-status', 'missing');
      await uiExpect(page.locator('.studio-cue-media-dot')).toBeVisible();
      await rows.nth(0).hover();
      await uiExpect(page.getByTestId('studio-cue-play')).toHaveCount(0);
      await rows.nth(0).locator('.studio-cue-time').click();
      await page.getByTestId('studio-cue-list').focus();
      // P opens the panel that says why and offers to choose a file; Escape returns to the list.
      await page.keyboard.press('p');
      await uiExpect(page.getByTestId('studio-cue-media-missing')).toHaveText('未找到原始媒体');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('studio-cue-media-panel')).toBeHidden();
      await uiExpect(page.getByTestId('studio-cue-list')).toBeFocused();
      await rows.nth(0).locator('.studio-cue-time').click({ button: 'right' });
      await uiExpect(page.getByTestId('studio-cue-context-menu').getByTestId('studio-cue-play-menu')).toHaveAttribute('data-disabled', '');
      await page.keyboard.press('Escape');
      // The menu returns focus to the list once it has finished closing.
      await uiExpect(page.getByTestId('studio-cue-context-menu')).toBeHidden();
      await uiExpect(page.getByTestId('studio-cue-list')).toBeFocused();
      await media.click();
      await uiExpect(page.getByTestId('studio-cue-media-missing')).toHaveText('未找到原始媒体');
      await shot('studio-cue-audio--06-panel-missing-1280-light');
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); }, picked);
      await page.getByTestId('studio-cue-media-choose').click();
      await uiExpect(page.getByTestId('studio-cue-media-missing')).toBeVisible();
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, picked);
      await page.getByTestId('studio-cue-media-choose').click();
      await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText('Picked take.wav');
      // The visible name keeps its space where it splits into start and tail.
      expect(await page.getByTestId('studio-cue-media-file').locator('.studio-file-name-start').evaluate(element => (element as HTMLElement).innerText)).toBe('Picked ');
      await uiExpect(page.getByTestId('studio-cue-media-file')).toContainText('手动选择');
      await uiExpect(page.getByTestId('studio-cue-media-clear')).toBeVisible();
      await page.keyboard.press('Escape');
      await uiExpect(media).toHaveAttribute('data-status', 'ready');
      await rows.nth(1).hover(); await play(1).click();
      await uiExpect(play(1)).toHaveAttribute('data-state', 'playing');

      // Narrow and dark.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await uiExpect(rows.first()).toBeVisible();
      await page.getByTestId('studio-cue-list').focus();
      await rows.nth(1).locator('.studio-cue-time').click();
      await page.keyboard.press('p');
      await uiExpect(play(1)).toHaveAttribute('data-state', 'playing');
      await shot('studio-cue-audio--07-playing-786-dark');
      await page.keyboard.press('p');
      await media.click();
      await uiExpect(page.getByTestId('studio-cue-media-panel')).toBeVisible();
      await shot('studio-cue-audio--08-panel-786-dark');
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 120_000);
  it('plays revision proposals and consistency occurrences without changing them, and stops when the dialogs close', async () => {
    const artifacts = path.resolve('test-results/studio-cue-audio'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const meeting = await tone(path.join(root, 'media', 'Meeting.wav'), 16);
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    const lines = ['先輩、おはようございます。', '先輩、おはようございます。', 'deep sea is open source', 'センパイ、元気ですか？', '先輩は眠そうです。'];
    await repository.create(transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Meeting.wav', durationMs: 16000 },
      model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'ja',
      segments: lines.map((text, index) => ({ id: `s${index}`, startMs: index * 3000, endMs: index * 3000 + 2000, text })) }, { newId: randomUUID }),
      undefined, await captureSourceInput(meeting));
    const notes = path.join(root, 'notes', 'Notes.srt');
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, '1\n00:00:01,000 --> 00:00:02,000\nセンパイ、こんにちは。\n\n2\n00:00:03,000 --> 00:00:04,000\n先輩、ありがとう。\n');
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        const content = 'request' in payload
          ? { items: (payload.items as { id: string; source: string }[]).filter(item => /deep sea/.test(item.source)).map(item => ({ id: item.id, source: item.source.replace('deep sea', 'DeepSeek') })), note: '已更正。' }
          : { terms: [{ source: '先輩', targets: [], sourceVariants: ['センパイ'] }] };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'audio-model', name: 'Controlled model', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-model', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'audio-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const active = page.locator('.studio-cue-audio-button[data-state=playing], .studio-cue-audio-button[data-state=loading]');
      await page.getByTestId('studio-library-row').filter({ hasText: 'Meeting.wav' }).locator('button.studio-document').click();
      await uiExpect(page.getByTestId('studio-cue-media')).toHaveAttribute('data-status', 'ready');

      // Repeated neighbours: the structural change plays its stretch; playing never ticks or unticks the proposal.
      const rows = page.locator('.studio-cue-table tbody tr');
      await rows.nth(0).locator('.studio-cue-time').click();
      await rows.nth(2).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
      await page.getByTestId('studio-cue-toolbar-revise').click();
      const revision = page.getByRole('dialog', { name: 'AI 修订' });
      await revision.getByTestId('studio-cue-revision-duplicates').click();
      const structure = revision.getByTestId('studio-cue-structure-item').first();
      await uiExpect(structure).toBeVisible();
      const accepted = await structure.getAttribute('data-accepted');
      await structure.getByTestId('studio-cue-revision-play').click();
      await uiExpect(structure.getByTestId('studio-cue-revision-play')).toHaveAttribute('data-state', 'playing');
      expect(await structure.getAttribute('data-accepted')).toBe(accepted);
      await shot('studio-cue-audio-revision--01-structure-playing-1280-light');

      // A wording proposal plays its cue.
      await revision.getByTestId('studio-cue-revision-instructions').fill('把 deep sea 改成 DeepSeek');
      await revision.getByTestId('studio-cue-revision-generate').click();
      const proposal = revision.getByTestId('studio-cue-revision-item').first();
      await uiExpect(proposal).toContainText('DeepSeek');
      const before = await proposal.getAttribute('data-accepted');
      await proposal.getByTestId('studio-cue-revision-play').click();
      await uiExpect(proposal.getByTestId('studio-cue-revision-play')).toHaveAttribute('data-state', 'playing');
      await uiExpect(proposal.getByTestId('studio-cue-revision-play')).toHaveAccessibleName('停止播放');
      expect(await proposal.getAttribute('data-accepted')).toBe(before);
      await shot('studio-cue-audio-revision--02-proposal-playing-1280-light');
      // Escape closes the hover tooltip first, so leave the button (within the modal dialog) before closing it.
      await leaveTo(page, revision.getByRole('heading'));
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await uiExpect(revision).toBeHidden();
      await uiExpect(active).toHaveCount(0);

      // Narrow and dark.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await win.evaluate(window => window.setSize(786, 660));
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await uiExpect(page.getByTestId('studio-cue-list')).toBeVisible();
      await rows.nth(0).locator('.studio-cue-time').click();
      await rows.nth(2).locator('.studio-cue-time').click({ modifiers: ['Shift'] });
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await revision.getByTestId('studio-cue-revision-duplicates').click();
      await revision.getByTestId('studio-cue-structure-item').first().getByTestId('studio-cue-revision-play').click();
      await shot('studio-cue-audio-revision--03-structure-786-dark');
      await leaveTo(page, revision.getByRole('heading'));
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await uiExpect(revision).toBeHidden();
      await win.evaluate(window => window.setSize(1280, 860));
      // Occurrences across documents play from their own media; a document without media shows no button.
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, notes);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByRole('heading', { name: 'Notes.srt', exact: true })).toBeVisible();
      await page.getByTestId('studio-library-select-all').check();
      await page.locator('#studio-library-batch-actions').click();
      await page.getByTestId('studio-library-batch-consistency').click();
      const consistency = page.getByRole('dialog', { name: '术语一致性检查' });
      await consistency.getByTestId('studio-consistency-check').click();
      const group = consistency.getByTestId('studio-consistency-group').first();
      await uiExpect(group).toBeVisible();
      await group.getByTestId('studio-consistency-places-toggle').click();
      const places = group.getByTestId('studio-consistency-places').locator('li');
      const meetingPlace = places.filter({ hasText: 'Meeting.wav' }).first().getByTestId('studio-consistency-play');
      await uiExpect(meetingPlace).toBeVisible();
      await uiExpect(places.filter({ hasText: 'Notes.srt' }).getByTestId('studio-consistency-play')).toHaveCount(0);
      await meetingPlace.click();
      await uiExpect(meetingPlace).toHaveAttribute('data-state', 'playing');
      await shot('studio-cue-audio-consistency--01-place-playing-1280-dark');
      await leaveTo(page, consistency.getByRole('heading'));
      await uiExpect(page.locator('[data-slot=tooltip-content]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await uiExpect(consistency).toBeHidden();
      await uiExpect(active).toHaveCount(0);

      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); server?.close(); }
  }, 120_000);
});

