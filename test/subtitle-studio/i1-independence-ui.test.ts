import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import type { DocumentPage } from '../../src/subtitle-studio/ipc-contract';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import type { TranslationConfig } from '../../src/subtitle-studio/translation-contract';

const enabled = process.env.FUSIONKIT_STUDIO_E2E === '1';
const removed = process.env.FUSIONKIT_STUDIO_REMOVED === '1';

describe.runIf(enabled)(`Subtitle Studio I1 production independence (${removed ? 'removed build' : 'coexistence build'})`, () => {
  it('imports, translates, restarts and exports independently of simulated old data and the original source file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-i1-independent-'));
    const userData = path.join(root, 'profile');
    const artifacts = path.resolve('test-results/subtitle-studio-i1-independence', removed ? 'removed' : 'coexistence');
    let app: ElectronApplication | undefined;
    let server: Server | undefined;
    const errors: string[] = [];
    const serverErrors: string[] = [];
    const requests: { path: string; items: { id: string; text: string }[] }[] = [];
    const exports = new Map<string, Buffer>();
    try {
      await mkdir(artifacts, { recursive: true });
      // Disposable sentinels simulate old data/resources; these are never real application directories.
      const simulated = path.join(root, 'simulated-old-tool');
      const oldData = path.join(simulated, 'data', ['subtitle', 'translation'].join('-'));
      const oldModels = path.join(simulated, 'resources', ['local', 'subtitle'].join('-'), 'models');
      const sentinels = new Map([
        [path.join(oldData, 'synthetic-task.json'), Buffer.from('{"synthetic":true,"untouched":true}\n')],
        [path.join(oldModels, 'synthetic-model.bin'), Buffer.from('synthetic marker; not a model')],
      ]);
      for (const [file, bytes] of sentinels) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
      const sourceLines = ['First independent scene.', 'A simultaneous second scene.', 'Last independent scene.'];
      const targetLines = sourceLines.map(text => `译文：${text}`);
      const original = Buffer.from('\ufeff7\r\n00:00:01,125 --> 00:00:03,500\r\n' + sourceLines[0] + '\r\n\r\n20\r\n00:00:01,125 --> 00:00:04,000\r\n' + sourceLines[1] + '\r\n\r\n42\r\n00:00:05,250 --> 00:00:07,750\r\n' + sourceLines[2] + '\r\n');
      const input = path.join(root, 'independent-source.srt');
      await writeFile(input, original);
      server = createServer(async (request, response) => {
        try {
          let raw = '';
          for await (const chunk of request) {
            raw += chunk.toString();
            if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Synthetic request exceeded test bound');
          }
          const body = JSON.parse(raw) as { messages: { content: string }[] };
          const payload = JSON.parse(body.messages[1].content) as { items: { id: string; text: string }[] };
          requests.push({ path: request.url ?? '', items: payload.items });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `译文：${item.text}` })) }) } }], usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 } }));
        } catch (error) {
          serverErrors.push(error instanceof Error ? error.message : String(error));
          response.writeHead(500); response.end('Synthetic test request rejected');
        }
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
      const port = (server.address() as { port: number }).port;
      const openStudio = async (page: Page) => {
        await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
        await page.getByTestId('subtitle-studio').waitFor();
        await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      };
      const launch = async () => {
        app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }, timeout: 30000 });
        const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'));
        expect(await realpath(actualUserData)).toBe(await realpath(userData));
        const page = await app.firstWindow();
        page.on('pageerror', error => errors.push(error.message));
        await openStudio(page);
        if (removed) {
          const oldApis = [['subtitle', 'Translation', 'Api'].join(''), ['local', 'Subtitle', 'Api'].join('')];
          expect(await page.evaluate(names => names.map(name => typeof Reflect.get(window, name)), oldApis)).toEqual(['undefined', 'undefined']);
        }
        return page;
      };
      const snapshot = async (page: Page): Promise<DocumentPage> => page.evaluate(async () => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const listed = await window.subtitleStudio.listDocuments({ offset: 0 });
          if (!listed.ok) throw new Error(listed.error);
          if (listed.value.documents.length !== 1) throw new Error('Expected one isolated document');
          const doc = listed.value.documents[0];
          const detail = await window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 });
          if (detail.ok) return detail.value;
          if (detail.error !== 'revision_conflict') throw new Error(detail.error);
        }
        throw new Error('revision_conflict after 10 fresh document snapshots');
      });
      const saveDialog = async (destination: string) => app!.evaluate(({ dialog }, selected) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
      }, destination);
      const remember = async (destination: string) => { const bytes = await readFile(destination); exports.set(destination, bytes); return bytes; };
      const parseOutput = (bytes: Buffer, options: ExportOptions) => {
        const text = iconv.decode(bytes, options.encoding);
        return importSubtitleText(text, { format: options.format, displayName: `synthetic.${options.format}`, encoding: options.encoding, digest: createHash('sha256').update(bytes).digest('hex') }, randomUUID);
      };

      let page = await launch();
      await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, input);
      const imported = await page.evaluate(() => window.subtitleStudio.importSubtitle({ encoding: 'utf-8' }));
      expect(imported.ok).toBe(true);
      if (!imported.ok || !imported.value) throw new Error('Synthetic native import failed');
      const document = imported.value;
      const config: TranslationConfig = { model: { profileId: 'independence-fixture', modelKey: 'fixture-chat', endpoint: `http://127.0.0.1:${port}/v1`, apiFormat: 'chat_completions' }, language: 'zh', instructions: '', contextWindow: 8192, maxOutputTokens: 1024, maxBatchCues: 1 };
      const planned = await page.evaluate(({ document, config }) => window.subtitleStudio.planTranslation({ documentId: document.id, revision: document.revision, config }), { document, config });
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error(planned.error);
      expect(planned.value.batchCount).toBe(3);
      const created = await page.evaluate(({ document, planId }) => window.subtitleStudio.createTranslation({ documentId: document.id, revision: document.revision, planId, apiKey: 'isolated-synthetic-key' }), { document, planId: planned.value.planId });
      expect(created.ok).toBe(true);
      await uiExpect.poll(async () => (await snapshot(page)).tasks[0]?.status, { timeout: 30000 }).toBe('completed');
      const completed = await snapshot(page);
      expect(completed.tasks[0].completedBatchIds).toHaveLength(3);
      expect(requests).toHaveLength(3);
      expect(requests.flatMap(request => request.items.map(item => item.text))).toEqual(sourceLines);
      expect(requests.every(request => request.path === '/v1/chat/completions')).toBe(true);
      const trackId = completed.translationTracks[0].id;
      expect(completed.cues.map(cue => completed.translationTracks[0].entries[cue.id].text.plain)).toEqual(targetLines);
      for (const [file, bytes] of sentinels) expect(await readFile(file)).toEqual(bytes);
      expect(await readFile(input)).toEqual(original);
      await page.locator('.studio-document').filter({ hasText: document.origin.displayName }).click();
      await page.getByRole('heading', { name: document.origin.displayName, exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, 'translated-before-restart.png'), animations: 'disabled' });
      await app!.close(); app = undefined;

      page = await launch();
      expect(await snapshot(page)).toEqual(completed);
      const originalDestination = path.join(root, 'original-after-restart.srt');
      await saveDialog(originalDestination);
      const downloaded = await page.evaluate(summary => window.subtitleStudio.exportSource({ documentId: summary.id, revision: summary.revision }), completed.summary);
      expect(downloaded.ok && downloaded.value !== null).toBe(true);
      expect(await remember(originalDestination)).toEqual(original);
      for (const mode of ['source', 'target', 'bilingual'] as const) for (const format of ['srt', 'lrc'] as const) for (const order of ['source-first', 'target-first'] as const) {
        const options: ExportOptions = { mode, format, order, trackId, encoding: format === 'srt' ? 'utf-16le' : 'utf-8', bom: true, newline: 'crlf', incomplete: 'block', missingEnd: { mode: 'block' } };
        const result = await page.evaluate(({ summary, options }) => window.subtitleStudio.planExport({ documentId: summary.id, revision: summary.revision, options }), { summary: completed.summary, options });
        expect(result.ok).toBe(true);
        if (!result.ok || !result.value.planId) throw new Error('Synthetic export plan blocked');
        const plan = result.value;
        expect(plan).toMatchObject({ revision: completed.summary.revision, cueCount: 3, partial: false, missingCount: 0, staleCount: 0 });
        const destination = path.join(root, `${mode}-${format}-${order}.${format}`);
        await saveDialog(destination);
        const exported = await page.evaluate(plan => window.subtitleStudio.exportDocument({ documentId: plan.documentId, revision: plan.revision, planId: plan.planId!, acceptedLosses: plan.issues.filter(issue => issue.confirmation).map(issue => issue.code) }), plan);
        expect(exported.ok && exported.value).toMatchObject({ revision: completed.summary.revision, mode, incomplete: 'block', partial: false });
        const parsed = parseOutput(await remember(destination), options);
        const expected = completed.cues.flatMap((cue, index) => {
          const texts = mode === 'source' ? [sourceLines[index]] : mode === 'target' ? [targetLines[index]] : order === 'source-first' ? [sourceLines[index], targetLines[index]] : [targetLines[index], sourceLines[index]];
          return (format === 'srt' ? [texts.join('\n')] : texts).map(text => ({ text, start: cue.timing.startMs, end: format === 'srt' ? cue.timing.endMs : null }));
        });
        expect(parsed.cues.map(cue => ({ text: cue.source.plain, start: cue.timing.startMs, end: cue.timing.endMs }))).toEqual(expected);
        expect(await snapshot(page)).toEqual(completed);
        expect(requests).toHaveLength(3);
      }
      for (const [file, bytes] of sentinels) expect(await readFile(file)).toEqual(bytes);
      await app!.close(); app = undefined;
      await rm(oldData, { recursive: true, force: true });
      await rm(oldModels, { recursive: true, force: true });
      await rm(input);

      page = await launch();
      expect(await snapshot(page)).toEqual(completed);
      const survivingSource = path.join(root, 'original-without-source-or-old-data.srt');
      await saveDialog(survivingSource);
      const independentOriginal = await page.evaluate(summary => window.subtitleStudio.exportSource({ documentId: summary.id, revision: summary.revision }), completed.summary);
      expect(independentOriginal.ok && independentOriginal.value !== null).toBe(true);
      expect(await remember(survivingSource)).toEqual(original);
      const afterRemovalOptions: ExportOptions = { mode: 'target', format: 'lrc', trackId, order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' } };
      const independentPlan = await page.evaluate(({ summary, options }) => window.subtitleStudio.planExport({ documentId: summary.id, revision: summary.revision, options }), { summary: completed.summary, options: afterRemovalOptions });
      if (!independentPlan.ok || !independentPlan.value.planId) throw new Error('Export after fixture removal failed');
      const survivingTarget = path.join(root, 'target-without-source-or-old-data.lrc');
      await saveDialog(survivingTarget);
      const independentExport = await page.evaluate(plan => window.subtitleStudio.exportDocument({ documentId: plan.documentId, revision: plan.revision, planId: plan.planId!, acceptedLosses: plan.issues.filter(issue => issue.confirmation).map(issue => issue.code) }), independentPlan.value);
      expect(independentExport.ok && independentExport.value !== null).toBe(true);
      expect(parseOutput(await remember(survivingTarget), afterRemovalOptions).cues.map(cue => cue.source.plain)).toEqual(targetLines);
      const deleted = await page.evaluate(summary => window.subtitleStudio.deleteDocument({ documentId: summary.id, revision: summary.revision }), completed.summary);
      expect(deleted.ok).toBe(true);
      const list = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
      expect(list.ok && list.value.total).toBe(0);
      for (const [file, bytes] of exports) expect(await readFile(file)).toEqual(bytes);
      expect(requests).toHaveLength(3);
      expect(errors).toEqual([]); expect(serverErrors).toEqual([]);
      expect((await readdir(root)).some(name => /^\.subtitle-studio-.*\.tmp$/.test(name))).toBe(false);
      await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ build: removed ? 'removed' : 'coexistence', revision: completed.summary.revision, requests: requests.length, translatedBatches: completed.tasks[0].completedBatchIds.length, exportCombinations: 12, outputsSurvivingDelete: exports.size, oldSentinelsUnchangedBeforeRemoval: true, sourceAndOldFixturesRemovedBeforeFinalRestart: true, errors, serverErrors }, null, 2) + '\n');
    } finally {
      try { await app?.close(); }
      finally {
        server?.closeAllConnections();
        await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }, 180000);
});
