import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Opt in only with an explicit local model and bounded audio. Never uses remote ASR
// or the user's real profile; artifacts are retained for inspection and owned cleanup.
it.runIf(process.env.FUSIONKIT_STUDIO_LEGACY_ASR === '1')('runs real legacy ASR alongside Studio without changing source media or preferences', async () => {
  const model = process.env.FUSIONKIT_STUDIO_ASR_MODEL;
  const audio = process.env.FUSIONKIT_STUDIO_ASR_AUDIO;
  if (!model || !audio) throw new Error('Explicit local model and bounded audio are required');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-legacy-asr-')));
  const profile = path.join(root, 'profile');
  const artifacts = path.resolve('test-results/subtitle-studio-legacy-asr');
  await mkdir(artifacts, { recursive: true });
  const source = path.join(root, 'bounded-speech.wav');
  const sourceBytes = await readFile(audio);
  await writeFile(source, sourceBytes);
  const report: Record<string, unknown> = { root, profile, sourceHash: createHash('sha256').update(sourceBytes).digest('hex'), errors: [] };
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }, timeout: 60000 });
    report.pid = app.process().pid;
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    const page = await app.firstWindow();
    page.on('pageerror', error => (report.errors as string[]).push(error.message));
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style') && document.body.innerText.length > 100);
    await page.evaluate(() => {
      localStorage.setItem('lang', 'zh');
      localStorage.setItem('local-subtitle-transcriber-tour-done', '1');
      localStorage.setItem('fusionkit-local-subtitle-transcriber', JSON.stringify({ version: 4, state: {
        preferences: { modelId: 'large-v3-q5_0', devicePreference: 'cpu', language: 'ja', vadEnabled: false, windowStrategy: 'fixed_v1', beamSize: 5, temperature: 0, vadMinSilenceMs: 600, maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42, outputFormats: ['SRT', 'LRC'], outputMode: 'source', outputDirectoryDisplayLabel: null },
        draftPreferences: { initialPrompt: '', taskMode: 'transcribe', conflictPolicy: 'index', postActionMode: 'export_only', preferredHandoffFormat: 'LRC' },
      } }));
      location.hash = '/tools/subtitle/local-transcriber';
    });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await page.getByTestId('local-subtitle-file-input').waitFor({ state: 'attached' });
    // Keep the native File populated until preload finishes its authorization.
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'acceptance-model-input'; document.body.append(input); });
    await page.locator('#acceptance-model-input').setInputFiles(model);
    const imported = await page.evaluate(async () => window.localSubtitleApi.importModel((document.querySelector('#acceptance-model-input') as HTMLInputElement).files![0], { mode: 'copy', modelId: 'large-v3-q5_0' }));
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    await uiExpect.poll(async () => {
      const snapshot = await page.evaluate(() => window.localSubtitleApi.getSessionSnapshot());
      report.importSnapshot = snapshot;
      if (!snapshot.ok) return 'ipc-failed';
      return snapshot.data.resourceJobs.find(job => job.resourceId === 'large-v3-q5_0')?.status;
    }, { timeout: 240000, intervals: [1000] }).toBe('completed');
    await page.locator('#acceptance-model-input').evaluate(input => input.remove());
    // Import through preload bypasses the page's resource-action refresh callback.
    await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
    await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
    await page.evaluate(() => { location.hash = '/tools/subtitle/local-transcriber'; });
    await page.getByTestId('local-subtitle-file-input').waitFor({ state: 'attached' });
    await page.getByTestId('local-subtitle-file-input').setInputFiles(source);
    const start = page.getByRole('button', { name: '全部开始', exact: true });
    await uiExpect(start).toBeEnabled({ timeout: 30000 });
    const preferences = await page.evaluate(() => localStorage.getItem('fusionkit-local-subtitle-transcriber'));
    await start.click();
    await uiExpect.poll(async () => {
      const snapshot = await page.evaluate(() => window.localSubtitleApi.getSessionSnapshot());
      report.finalSnapshot = snapshot;
      if (!snapshot.ok) return 'ipc-failed';
      const task = snapshot.data.batches.flatMap(batch => batch.tasks)[0];
      if (task?.status === 'failed') throw new Error(JSON.stringify(task));
      return task?.status;
    }, { timeout: 420000, intervals: [2000] }).toBe('completed');
    const srt = await readFile(path.join(root, 'bounded-speech.srt'), 'utf8');
    const lrc = await readFile(path.join(root, 'bounded-speech.lrc'), 'utf8');
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> /);
    expect(srt).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    expect(lrc).toMatch(/\[\d{2}:\d{2}/);
    report.srt = srt; report.lrc = lrc;
    await page.screenshot({ path: path.join(artifacts, 'legacy-real-transcription.png'), animations: 'disabled' });
    await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
    await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('fusionkit-local-subtitle-transcriber'))).toBe(preferences);
    expect(await readFile(source)).toEqual(sourceBytes);
    report.preferencesUnchanged = true; report.sourceUnchanged = true;
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.failure = String(error);
    if (app) {
      const page = await app.firstWindow();
      report.body = await page.locator('body').innerText().catch(() => '');
      await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    }
    throw error;
  }
  finally {
    await app?.close(); report.closed = true;
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  }
}, 780000);
