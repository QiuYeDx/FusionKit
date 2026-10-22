import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import type { TranscriptionTaskSummary } from '../../src/subtitle-studio/transcription/task-contract';
import { buildTranscriptionUiApp } from './helpers/transcription-ui-build';

const enabled = process.env.FUSIONKIT_STUDIO_RETRY_UI === '1';
type Snapshot = { tasks: TranscriptionTaskSummary[]; traces: { operation: string; detail?: any }[] };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<Snapshot> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
async function ready(page: Page) {
  await page.getByTestId('subtitle-studio').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
}
/** The failed and empty rows: their blocks, buttons, notes and spacing, and whether anything overflows. */
const geometry = (page: Page) => page.evaluate(() => {
  const rect = (element: Element | null | undefined) => { if (!element) return null; const r = element.getBoundingClientRect(); return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
  const rows = Array.from(document.querySelectorAll('[data-testid=studio-transcription-task-row]')).map(row => {
    const empty = row.querySelector('[data-testid=transcription-empty-result]'), failure = row.querySelector('[data-testid=studio-transcription-task-error]');
    const block = empty ?? failure, actions = block?.querySelector('.studio-task-failure-actions');
    const help = empty ? empty.querySelectorAll('p')[1] : failure?.querySelector('.studio-transcription-help');
    const note = block?.querySelector('.studio-task-retry-note') as HTMLElement | null | undefined;
    return { name: row.querySelector('.studio-file-name')?.textContent, state: row.getAttribute('data-state'), row: rect(row), block: rect(block),
      blockPadding: block ? getComputedStyle(block).padding : null, help: rect(help), actions: rect(actions),
      helpToActions: help && actions ? Math.round((actions.getBoundingClientRect().top - help.getBoundingClientRect().bottom) * 10) / 10 : null,
      buttons: Array.from(actions?.querySelectorAll('button') ?? []).map(button => ({ text: button.textContent, ...rect(button), disabled: (button as HTMLButtonElement).disabled })),
      note: note ? { ...rect(note), text: note.textContent, fontSize: getComputedStyle(note).fontSize, lineHeight: getComputedStyle(note).lineHeight } : null };
  });
  return { viewport: { width: innerWidth, height: innerHeight }, dark: document.documentElement.classList.contains('dark'), rows,
    noHorizontalOverflow: Array.from(document.querySelectorAll('.studio-transcription-layout, .studio-transcription-workspace, .studio-transcription-task-list, [data-testid=studio-transcription-task-row]'))
      .every(element => element.scrollWidth <= element.clientWidth + 1) };
});

describe.runIf(enabled)('T-ASRQ-08 retry and suggestions in the actual Electron transcription queue', () => {
  it('retries failed and empty tasks from the same file, suggests the quiet type or the CPU, explains recognition failures and copies diagnostics', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const zhLocale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const enLocale = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8'));
    const pageErrors: string[] = [], logs: string[] = [];
    const evidence: Record<string, unknown> = { boundary: 'Only the native transcription runtime is controlled; renderer, preload, Studio IPC, the controller and the error guide are real.' };
    let passed = false, app: ElectronApplication | undefined, page: Page | undefined, round = 0;
    const shot = (name: string) => page!.screenshot({ path: path.join(fixture.artifacts, `asrq08-${name}.png`), animations: 'disabled' });
    const launch = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      const instance = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [instance.process().stdout, instance.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      const window = await instance.firstWindow(); window.setDefaultTimeout(15000); window.on('pageerror', error => pageErrors.push(error.message));
      window.on('console', message => { logs.push(`[console.${message.type()}] ${message.text()}\n`); });
      return { app: instance, page: window };
    };
    // As in the audio type test: correct the outer window size by what the page reports.
    const size = async (width: number, height: number) => {
      const win = await app!.browserWindow(page!);
      const viewport = () => page!.evaluate(() => [innerWidth, innerHeight] as const);
      await win.evaluate((window, [w, h]) => window.setSize(w, h), [width, height] as const);
      await page!.waitForTimeout(300);
      const [innerW, innerH] = await viewport();
      await win.evaluate((window, [w, h]) => window.setSize(w, h), [width * 2 - innerW, height * 2 - innerH] as const);
      await page!.waitForFunction(([w, h]) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1, [width, height] as const);
    };
    const open = async (language: 'zh' | 'en', theme: 'light' | 'dark') => {
      await page!.evaluate(([lang, mode]) => {
        localStorage.setItem('lang', lang); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: mode }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      }, [language, theme] as const);
      await page!.reload(); await ready(page!);
      const locale = language === 'zh' ? zhLocale : enLocale;
      await page!.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      await control(app!, { operation: 'resources-ready' });
      await page!.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
    };
    /** Four tasks that end empty, out of memory on the graphics card, with a garbled window, and empty on a file then changed. */
    const scenario = async (locale: typeof zhLocale) => {
      round++;
      const names = ['01 安静的耳语 ASMR.wav', '02 out of memory on CUDA.wav', '03 Drama CD 第二話 garbled window.wav', '04 moved after transcription.wav'];
      const files = names.map(name => path.join(fixture.artifacts, `r${round}-${name}`));
      await Promise.all(files.map((file, index) => writeFile(file, Buffer.alloc(44 + index))));
      await app!.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
      await page!.getByTestId('studio-transcription-picker').getByRole('button', { name: locale.transcription.choose_media, exact: true }).click();
      await uiExpect(page!.getByTestId('studio-transcription-media-row')).toHaveCount(4);
      await page!.getByTestId('studio-transcription-start').click();
      const rows = page!.getByTestId('studio-transcription-task-row');
      await uiExpect(rows).toHaveCount(4);
      const tasks = (await control(app!, { operation: 'snapshot' })).tasks;
      await control(app!, { operation: 'no-content', taskId: tasks[0]!.taskId });
      await control(app!, { operation: 'task-state', taskId: tasks[1]!.taskId, status: 'failed', code: 'out_of_memory', stage: 'transcribing', backend: 'cuda' });
      await control(app!, { operation: 'task-state', taskId: tasks[2]!.taskId, status: 'failed', code: 'runtime_protocol_mismatch', stage: 'transcribing' });
      await control(app!, { operation: 'no-content', taskId: tasks[3]!.taskId });
      for (const [index, state] of ['no_content', 'failed', 'failed', 'no_content'].entries()) await uiExpect(rows.nth(index)).toHaveAttribute('data-state', state);
      await page!.locator('.studio-transcription-queue').scrollIntoViewIfNeeded();
      return { tasks, files, rows };
    };
    try {
      ({ app, page } = await launch());
      await open('zh', 'light'); await size(1280, 800);
      const t = zhLocale.transcription;
      const { tasks, files, rows } = await scenario(zhLocale);
      // Empty: its own help, "retry" and the quiet suggestion with its note.
      const empty = rows.nth(0);
      await uiExpect(empty.getByTestId('transcription-empty-result')).toContainText(t.empty_retry_help);
      await uiExpect(empty.getByTestId('studio-transcription-retry')).toHaveText(zhLocale.retry);
      await uiExpect(empty.getByTestId('studio-transcription-retry-quiet')).toHaveText(t.retry_quiet);
      await uiExpect(empty.locator('.studio-task-retry-note')).toHaveText(t.retry_quiet_note);
      await uiExpect(empty.getByTestId('studio-transcription-retry-cpu')).toHaveCount(0);
      // Out of memory on the graphics card: a smaller model or the CPU, one click.
      const memory = rows.nth(1);
      await uiExpect(memory.getByTestId('studio-transcription-task-error')).toContainText(t.task_error.memory.next);
      await uiExpect(memory.getByTestId('studio-transcription-retry-cpu')).toHaveText(t.retry_cpu);
      await uiExpect(memory.getByTestId('studio-task-error-resources')).toBeVisible();
      await uiExpect(memory.getByTestId('studio-transcription-retry-quiet')).toHaveCount(0);
      // A garbled window: a recognition quality problem with what to change, not a reinstall; no CPU suggestion.
      const quality = rows.nth(2);
      await uiExpect(quality.getByTestId('studio-transcription-task-error')).toContainText(t.task_error.quality.cause);
      await uiExpect(quality.getByTestId('studio-transcription-task-error')).toContainText(t.task_error.quality.next);
      await uiExpect(quality.getByTestId('studio-transcription-task-error')).not.toContainText(t.task_error.runtime.next);
      await uiExpect(quality.getByTestId('studio-transcription-retry-cpu')).toHaveCount(0);
      evidence.light1280 = await geometry(page);
      await shot('light-1280-rows');
      // Diagnostics: code, stage, model, device and audio type; no file name or path. The page's clipboard is
      // replaced so the test never touches the system clipboard.
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } }); });
      await quality.getByTestId('studio-copy-diagnostics').click();
      await uiExpect(quality.getByTestId('studio-copy-diagnostics')).toHaveText(t.diagnostics_copied);
      const copied = await page.evaluate(() => (window as any).__copied as string);
      evidence.copiedDiagnostics = copied;
      expect(copied).toBe('code: runtime_protocol_mismatch\nstage: transcribing\nmodel: large-v3-q5_0\ndevice: cpu\naudioType: standard');
      expect(copied).not.toMatch(/Drama|\.wav|[\\/]/);
      await memory.getByTestId('studio-copy-diagnostics').click();
      expect(await page.evaluate(() => (window as any).__copied as string)).toBe('code: out_of_memory\nstage: transcribing\nmodel: large-v3-q5_0\ndevice: cuda\naudioType: standard');
      await shot('light-1280-copied');
      await size(1024, 700); await page.locator('.studio-transcription-queue').scrollIntoViewIfNeeded();
      evidence.light1024 = await geometry(page);
      await shot('light-1024-rows');
      await size(1280, 800); await page.locator('.studio-transcription-queue').scrollIntoViewIfNeeded();
      // One click each: the quiet type (with voice detection), the CPU, and the same settings again.
      await empty.getByTestId('studio-transcription-retry-quiet').click();
      await uiExpect(rows).toHaveCount(5);
      await memory.getByTestId('studio-transcription-retry-cpu').click();
      await uiExpect(rows).toHaveCount(6);
      await quality.getByTestId('studio-transcription-retry').click();
      await uiExpect(rows).toHaveCount(7);
      const snapshot = await control(app, { operation: 'snapshot' });
      const retries = snapshot.traces.filter(item => item.operation === 'retry').map(item => item.detail);
      expect(retries).toEqual([{ taskId: tasks[0]!.taskId, overrides: { audioProfile: 'quiet_whisper_v1' } },
        { taskId: tasks[1]!.taskId, overrides: { devicePreference: 'cpu' } }, { taskId: tasks[2]!.taskId, overrides: {} }]);
      const enqueued = snapshot.traces.filter(item => item.operation === 'enqueue').map(item => item.detail);
      const [first, quiet, cpu, plain] = enqueued;
      expect(quiet.config).toEqual({ ...first.config, vadEnabled: true, advanced: { ...first.config.advanced, audioProfile: 'quiet_whisper_v1' } });
      expect(cpu.config).toEqual({ ...first.config, devicePreference: 'cpu' });
      expect(plain.config).toEqual(first.config);
      // The same file each time (a new authorization), with the track chosen before; the originals stay.
      expect([quiet, cpu, plain].map(request => request.files.map((file: { audioStreamId?: string }) => file.audioStreamId))).toEqual([['audio-0'], ['audio-0'], ['audio-0']]);
      expect(snapshot.tasks.slice(4).map(task => [task.displayName, task.audioProfile ?? null, task.status])).toEqual([
        [path.basename(files[0]!), 'quiet_whisper_v1', 'queued'], [path.basename(files[1]!), null, 'queued'], [path.basename(files[2]!), null, 'queued']]);
      expect(snapshot.tasks.slice(0, 4).map(task => task.status)).toEqual(['no_content', 'failed', 'failed', 'no_content']);
      await uiExpect(rows.nth(4).getByTestId('studio-transcription-task-audio-type')).toHaveText(t.audio_quiet_short);
      // A file moved or modified since: the row says to add it again, and nothing is queued.
      await writeFile(files[3]!, Buffer.alloc(4096, 1));
      await rows.nth(3).getByTestId('studio-transcription-retry').click();
      await uiExpect(rows.nth(3).getByTestId('studio-transcription-retry-source-changed')).toHaveText(t.retry_source_changed);
      await uiExpect(rows).toHaveCount(7);
      await rows.nth(3).scrollIntoViewIfNeeded();
      evidence.sourceChanged = await geometry(page).then(value => value.rows[3]);
      await shot('light-1280-source-changed');
      // The empty task already retried with the quiet type offers only "retry".
      await control(app, { operation: 'no-content', taskId: snapshot.tasks[4]!.taskId });
      await uiExpect(rows.nth(4)).toHaveAttribute('data-state', 'no_content');
      await uiExpect(rows.nth(4).getByTestId('studio-transcription-retry')).toBeVisible();
      await uiExpect(rows.nth(4).getByTestId('studio-transcription-retry-quiet')).toHaveCount(0);
      await uiExpect(rows.nth(4).getByTestId('transcription-empty-result')).toContainText(JSON.parse(await readFile(path.resolve('src/locales/zh/common.json'), 'utf8')).transcription_empty.help);
      expect(pageErrors).toEqual([]);

      // Dark, both sizes, then English at 1024 (the longest labels).
      await app.close(); app = undefined; ({ app, page } = await launch());
      await open('zh', 'dark'); await uiExpect(page.locator('html')).toHaveClass(/dark/); await size(1280, 800);
      const dark = await scenario(zhLocale);
      evidence.dark1280 = await geometry(page);
      await shot('dark-1280-rows');
      await size(1024, 700); await page.locator('.studio-transcription-queue').scrollIntoViewIfNeeded();
      evidence.dark1024 = await geometry(page);
      await shot('dark-1024-rows');
      // Without voice detection installed the quiet retry cannot run: it is disabled and its note says what to install.
      await control(app, { operation: 'resource-failed', resourceId: 'silero-vad-v6.2.0-ggml' });
      await page.locator('.studio-transcription-queue').getByRole('button', { name: zhLocale.refresh, exact: true }).click();
      await uiExpect(dark.rows.nth(0).getByTestId('studio-transcription-retry-quiet')).toBeDisabled();
      await uiExpect(dark.rows.nth(0).locator('.studio-task-retry-note')).toHaveText(t.retry_quiet_needs_vad);
      await uiExpect(dark.rows.nth(0).getByTestId('studio-transcription-retry')).toBeEnabled();
      await dark.rows.nth(0).scrollIntoViewIfNeeded();
      await shot('dark-1024-needs-vad');
      await open('en', 'dark'); await size(1024, 700);
      const english = await scenario(enLocale);
      await uiExpect(english.rows.nth(0).getByTestId('studio-transcription-retry-quiet')).toHaveText(enLocale.transcription.retry_quiet);
      evidence.english1024 = await geometry(page);
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
      await writeFile(path.join(fixture.artifacts, 'asrq08-result.json'), JSON.stringify({ outcome: passed ? 'passed' : 'failed', ...evidence, pageErrors }, null, 2));
      await writeFile(path.join(fixture.artifacts, 'asrq08-electron.log'), logs.join(''));
      try { await app?.close(); } finally { await fixture.cleanup(); }
    }
  }, 300000);
});
