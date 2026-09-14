import { createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';

const enabled = process.env.FUSIONKIT_RELEASE_REAL_WORKFLOW === '1';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);
async function hashFile(file: string) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(code)), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Unlike expect.poll, this does not retry exceptions such as a terminal resource-job failure.
async function waitForState<T>(read: () => Promise<T>, complete: (value: T) => boolean, timeout: number, stage: string): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (complete(value)) return value;
    await delay(1000);
  } while (Date.now() < deadline);
  throw Error(`${stage}:timeout`);
}

async function processTable() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3].trim() }] : [];
  });
}

// Explicit opt-in: real local ASR and the selected configured text provider.
// Only native picker responses are automated; production IPC and execution stay intact.
describe.runIf(enabled)('release candidate real production workflow', () => {
  it('transcribes on CPU and Metal, reopens documents, translates and exports actual files', async () => {
    const artifacts = path.resolve('test-results/studio-release-real');
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const profile = path.join(root, 'profile');
    const appRoot = path.join(root, 'app');
    const sourceProfile = process.env.FUSIONKIT_RELEASE_PROFILE_SOURCE;
    const sourceAudio = path.resolve(process.env.FUSIONKIT_RELEASE_AUDIO ?? 'docs/v0.2.11/local-subtitle-transcriber/poc/pre004-macos-arm64.local/whisper.cpp-git/samples/jfk.wav');
    const sourceModel = path.resolve(process.env.FUSIONKIT_RELEASE_MODEL ?? 'docs/v0.2.11/local-subtitle-transcriber/poc/pre004-macos-arm64.local/models/ggml-large-v3-q5_0.bin');
    let originalAudio: Buffer;
    const media = ['jfk-cpu.wav', 'jfk-metal.wav'].map(name => path.join(root, name));
    const evidence: Record<string, any> = {
      realAsr: false, provider: 'configured-real-provider', runtimeSubstitutions: 0,
      packaged: null, chains: [], checkpoints: [], launches: [], exports: [],
    };
    let app: ElectronApplication | undefined, page: Page | undefined, workflowCompleted = false, primaryFailure: unknown;
    let appProcess: ChildProcess | undefined;
    let stage = 'setup';
    const pageErrors: string[] = [];
    const ownedProcesses = new Map<number, string>();
    const rememberProcesses = async (newRoot?: number) => {
      const rows = await processTable();
      if (newRoot) {
        const row = rows.find(item => item.pid === newRoot);
        if (row) ownedProcesses.set(row.pid, row.started);
      }
      const alive = new Set(rows.filter(row => ownedProcesses.get(row.pid) === row.started).map(row => row.pid));
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) if (!alive.has(row.pid) && alive.has(row.parent)) {
          ownedProcesses.set(row.pid, row.started); alive.add(row.pid); changed = true;
        }
      }
      return rows.filter(row => ownedProcesses.get(row.pid) === row.started);
    };
    const checkpoint = async (name: string, detail: Record<string, unknown> = {}) => {
      stage = name; evidence.stage = name;
      evidence.checkpoints.push({ stage: name, at: new Date().toISOString(), ...detail });
      if (app) await rememberProcesses();
      await writeFile(path.join(root, 'progress.json'), JSON.stringify(evidence, null, 2));
    };
    const waitForExit = async (timeout: number) => {
      const deadline = Date.now() + timeout;
      do {
        if (!(await rememberProcesses()).length) return true;
        await delay(200);
      } while (Date.now() < deadline);
      return false;
    };
    const closeApplication = async () => {
      const failures: Error[] = [];
      const current = app;
      // Playwright disposes its dispatcher during close(); retain the OS handle beforehand.
      const currentProcess = appProcess;
      try { await rememberProcesses(); } catch { failures.push(Error('owned_process_tracking_failed')); }
      if (current) {
        try { await bounded(current.close(), 45000, 'electron_close_timeout'); }
        catch {
          failures.push(Error('electron_close_failed'));
          // The ChildProcess handle is also safe when process-table discovery was unavailable.
          if (currentProcess?.exitCode === null && currentProcess.signalCode === null) {
            try { currentProcess.kill('SIGTERM'); } catch { failures.push(Error('electron_signal_failed')); }
          }
        }
      }
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        try {
          if (await waitForExit(signal === 'SIGTERM' ? 3000 : 5000)) break;
          const alive = await rememberProcesses();
          for (const processInfo of alive) {
            try { process.kill(processInfo.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(Error('owned_process_signal_failed')); }
          }
        } catch { failures.push(Error('owned_process_exit_check_failed')); }
      }
      try { if (!(await waitForExit(5000))) failures.push(Error('owned_process_still_alive')); }
      catch { failures.push(Error('owned_process_final_check_failed')); }
      if (!currentProcess || currentProcess.exitCode !== null || currentProcess.signalCode !== null) { app = undefined; appProcess = undefined; }
      if (failures.length) throw new AggregateError(failures, 'Owned application shutdown failed.');
    };
    const launch = async () => {
      const env = Object.fromEntries(Object.entries({ ...process.env, NODE_ENV: 'test', VITE_DEV_SERVER_URL: '' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE;
      const executablePath = process.env.FUSIONKIT_RELEASE_EXECUTABLE;
      app = await electron.launch({ ...(executablePath ? { executablePath } : {}),
        args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`], cwd: executablePath ? process.cwd() : appRoot, env });
      appProcess = app.process();
      await rememberProcesses(appProcess.pid);
      const identity = await app.evaluate(({ app: application }) => ({ packaged: application.isPackaged, applicationPath: application.getAppPath(), executablePath: application.getPath('exe'), version: application.getVersion() }));
      expect(identity.packaged, 'The actual Electron packaging state must match the requested launch mode.').toBe(!!executablePath);
      if (executablePath) expect(await realpath(identity.executablePath)).toBe(await realpath(executablePath));
      const applicationEvidence = {
        packaged: identity.packaged, version: identity.version, executableSha256: hash(await readFile(identity.executablePath)),
        ...(identity.packaged ? { asarSha256: hash(await readFile(identity.applicationPath)) } : {
          mainSha256: hash(await readFile(path.join(identity.applicationPath, 'dist-electron/main/index.js'))),
          preloadSha256: hash(await readFile(path.join(identity.applicationPath, 'dist-electron/preload/index.mjs'))),
          rendererEntrySha256: hash(await readFile(path.join(identity.applicationPath, 'dist/index.html'))),
        }),
      };
      if (evidence.launches.length) expect(applicationEvidence).toEqual(evidence.launches[0]);
      evidence.packaged = identity.packaged; evidence.launches.push(applicationEvidence);
      await checkpoint('launch_first_window');
      page = await app.firstWindow(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => pageErrors.push(error.message));
      const window = await app.browserWindow(page);
      await window.evaluate(value => { value.setSize(1280, 860); value.show(); });
    };
    const ready = async () => {
      await page!.getByTestId('subtitle-studio').waitFor();
      await page!.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    };
    const docs = () => page!.evaluate(async () => {
      const result = await window.subtitleStudio.listDocuments({ offset: 0 });
      if (!result.ok) throw Error(result.error);
      return result.value.documents;
    });
    const pick = async (files: string[]) => app!.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: value });
    }, files);
    const capture = (name: string) => page!.screenshot({ path: path.join(root, `${name}.png`), animations: 'disabled' });
    try {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('This CPU/Metal release workflow requires macOS arm64.');
      if (!sourceProfile) throw Error('Set FUSIONKIT_RELEASE_PROFILE_SOURCE to an existing configured profile; credentials are never logged.');
      await mkdir(profile);
      originalAudio = await readFile(sourceAudio);
      for (const file of media) await writeFile(file, originalAudio);
      evidence.sample = { name: 'whisper.cpp upstream JFK', sha256: hash(originalAudio) };
      evidence.sourceModelSha256 = await hashFile(sourceModel);
      await checkpoint('prepare_app');
      if (!process.env.FUSIONKIT_RELEASE_EXECUTABLE) {
        await mkdir(appRoot);
        for (const name of ['package.json', 'dist', 'dist-electron']) await cp(path.resolve(name), path.join(appRoot, name), { recursive: true });
        for (const name of ['local-subtitle-resources/local-subtitle', 'subtitle-studio-resources/transcription']) await cp(path.resolve('build', name), path.join(appRoot, 'build', name), { recursive: true });
        evidence.build = { main: hash(await readFile(path.join(appRoot, 'dist-electron/main/index.js'))), preload: hash(await readFile(path.join(appRoot, 'dist-electron/preload/index.mjs'))) };
      }
      await cp(path.join(sourceProfile, 'Local Storage'), path.join(profile, 'Local Storage'), { recursive: true });
      await checkpoint('launch_configuration_transfer');
      await launch();
      const storageOrigin = process.env.FUSIONKIT_RELEASE_STORAGE_ORIGIN;
      if (storageOrigin) {
        const url = new URL(storageOrigin);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.origin !== storageOrigin) throw Error('Only an explicit local development storage origin is supported.');
        await page!.waitForURL('file:///**');
        const applicationUrl = page!.url();
        await checkpoint('launch_transfer_configuration');
        await page!.route(`${storageOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: '<html><body>Isolated configuration transfer</body></html>' }));
        const contentsId = await (await app!.browserWindow(page!)).evaluate(window => window.webContents.id);
        try {
          evidence.configurationTransferred = await app!.evaluate(async ({ webContents }, value) => {
            const contents = webContents.fromId(value.contentsId);
            if (!contents) throw Error('Isolated configuration transfer window is unavailable.');
            let phase = 'load_source';
            try {
              await contents.loadURL(value.storageOrigin);
              phase = 'read_source';
              const modelSettings: unknown = await contents.executeJavaScript("localStorage.getItem('fusionkit-model')");
              phase = 'load_destination';
              await contents.loadURL(value.applicationUrl);
              if (typeof modelSettings !== 'string') return false;
              phase = 'write_destination';
              // The value stays inside main/renderer; the harness receives only this boolean.
              await contents.executeJavaScript(`localStorage.setItem('fusionkit-model', ${JSON.stringify(modelSettings)})`);
              return true;
            } catch (error) {
              const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^ERR_[A-Z_]+$/u.test(error.code) ? error.code : 'transfer_failed';
              throw Error(`Isolated configuration transfer failed: ${phase}:${code}`);
            }
          }, { contentsId, storageOrigin, applicationUrl });
        } finally { await page!.unroute(`${storageOrigin}/**`); }
      }
      evidence.configurationAvailable = await page!.evaluate(() => {
        const value = JSON.parse(localStorage.getItem('fusionkit-model') ?? '{}').state;
        const selected = value?.profiles?.find((item: any) => item.id === value.assignment?.taskExecution) ?? value?.profiles?.[0];
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.removeItem('fusionkit.subtitle-studio.preferences.v1');
        location.hash = '/tools/subtitle/studio';
        return !!(selected?.apiKey && selected?.baseUrl && selected?.modelKey);
      });
      // Reopen with persisted locale/theme; later reload reliability has its own focused test.
      await checkpoint('reopen_configured_app');
      await closeApplication();
      await launch(); await page!.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready();
      expect(evidence.configurationAvailable, 'The isolated profile has no usable selected text provider.').toBe(true);
      await page!.getByRole('tab', { name: '转写', exact: true }).click();
      const runtime = await page!.evaluate(() => window.subtitleStudio.inspectTranscriptionRuntime({}));
      expect(runtime.ok).toBe(true);
      if (!runtime.ok) throw Error(runtime.error);
      evidence.runtime = runtime.value;
      expect(runtime.value.status).toBe('verified');
      await checkpoint('model_import_start');
      await pick([sourceModel]);
      const imported = await page!.evaluate(() => window.subtitleStudio.importTranscriptionModel({ modelId: 'large-v3-q5_0' }));
      if (!imported.ok) throw Error(`model_import:${imported.error}`);
      if (!imported.value) throw Error('model_import:cancelled');
      const importJobId = imported.value.jobId;
      await checkpoint('model_import_wait', { jobId: importJobId });
      await waitForState(async () => {
        const result = await page!.evaluate(() => window.subtitleStudio.listTranscriptionResources({}));
        if (!result.ok) throw Error(`model_import:${result.error}`);
        const job = result.value.jobs.find(item => item.jobId === importJobId);
        if (job?.status === 'failed' || job?.status === 'cancelled') {
          evidence.resourceFailure = { jobId: importJobId, status: job.status, code: job.error?.code ?? 'resource_cancelled' };
          await checkpoint('model_import_failed', evidence.resourceFailure);
          throw Error(`model_import:${job.error?.code ?? job.status}`);
        }
        return result.value.resources.find(resource => resource.resourceId === 'large-v3-q5_0')?.status;
      }, status => status === 'ready', 180000, 'model_import');
      await checkpoint('model_import_completed');
      await page!.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await page!.locator('#studio-transcription-vad').uncheck();
      const configField = async (id: string, label: string) => {
        await page!.locator(`#${id}`).click();
        await page!.getByRole('option', { name: label, exact: true }).click();
      };
      const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
      await configField('studio-transcription-language', locale.transcription.language_en);
      for (const [index, backend] of ['cpu', 'metal'].entries()) {
        await checkpoint(`transcription_${backend}_start`);
        await configField('studio-transcription-device', locale.transcription[`device_${backend}`]);
        await pick([media[index]]);
        await page!.getByTestId('studio-transcription-picker').getByRole('button').first().click();
        await uiExpect(page!.getByTestId('studio-transcription-media-row')).toHaveCount(1);
        await uiExpect(page!.getByTestId('studio-transcription-start')).toBeEnabled();
        await page!.getByTestId('studio-transcription-start').click();
        const task = await waitForState(async () => {
          const result = await page!.evaluate(() => window.subtitleStudio.listTranscriptionTasks({}));
          if (!result.ok) throw Error(`transcription_${backend}:${result.error}`);
          const current = result.value.find(item => item.displayName === path.basename(media[index]));
          if (current && ['failed', 'cancelled'].includes(current.status)) throw Error(`transcription_${backend}:${current.error?.code ?? current.status}`);
          return current;
        }, current => current?.status === 'completed', 600000, `transcription_${backend}`);
        if (!task) throw Error(`transcription_${backend}:missing_completed_task`);
        expect(task.resolvedBackend).toBe(backend); expect(task.documentId).toBeTruthy();
        evidence.chains.push({ backend, taskId: task.taskId, documentId: task.documentId, status: task.status });
        await uiExpect(page!.getByTestId('studio-transcription-task-row').filter({ hasText: path.basename(media[index]) })).toHaveAttribute('data-state', 'completed');
        await capture(`transcription-${backend}`);
        await checkpoint(`transcription_${backend}_completed`);
      }
      evidence.realAsr = true;
      const before = await docs(); expect(before).toHaveLength(2);
      evidence.documentIds = before.map(item => item.id);
      await checkpoint('reopen_documents');
      await closeApplication();
      const repository = new DocumentRepository(path.join(profile, 'subtitle-studio/documents'));
      for (const doc of before) {
        const snapshot = await repository.readSnapshot(doc.id);
        expect(snapshot.document.cues.length).toBeGreaterThan(0);
        expect(snapshot.document.cues.map(cue => cue.source.plain).join(' ').toLowerCase()).toContain('country');
        evidence.chains.find((item: any) => item.documentId === doc.id).cueCount = snapshot.document.cues.length;
      }
      await launch(); await page!.evaluate(() => { location.hash = '/tools/subtitle/studio'; }); await ready();
      expect((await docs()).map(item => item.id).sort()).toEqual(evidence.documentIds.slice().sort());
      evidence.reopened = true;
      await checkpoint('real_translation_start');
      for (const doc of await docs()) {
        const result = await page!.evaluate(async document => {
          // Credentials remain in the renderer/main call only; no fixture or report receives them.
          const stored = JSON.parse(localStorage.getItem('fusionkit-model')!).state;
          const selected = stored.profiles.find((item: any) => item.id === stored.assignment?.taskExecution) ?? stored.profiles[0];
          const config = { model: { profileId: selected.id, modelKey: selected.modelKey, endpoint: selected.baseUrl,
            apiFormat: selected.apiFormat, ...(selected.outputTokenParameter ? { outputTokenParameter: selected.outputTokenParameter } : {}) },
            language: 'zh', instructions: '', contextWindow: 32768, maxOutputTokens: 2048, maxBatchCues: 32 };
          const plan = await window.subtitleStudio.planTranslation({ documentId: document.id, revision: document.revision, config });
          if (!plan.ok) return { ok: false, error: plan.error };
          const started = await window.subtitleStudio.createTranslation({ documentId: document.id, revision: document.revision, planId: plan.value.planId, apiKey: selected.apiKey });
          return started.ok ? { ok: true } : { ok: false, error: started.error };
        }, doc);
        expect(result).toEqual({ ok: true });
      }
      await waitForState(async () => {
        const documents = await docs();
        const failed = documents.find(item => item.task && ['failed', 'interrupted', 'needs_configuration', 'cancelled'].includes(item.task.status));
        if (failed) throw Error(`real_translation:${failed.task!.status}`);
        return documents;
      }, documents => documents.length === 2 && documents.every(item => item.translationStatus === 'complete'), 180000, 'real_translation');
      evidence.realTranslationCompleted = true;
      await checkpoint('real_translation_completed');
      const translated = await docs();
      await page!.locator('.studio-document').filter({ hasText: translated[0].origin.displayName }).click();
      await uiExpect(page!.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
      await capture('translated-document-light');
      const readExports = async () => new Map(await Promise.all((await readdir(root)).filter(name => name.endsWith('.srt')).sort().map(async name => {
        const bytes = await readFile(path.join(root, name));
        return [name, { sha256: hash(bytes), byteSize: bytes.length, text: bytes.toString('utf8') }] as const;
      })));
      const exportUi = async (batch: boolean) => {
        const scope = batch ? 'batch' : 'single';
        await checkpoint(`${scope}_export_start`);
        const beforeExport = await readExports();
        await page!.getByRole('button', { name: batch ? '批量下载' : '下载', exact: true }).click();
        await page!.getByRole('menuitem', { name: batch ? '批量导出字幕' : '导出字幕', exact: true }).click();
        const dialog = page!.getByRole('dialog');
        await dialog.getByRole('button', { name: '检查导出', exact: true }).click();
        await dialog.getByRole('button', { name: `确认并导出 ${batch ? 2 : 1} 份`, exact: true }).click();
        await uiExpect(page!.getByTestId(batch ? 'studio-batch-result' : 'studio-export-result')).toHaveAttribute('data-outcome', 'success');
        await capture(batch ? 'batch-export-dark' : 'single-export-light');
        await page!.getByRole('button', { name: '完成', exact: true }).click();
        const afterExport = await readExports();
        for (const [name, previous] of beforeExport) expect(afterExport.get(name)?.sha256, 'Indexed export must preserve existing files.').toBe(previous.sha256);
        const added = [...afterExport].filter(([name]) => !beforeExport.has(name));
        expect(added).toHaveLength(batch ? 2 : 1);
        const expectedStems = (batch ? translated : [translated[0]]).map(doc => doc.origin.displayName.replace(/\.wav$/u, '')).sort();
        expect(added.map(([name]) => name.replace(/\.srt$/u, '').replace(/ \(\d+\)$/u, '')).sort()).toEqual(expectedStems);
        for (const [, output] of added) {
          expect(output.text.toLowerCase()).toContain('country');
          expect(output.text).toMatch(/[\u3400-\u9fff]/u);
          expect(output.text.replace(/\r\n/gu, '\n')).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/u);
        }
        evidence.exports.push({ scope, files: added.map(([name, output]) => ({ name, byteSize: output.byteSize, sha256: output.sha256 })) });
        await checkpoint(`${scope}_export_completed`, { addedFileCount: added.length });
      };
      await exportUi(false);
      for (const doc of translated) await page!.getByRole('checkbox', { name: `选择 ${doc.origin.displayName}`, exact: true }).check();
      await page!.evaluate(() => document.documentElement.classList.add('dark'));
      await (await app!.browserWindow(page!)).evaluate(window => window.setSize(786, 540));
      await page!.locator('#studio-library-trigger').click();
      await exportUi(true);
      for (const file of media) {
        expect(hash(await readFile(file))).toBe(hash(originalAudio));
      }
      expect(hash(await readFile(sourceAudio))).toBe(hash(originalAudio));
      expect(await hashFile(sourceModel)).toBe(evidence.sourceModelSha256);
      evidence.sourceModelUnchanged = true;
      evidence.singleAndBatchFilesVerified = true; evidence.sourcesUnchanged = true;
      expect(pageErrors).toEqual([]);
      await checkpoint('workflow_completed');
      workflowCompleted = true;
    } catch (error) {
      primaryFailure = error;
      evidence.failureStage = stage;
      // Do not serialize provider requests or arbitrary credential-bearing error objects.
      evidence.failureKind = error instanceof Error ? error.name : typeof error;
      if (stage.startsWith('launch_') || stage === 'reopen_configured_app') {
        evidence.startupFailure = error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : 'startup_failed';
      }
    } finally {
      const cleanupFailures: Error[] = [];
      const closed = await Promise.allSettled([closeApplication()]);
      if (closed[0].status === 'rejected') cleanupFailures.push(Error('application_cleanup_failed', { cause: closed[0].reason }));
      // Delete the isolated credential copy and model data, preserve only evidence and exported JFK subtitles.
      const directories = [profile, appRoot];
      const removed = await Promise.allSettled(directories.map(async directory => {
        if (path.dirname(directory) !== root || !root.startsWith(artifacts + path.sep)) throw Error('Unsafe owned-profile cleanup');
        await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }));
      removed.forEach((result, index) => { if (result.status === 'rejected') cleanupFailures.push(Error(`owned_${index === 0 ? 'profile' : 'app'}_cleanup_failed`, { cause: result.reason })); });
      let alive: Awaited<ReturnType<typeof processTable>> = [];
      let processAuditSucceeded = true;
      try { alive = await rememberProcesses(); }
      catch { processAuditSucceeded = false; cleanupFailures.push(Error('final_process_audit_failed')); }
      if (alive.length) cleanupFailures.push(Error('owned_processes_survived_cleanup'));
      evidence.processes = [...ownedProcesses.keys()].map(pid => ({ pid, alive: processAuditSucceeded ? alive.some(item => item.pid === pid) : null }));
      evidence.cleanup = { applicationClosed: closed[0].status === 'fulfilled', processAuditSucceeded, directories: removed.map((result, index) => ({ name: index === 0 ? 'profile' : 'app', removed: result.status === 'fulfilled' })), failures: cleanupFailures.map(error => error.message) };
      evidence.status = workflowCompleted && !primaryFailure && !cleanupFailures.length ? 'passed' : 'failed';
      evidence.pageErrors = pageErrors;
      // A report-write failure cannot bypass credential/model cleanup or process auditing.
      try { await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2)); }
      catch (error) { cleanupFailures.push(Error('result_report_write_failed', { cause: error })); }
      if (primaryFailure && cleanupFailures.length) throw new AggregateError([primaryFailure, ...cleanupFailures], 'Release workflow failed and cleanup or evidence publication also failed.');
      if (primaryFailure) throw primaryFailure;
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Release workflow cleanup or evidence publication failed.');
    }
  }, 1800000);
});
