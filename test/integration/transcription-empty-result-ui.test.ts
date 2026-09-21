import { createServer, type Server } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { buildEmptyResultUiApp } from './helpers/empty-result-ui-build';

const enabled = process.env.FUSIONKIT_TRANSCRIPTION_EMPTY_UI === '1';
type StudioSnapshot = { tasks: { taskId: string; displayName: string; status: string; documentId?: string; error?: unknown; automaticTranslation?: unknown }[]; traces: { operation: string }[] };
const studioControl = (app: ElectronApplication, command: Record<string, unknown>): Promise<StudioSnapshot> =>
  app.evaluate(async (_, input) => (globalThis as any).__studioT06Control(input), command);
const classicControl = (app: ElectronApplication, operation: 'seed' | 'snapshot'): Promise<any> =>
  app.evaluate((_, input) => (globalThis as any).__classicEmptyQueueControl({ operation: input }), operation);
const named = (label: string, name: string) => label.replace('{{name}}', name);

async function settled(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('.studio-workspace-tabs')?.getAnimations({ subtree: true })
    .some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
}
async function capture(page: Page, target: Locator, destination: string) {
  await settled(page);
  await target.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await uiExpect(target).toBeInViewport({ ratio: 1 });
  expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: destination, animations: 'disabled' });
}

