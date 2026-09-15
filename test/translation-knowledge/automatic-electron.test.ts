import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { buildTranscriptionUiApp } from '../subtitle-studio/helpers/transcription-ui-build';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateExecutionRecord } from '../../src/subtitle-studio/execution-record-contract';
import { knowledgeFixture } from './fixtures';

type RuntimeState = { tasks: Array<{ taskId: string; documentId?: string; status: string; automaticTranslation?: { status: string; taskId?: string } }> };
type ProviderPayload = { items: Array<{ id: string; text: string }>; translationKnowledge?: { items: Array<{ kind: string; applicableItemIds: string[] }> } };
const control = (app: ElectronApplication, command: Record<string, unknown>): Promise<RuntimeState> => app.evaluate(async (_, value) => (globalThis as any).__studioT06Control(value), command);
async function drop(page: Page, file: string) {
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.hidden = true; input.dataset.automaticMediaDrop = ''; document.body.append(input); });
  await page.locator('[data-automatic-media-drop]').setInputFiles(file);
  await page.evaluate(() => {
    const input = document.querySelector('[data-automatic-media-drop]') as HTMLInputElement;
    const transfer = new DataTransfer(); Array.from(input.files!).forEach(file => transfer.items.add(file));
    const target = document.querySelector('[data-testid=studio-transcription-picker]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    input.remove(); // Production preload captures OS-backed File paths synchronously.
  });
}

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('automatic knowledge translation through native Electron', () => {
  it('freezes selected materials before transcription, keeps old terminology after an edit, and blocks conflicting subtitles without a request', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio/documents'));
    const requests: Array<{ raw: string; payload: ProviderPayload }> = [], errors: string[] = [], logs: string[] = [];
    const evidence: Record<string, unknown> = {
      boundary: 'Production main composition, owner/frame IPC checks, unchanged preload and native File capture, automatic knowledge capture, document sink/repository, automatic coordinator, TranslationService and HTTP executor remain real. The entire native transcription runtime/queue is replaced; production task-service capture/lease lifecycle is verified separately in transcription-task-service.test.ts. No actual ASR or paid model is used.',
    };
    let app: ElectronApplication | undefined, page: Page | undefined, server: Server | undefined, passed = false;
    try {
      const data = knowledgeFixture(), term = data.entries.find(entry => entry.kind === 'term')!;
      term.scope.condition = { mode: 'none' }; if (term.kind === 'term') term.payload.strength = 'required';
      for (const [index, target] of ['保存站', '存档柱'].entries()) data.entries.push({
        ...structuredClone(term), id: `50000000-0000-4000-8000-00000000001${index + 1}`, title: `savepoint 冲突译名 ${index + 1}`,
        derivedFrom: [], payload: { ...term.payload, source: 'savepoint', target, aliases: [] },
      });
      const input = path.join(fixture.artifacts, 'automatic.fktk.json');
      const mediaFiles = ['01 frozen-checkpoint.wav', '02 conflicting-savepoint.wav'].map(name => path.join(fixture.artifacts, name));
      await writeFile(input, JSON.stringify(data)); await Promise.all(mediaFiles.map(file => writeFile(file, Buffer.alloc(44))));
      server = createServer(async (request, response) => {
        try {
          let raw = ''; for await (const chunk of request) raw += String(chunk);
          const body = JSON.parse(raw), payload = JSON.parse(body.messages[1].content) as ProviderPayload;
          requests.push({ raw, payload }); response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `自动译文：${item.text.replace(/checkpoint/gi, '存档点')}` })) }) } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
        } catch (error) { errors.push(`Provider fixture: ${String(error)}`); response.writeHead(500); response.end(); }
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; env.NODE_ENV = 'test';
      app = await electron.launch({ args: [fixture.appRoot, `--user-data-dir=${fixture.profile}`], cwd: fixture.appRoot, env });
      for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { logs.push(String(data)); if (logs.length > 200) logs.shift(); });
      page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'automatic-knowledge-fixture', name: 'Local automatic translation fixture', provider: 'DeepSeek', apiKey: 'synthetic-automatic-knowledge-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'automatic-knowledge-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/translation-knowledge';
      }, port);
      await page.reload();
      const nativeWindow = await app.browserWindow(page); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByTestId('knowledge-import').click(); await page.getByRole('button', { name: '确认导入', exact: true }).click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      const adopted = await page.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        // Required terminology follows the product's individual review boundary.
        let current = read.value;
        for (const entry of read.value.data.entries) {
          const result = await window.translationKnowledge.reviewEntries({ generation: current.generation, ids: [entry.id], action: 'adopt' });
          if (!result.ok) throw new Error(JSON.stringify(result)); current = result.value;
        }
        return current;
      });
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      await control(app, { operation: 'resources-ready' }); await page.getByTestId('studio-transcription-runtime-row').getByRole('button').click();
      await page.locator('#studio-transcription-auto-translation').click();
      await page.locator('#studio-automatic-knowledge-enabled').click();
      await page.getByTestId('automatic-knowledge-source-language').click(); await page.getByRole('option', { name: '英语', exact: true }).click();
      await page.getByTestId('automatic-knowledge-recipe').click(); await page.getByRole('option', { name: data.recipes[0].name, exact: true }).click();
      await page.getByTestId(`automatic-knowledge-topic-${data.subjects[0].id}`).check();
      await uiExpect(page.getByTestId('automatic-knowledge-save')).toBeEnabled();
      const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('automatic-knowledge-content') });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-selection-light.png'), animations: 'disabled' });
      await page.getByTestId('automatic-knowledge-save').click(); await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      await uiExpect(page.locator('#studio-automatic-knowledge-enabled')).toHaveAttribute('aria-checked', 'true');
      await drop(page, mediaFiles[0]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      await uiExpect.poll(async () => (await control(app!, { operation: 'snapshot' })).tasks.length).toBe(1);
      const firstNative = (await control(app, { operation: 'snapshot' })).tasks[0];
      expect(requests).toHaveLength(0);

      const beforeDocument = await page.evaluate(async collectionId => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        const plan = await window.translationKnowledge.planMaintenance({ generation: read.value.generation, action: 'archive', targets: [{ group: 'collections', id: collectionId }] });
        if (!plan.ok) throw new Error(JSON.stringify(plan)); return plan.value;
      }, data.collections[0].id);
      expect(beforeDocument.tasks?.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'automatic_preparation', status: 'active' })]));
      expect(beforeDocument.tasks?.items.find(item => item.kind === 'automatic_preparation')).not.toHaveProperty('documentId');
      evidence.pendingReference = beforeDocument.tasks;
      await page.evaluate(() => { location.hash = '/tools/translation-knowledge'; });
      await page.locator(`[data-entry-id="${term.id}"]`).click();
      await page.getByTestId('knowledge-entry-maintenance').click();
      const preparationDialog = page.getByRole('dialog').filter({ has: page.getByTestId('knowledge-maintenance-tasks') });
      await uiExpect(preparationDialog).toContainText('自动翻译准备资料');
      await uiExpect(preparationDialog).toContainText('转写队列');
      await page.getByTestId('knowledge-maintenance-tasks').locator('details > summary').first().click();
      await page.getByTestId('knowledge-maintenance-tasks').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-pending-maintenance.png'), animations: 'disabled' });
      await preparationDialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByRole('tab', { name: locale.workspace_transcription, exact: true }).click();
      expect(requests).toHaveLength(0);

      const edited = await page.evaluate(async termId => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        const term = read.value.data.entries.find(entry => entry.id === termId); if (term?.kind !== 'term') throw new Error('Missing term');
        const result = await window.translationKnowledge.saveRecord({ generation: read.value.generation, group: 'entries', record: { ...term, payload: { ...term.payload, target: '后来修改的检查站' } }, adopt: true });
        if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
      }, term.id);
      expect(edited.generation).toBeGreaterThan(adopted.generation);
      const texts = ['We reached the checkpoint.', 'Wait here until the next scene.'];
      await control(app, { operation: 'complete', taskId: firstNative.taskId, texts });
      await uiExpect.poll(() => requests.length).toBe(1);
      const firstDocumentId = (await control(app, { operation: 'snapshot' })).tasks[0].documentId!;
      await uiExpect.poll(async () => (await repository.readSnapshot(firstDocumentId)).tasks[0]?.status).toBe('completed');
      const first = await repository.readSnapshot(firstDocumentId), track = first.document.translationTracks[0];
      const execution = validateExecutionRecord(first.executionRecords![track.executionRef!.id]);
      const frozenTerm = execution.knowledge!.data.entries.find(entry => entry.id === term.id)!;
      expect(frozenTerm.kind === 'term' && frozenTerm.payload.target).toBe('存档点');
      expect(first.automaticTranslation?.knowledge?.generation).toBe(adopted.generation);
      expect(execution.knowledge!.generation).toBe(adopted.generation);
      expect(requests[0].raw).toContain('存档点'); expect(requests[0].raw).not.toContain('后来修改的检查站');
      expect(requests[0].payload.translationKnowledge?.items.some(item => item.kind === 'term' && item.applicableItemIds.includes('u1'))).toBe(true);
      expect(Object.values(execution.requests).map(request => request.httpBody)).toContain(requests[0].raw);
      expect(JSON.stringify(first)).not.toContain('synthetic-automatic-knowledge-key');
      await control(app, { operation: 'complete', taskId: firstNative.taskId, texts }); expect(requests).toHaveLength(1);
      evidence.frozen = { documentId: firstDocumentId, sourceTaskId: firstNative.taskId, executionId: execution.id, generation: execution.knowledge!.generation, liveGeneration: edited.generation, requestCount: requests.length };

      // Refresh the common selection explicitly for the next submission.
      await page.getByTestId('studio-automatic-knowledge-choose').click();
      await uiExpect(page.getByTestId('automatic-knowledge-save')).toBeEnabled(); await page.getByTestId('automatic-knowledge-save').click();
      await drop(page, mediaFiles[1]); await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
      await page.getByTestId('studio-transcription-start').click();
      await uiExpect.poll(async () => (await control(app!, { operation: 'snapshot' })).tasks.length).toBe(2);
      const secondNative = (await control(app, { operation: 'snapshot' })).tasks[1];
      await control(app, { operation: 'complete', taskId: secondNative.taskId, texts: ['We reached the savepoint.'] });
      const secondState = (await control(app, { operation: 'snapshot' })).tasks[1];
      const blocked = await repository.readSnapshot(secondState.documentId!);
      expect(secondState.status).toBe('completed'); expect(blocked.document.cues[0].source.plain).toBe('We reached the savepoint.');
      expect(blocked.tasks).toHaveLength(1); expect(blocked.tasks[0]).toMatchObject({ status: 'failed', attempts: 0, translation: { error: 'knowledge_check_failed' } });
      expect(secondState.automaticTranslation).toEqual({ status: 'needs_configuration', taskId: blocked.tasks[0].id });
      expect(requests).toHaveLength(1); expect(blocked.document.translationTracks[0].entries).toEqual({});
      evidence.blocked = { documentId: secondState.documentId, error: blocked.tasks[0].translation?.error, providerRequests: 0, transcriptionStatus: secondState.status };
      const blockedRow = page.getByTestId('studio-transcription-task-row').filter({ hasText: path.basename(mediaFiles[1]) });
      await uiExpect(blockedRow.locator('.studio-transcription-auto-label')).toHaveAttribute('data-state', 'needs_configuration');
      await uiExpect(blockedRow).toContainText(locale.transcription.auto_translation_recovery_short);
      await blockedRow.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-conflict-queue.png'), animations: 'disabled' });
      await blockedRow.getByRole('button', { name: locale.transcription.open_document, exact: true }).click();
      await uiExpect(page.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', 'documents');
      await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed');
      await uiExpect(page.locator('.studio-cue-text')).toContainText('We reached the savepoint.');
      await uiExpect(page.getByText(locale.translation.legacy_restart, { exact: true })).toHaveCount(0);
      await uiExpect(page.locator('.studio-document-meta')).toContainText(locale.source_only);
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-conflict-document.png'), animations: 'disabled' });

      // The saved picker remains usable in English and a compact dark window.
      await page.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const english = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8'));
      await page.getByRole('tab', { name: english.workspace_transcription, exact: true }).click();
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await page.getByTestId('studio-automatic-knowledge-choose').click();
      await uiExpect(page.getByTestId('automatic-knowledge-save')).toBeEnabled();
      await uiExpect(page.getByTestId('automatic-knowledge-save')).toHaveText('Use materials');
      const compactDialog = page.getByRole('dialog').filter({ has: page.getByTestId('automatic-knowledge-content') });
      expect(await compactDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
      expect(await compactDialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-selection-dark-english-narrow.png'), animations: 'disabled' });
      await page.getByTestId('automatic-knowledge-cancel').click();
      expect(requests).toHaveLength(1); expect(errors).toEqual([]); passed = true;
    } finally {
      if (!passed && page) await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-failure.png'), animations: 'disabled' }).catch(() => undefined);
      await writeFile(path.join(fixture.artifacts, 'automatic-knowledge-evidence.json'), JSON.stringify({ passed, ...evidence, requests, errors, logs }, null, 2));
      try { const child = app?.process(); await app?.close(); if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true); }
      finally { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await fixture.cleanup(); }
    }
  }, 180000);
});