describe.runIf(enabled)('no usable transcription is a distinct result in both actual Electron tools', () => {
  it.each([{ language: 'zh', theme: 'light', size: [1280, 860] }, { language: 'en', theme: 'dark', size: [820, 700] }] as const)(
    '$language / $theme: explains empty results, suppresses output/translation/retry, preserves failures and clears finished rows', async variant => {
      const fixture = await buildEmptyResultUiApp();
      const locale = JSON.parse(await readFile(`src/locales/${variant.language}/studio.json`, 'utf8'));
      const classic = JSON.parse(await readFile(`src/locales/${variant.language}/subtitle.json`, 'utf8')).local_transcriber;
      const common = JSON.parse(await readFile(`src/locales/${variant.language}/common.json`, 'utf8'));
      const logs: string[] = [], errors: string[] = [], requests: string[] = [];
      const evidence: Record<string, unknown> = { variant,
        boundary: 'Production renderer, preload, IPC and document stores. Studio runtime and task queue are controlled; classic validated session outcomes are seeded and fixture-owned removals use the real registry. Production execution, queue lifecycle and lease cleanup are covered by separate backend tests.' };
      let app: ElectronApplication | undefined, page: Page | undefined, server: Server | undefined, passed = false;
      try {
        server = createServer((request, response) => { requests.push(request.url ?? ''); response.writeHead(500); response.end('Unexpected automatic translation'); });
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
        app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
        for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
        expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(fixture.profile);
        page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
        await page.evaluate(({ language, theme, port }) => {
          localStorage.setItem('lang', language); localStorage.setItem('local-subtitle-transcriber-tour-done', '1');
          localStorage.setItem('subtitle-converter-tour-done', '1');
          localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
          localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'empty-result-auto', name: 'Local acceptance translator', provider: 'OpenAI', apiKey: 'synthetic-empty-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-empty', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'empty-result-auto', agent: null }, audioProfiles: [], audioAssignment: {} } }));
          location.hash = '/tools/subtitle/studio';
        }, { ...variant, port });
        await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await settled(page);
        const win = await app.browserWindow(page); await win.evaluate((window, size) => window.setSize(size[0], size[1]), [...variant.size]);
        await uiExpect(page.locator('html')).toHaveClass(variant.theme === 'dark' ? /dark/ : /^(?!.*\bdark\b).*$/);
        await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
        await studioControl(app, { operation: 'resources-ready' });
        await page.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
        const select = async (names: string[]) => {
          const files = names.map(name => path.join(fixture.artifacts, name));
          await Promise.all(files.map(file => writeFile(file, Buffer.alloc(44))));
          await app!.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
          await page!.getByTestId('studio-transcription-picker').getByRole('button', { name: locale.transcription.choose_media, exact: true }).click();
          await uiExpect(page!.getByTestId('studio-transcription-media-row')).toHaveCount(names.length);
          await page!.getByTestId('studio-transcription-start').click();
        };
        await select(['01-speech.wav']);
        let snapshot = await studioControl(app, { operation: 'snapshot' });
        await studioControl(app, { operation: 'complete', taskId: snapshot.tasks[0].taskId, cueCount: 1 });
        await page.locator('#studio-transcription-auto-translation').click();
        await uiExpect(page.locator('#studio-transcription-auto-translation')).toHaveAttribute('aria-checked', 'true');
        await select(['02-silence-or-music.wav', '03-damaged-recording.wav']);
        snapshot = await studioControl(app, { operation: 'snapshot' });
        await studioControl(app, { operation: 'no-content', taskId: snapshot.tasks[1].taskId });
        await studioControl(app, { operation: 'task-state', taskId: snapshot.tasks[2].taskId, status: 'failed' });
        const studioRows = page.getByTestId('studio-transcription-task-row');
        const emptyStudio = studioRows.filter({ hasText: '02-silence-or-music.wav' });
        const failureStudio = studioRows.filter({ hasText: '03-damaged-recording.wav' });
        await uiExpect(emptyStudio).toHaveAttribute('data-state', 'no_content');
        await uiExpect(emptyStudio).toContainText(locale.transcription.status_no_content);
        await uiExpect(emptyStudio.getByTestId('transcription-empty-result')).toContainText(common.transcription_empty.message);
        await uiExpect(emptyStudio.getByTestId('transcription-empty-result')).toContainText(common.transcription_empty.help);
        await uiExpect(emptyStudio.locator('.text-destructive, [role=alert], progress')).toHaveCount(0);
        await uiExpect(emptyStudio.getByRole('button', { name: locale.transcription.open_document, exact: true })).toHaveCount(0);
        await uiExpect(emptyStudio.getByRole('button', { name: locale.transcription.cancel_task, exact: true })).toHaveCount(0);
        await uiExpect(emptyStudio.getByRole('button', { name: locale.transcription.remove_task, exact: true })).toBeEnabled();
        await uiExpect(failureStudio).toHaveAttribute('data-state', 'failed');
        await uiExpect(failureStudio.locator('svg.text-destructive')).toHaveCount(1);
        await uiExpect(failureStudio).toContainText(locale.transcription.task_failed);
        snapshot = await studioControl(app, { operation: 'snapshot' });
        expect(snapshot.tasks[1]).toMatchObject({ status: 'no_content' });
        expect(snapshot.tasks[1].documentId).toBeUndefined(); expect(snapshot.tasks[1].error).toBeUndefined(); expect(snapshot.tasks[1].automaticTranslation).toBeUndefined();
        expect(snapshot.traces.filter(trace => trace.operation === 'automatic-handoff')).toEqual([]);
        expect(snapshot.traces.filter(trace => trace.operation === 'document-created')).toHaveLength(1);
        expect(requests).toEqual([]);
        evidence.studio = snapshot;
        await capture(page, emptyStudio, path.join(fixture.artifacts, `studio-empty-${variant.language}-${variant.theme}.png`));
        await page.getByTestId('studio-queue-clear-completed').click();
        await uiExpect(studioRows).toHaveCount(1); await uiExpect(studioRows).toHaveAttribute('data-state', 'failed');
        await uiExpect(page.getByTestId('studio-queue-clear-completed')).toBeDisabled();

        await page.evaluate(() => { location.hash = '/tools/subtitle/local-transcriber'; });
        await page.getByTestId('local-subtitle-task-queue').waitFor(); await settled(page);
        expect((await page.evaluate(() => window.localSubtitleApi.getSessionSnapshot())).ok).toBe(true);
        evidence.classic = await classicControl(app, 'seed');
        const classicRows = page.getByTestId('local-subtitle-task');
        const emptyClassic = classicRows.filter({ hasText: '02-silence-or-music.wav' });
        const failureClassic = classicRows.filter({ hasText: '03-damaged-recording.wav' });
        await uiExpect(classicRows).toHaveCount(3);
        await uiExpect(emptyClassic).toHaveAttribute('data-state', 'no_content');
        await uiExpect(emptyClassic).toContainText(classic.status.no_content);
        await uiExpect(emptyClassic.getByTestId('transcription-empty-result')).toContainText(common.transcription_empty.message);
        await uiExpect(emptyClassic.getByTestId('transcription-empty-result')).toContainText(common.transcription_empty.help);
        await uiExpect(emptyClassic.getByTestId('local-subtitle-transcription-progress')).toHaveCount(0);
        await uiExpect(emptyClassic.getByRole('button', { name: named(classic.actions.retry_task, '02-silence-or-music.wav'), exact: true })).toHaveCount(0);
        await uiExpect(emptyClassic.getByRole('button', { name: named(classic.actions.show_error_details, '02-silence-or-music.wav'), exact: true })).toHaveCount(0);
        await uiExpect(emptyClassic.getByRole('button', { name: /preview|预览|翻译/i })).toHaveCount(0);
        await uiExpect(emptyClassic.getByRole('button', { name: named(classic.actions.remove_task, '02-silence-or-music.wav'), exact: true })).toBeEnabled();
        await uiExpect(failureClassic).toHaveAttribute('data-state', 'failed');
        await uiExpect(failureClassic).toContainText(classic.status.failed);
        await uiExpect(failureClassic.locator('.bg-red-500')).toHaveCount(1);
        await uiExpect(failureClassic.getByRole('button', { name: named(classic.actions.retry_task, '03-damaged-recording.wav'), exact: true })).toBeEnabled();
        await capture(page, emptyClassic, path.join(fixture.artifacts, `classic-empty-${variant.language}-${variant.theme}.png`));
        await page.getByTestId('local-subtitle-task-queue').getByRole('button', { name: classic.actions.clear_completed, exact: true }).click();
        await uiExpect(classicRows).toHaveCount(1); await uiExpect(classicRows).toHaveAttribute('data-state', 'failed');
        await uiExpect(page.getByTestId('local-subtitle-task-queue').getByRole('button', { name: classic.actions.clear_completed, exact: true })).toBeDisabled();
        expect((await classicControl(app, 'snapshot')).batches.flatMap((batch: any) => batch.tasks).map((task: any) => task.status)).toEqual(['failed']);
        expect((await readdir(fixture.artifacts)).filter(name => /\.(srt|lrc|vtt|ass)$/i.test(name))).toEqual([]);
        for (const file of ['01-speech.wav', '02-silence-or-music.wav', '03-damaged-recording.wav']) expect(await readFile(path.join(fixture.artifacts, file))).toEqual(Buffer.alloc(44));
        expect(requests).toEqual([]); expect(errors).toEqual([]); passed = true;
      } finally {
        if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture.artifacts, 'final-window.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(fixture.artifacts, 'empty-result-evidence.json'), JSON.stringify({ passed, ...evidence, requests, errors }, null, 2));
        await writeFile(path.join(fixture.artifacts, 'electron.log'), logs.join(''));
        try { await app?.close(); } finally {
          if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
          await fixture.cleanup();
        }
      }
    }, 180000);
});
