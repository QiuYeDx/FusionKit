import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
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
async function persistedBytes(directory: string): Promise<Record<string, string>> {
  const entries: Array<readonly [string, string]> = [];
  const visit = async (current: string): Promise<void> => {
    await Promise.all((await readdir(current, { withFileTypes: true })).map(async file => {
      const absolute = path.join(current, file.name);
      if (file.isDirectory()) await visit(absolute);
      else if (file.isFile()) entries.push([path.relative(directory, absolute), createHash('sha256').update(await readFile(absolute)).digest('hex')]);
    }));
  };
  await visit(directory);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}
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
  it('freezes materials before transcription and explains then repairs automatic conflicts with an explicit new translation', async () => {
    const fixture = await buildTranscriptionUiApp('controlled');
    const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
    const repository = new DocumentRepository(path.join(fixture.profile, 'subtitle-studio/documents'));
    const requests: Array<{ raw: string; payload: ProviderPayload }> = [], errors: string[] = [], logs: string[] = [];
    const evidence: Record<string, unknown> = {
      boundary: 'Production main composition, owner/frame IPC checks, unchanged preload and native File capture, automatic knowledge capture, document sink/repository, automatic coordinator, TranslationService and HTTP executor remain real. The entire native transcription runtime/queue is replaced; production task-service capture/lease lifecycle is verified separately in transcription-task-service.test.ts. No actual ASR or paid model is used.',
      reportReadBoundary: 'The report is read through the production preload and IPC. Identical persisted document bytes and unchanged HTTP request counts prove no write/provider side effect. The backend unit tests separately assert that report reads never call initialization; this native scenario has already initialized translation before the report exists.',
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
          response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `自动译文：${item.text.replace(/checkpoint/gi, '存档点').replace(/savepoint/gi, '保存站')}` })) }) } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
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
        // First-use Tour is covered by consumer-ux; keep execution fixtures focused.
        localStorage.setItem('translation-knowledge-tour-done', '1');
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
      const materials = page.getByTestId('studio-automatic-materials');
      await materials.getByTestId('studio-materials-choose').click();
      await materials.getByTestId('studio-materials-recipe').click();
      await page.getByRole('option', { name: data.recipes[0].name, exact: true }).click();
      await materials.getByTestId('studio-materials-choose').click();
      await uiExpect(materials.getByTestId('studio-materials-source')).toHaveText('英语');
      await materials.getByTestId('studio-materials-topics').locator('summary').click();
      await materials.getByTestId(`studio-materials-topic-${data.subjects[0].id}`).check();
      const savedInstructions = 'Keep every subtitle concise and preserve all information.';
      const savedContext = 'These subtitles discuss Game X save locations.';
      await page.getByTestId('studio-automatic-instructions').fill(savedInstructions);
      await materials.getByTestId('studio-materials-more').locator(':scope > summary').click();
      await materials.getByTestId('studio-materials-context').fill(savedContext);
      await uiExpect(materials.getByTestId('studio-materials-summary')).toContainText(data.recipes[0].name);
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await materials.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await materials.getByTestId('studio-materials-summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-selection-light.png'), animations: 'disabled' });
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
      await page.getByTestId(`knowledge-entry-details-${term.id}`).click();
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
      const chooseMaterials = materials.getByTestId('studio-materials-choose');
      if (await chooseMaterials.getAttribute('aria-expanded') !== 'true') await chooseMaterials.click();
      await materials.getByTestId('studio-materials-picker').getByRole('button', { name: locale.refresh, exact: true }).click();
      await uiExpect(page.getByTestId('studio-automatic-knowledge-notice')).toHaveCount(0);
      await chooseMaterials.click();
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
      const failedTrackId = blocked.document.translationTracks[0].id;
      const reportRequest = { documentId: secondState.documentId!, trackId: failedTrackId };
      const documentsRoot = path.join(fixture.profile, 'subtitle-studio/documents');
      const reportReadBefore = await persistedBytes(documentsRoot);
      const historicalReport = await page.evaluate(async request => {
        const report = await window.subtitleStudio.readAutomaticKnowledgeReport(request);
        if (!report.ok) throw new Error(JSON.stringify(report)); return report.value;
      }, reportRequest);
      const repeatedReport = await page.evaluate(async request => {
        const report = await window.subtitleStudio.readAutomaticKnowledgeReport(request);
        if (!report.ok) throw new Error(JSON.stringify(report)); return report.value;
      }, reportRequest);
      expect(repeatedReport).toEqual(historicalReport);
      expect(historicalReport.state).toBe('available');
      if (historicalReport.state !== 'available') throw new Error('Expected an available automatic failure report');
      const termConflict = historicalReport.issues.find(issue => issue.code === 'term_conflict');
      expect(termConflict).toMatchObject({ severity: 'error', entryCount: 2, cueCount: 1 });
      expect(termConflict?.entries.map(entry => entry.title)).toEqual(expect.arrayContaining(['savepoint 冲突译名 1', 'savepoint 冲突译名 2']));
      expect(termConflict?.cues).toEqual([{ cueId: blocked.document.cues[0].id, number: 1, text: 'We reached the savepoint.' }]);
      expect(historicalReport.seed).toMatchObject({
        documentId: secondState.documentId, trackId: failedTrackId, config: blocked.automaticTranslation!.config,
        selection: { ...blocked.automaticTranslation!.knowledge!.selection, bindings: [], confirmations: [] },
        documentTopicIds: [data.subjects[0].id],
      });
      expect(await persistedBytes(documentsRoot)).toEqual(reportReadBefore);
      expect(await repository.readSnapshot(secondState.documentId!)).toEqual(blocked);
      expect(requests).toHaveLength(1);
      evidence.reportRead = { unchangedDocumentBytes: true, providerRequests: 0, historicalReport };
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

      await page.getByTestId('studio-automatic-knowledge-report').click();
      const reportDialog = page.getByRole('dialog').filter({ has: page.getByTestId('automatic-knowledge-report-content') });
      await uiExpect(reportDialog).toContainText('savepoint 冲突译名 1');
      await uiExpect(reportDialog).toContainText('savepoint 冲突译名 2');
      await uiExpect(reportDialog).toContainText('We reached the savepoint.');
      await uiExpect(page.locator('[data-testid="automatic-knowledge-report-issue"][data-issue-code="term_conflict"] .border-l')).toContainText(/1.*We reached the savepoint\./);
      expect(await reportDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await reportDialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-report-light.png'), animations: 'disabled' });
      expect(requests).toHaveLength(1);

      await page.getByTestId('automatic-knowledge-report-recheck').click();
      const repairDialog = page.getByRole('dialog').filter({ has: page.getByTestId('studio-translation-form') });
      await uiExpect(repairDialog.getByRole('heading', { name: locale.translation.title, exact: true })).toBeVisible();
      await uiExpect(page.getByRole('dialog')).toHaveCount(1);
      await uiExpect(page.getByTestId('studio-translation-check')).toBeEnabled();
      await uiExpect(repairDialog.getByTestId('studio-materials-source')).toHaveText('英语');
      await uiExpect(repairDialog.getByTestId('studio-materials-summary')).toContainText(data.recipes[0].name);
      await repairDialog.getByTestId('studio-materials-topics').locator('summary').click();
      await uiExpect(repairDialog.getByTestId(`studio-materials-topic-${data.subjects[0].id}`)).toBeChecked();
      await uiExpect(page.getByTestId('studio-translation-instructions')).toHaveValue(savedInstructions);
      await repairDialog.getByTestId('studio-materials-more').locator(':scope > summary').click();
      await uiExpect(repairDialog.getByTestId('studio-materials-context')).toHaveValue(savedContext);
      await repairDialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-repair-form-light.png'), animations: 'disabled' });
      // Starting performs a local check in this panel and leaves a real conflict
      // here without issuing a model request or falling back to plain translation.
      await page.getByTestId('studio-translation-start').click();
      await uiExpect(page.getByTestId('knowledge-full-preview')).toBeVisible();
      await uiExpect(page.getByTestId('knowledge-full-preview').locator('[data-issue-code="term_conflict"]')).toBeVisible();
      expect(requests).toHaveLength(1); expect(await repository.readSnapshot(secondState.documentId!)).toEqual(blocked);
      const exclusions = repairDialog.getByTestId('studio-materials-more').locator('details');
      await exclusions.locator('summary').click();
      await repairDialog.getByTestId('studio-materials-exclude-50000000-0000-4000-8000-000000000012').check();
      await uiExpect(page.getByTestId('knowledge-full-preview')).toHaveCount(0);
      await page.getByTestId('studio-translation-check').click();
      await uiExpect(page.getByTestId('knowledge-full-preview')).toBeVisible();
      await uiExpect(page.getByTestId('knowledge-full-preview').locator('[data-issue-code="term_conflict"]')).toHaveCount(0);
      expect(requests).toHaveLength(1); expect(await repository.readSnapshot(secondState.documentId!)).toEqual(blocked);
      await page.getByTestId('knowledge-full-preview').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-repair-checked-light.png'), animations: 'disabled' });
      await page.getByTestId('studio-translation-start').click();
      await uiExpect(page.getByTestId('studio-translation-form')).toHaveCount(0);
      await uiExpect.poll(async () => (await repository.readSnapshot(secondState.documentId!)).tasks.at(-1)?.status).toBe('completed');
      expect(requests).toHaveLength(2);
      const repaired = await repository.readSnapshot(secondState.documentId!), repairedTrack = repaired.document.translationTracks.at(-1)!;
      expect(repaired.document.translationTracks).toHaveLength(2); expect(repaired.tasks[0]).toEqual(blocked.tasks[0]);
      expect(repaired.automaticTranslation).toEqual(blocked.automaticTranslation);
      expect(repairedTrack.id).not.toBe(failedTrackId);
      const repairedExecution = validateExecutionRecord(repaired.executionRecords![repairedTrack.executionRef!.id]);
      expect(repairedExecution.plan.config).toMatchObject({
        model: blocked.automaticTranslation!.config.model,
        contextWindow: blocked.automaticTranslation!.config.contextWindow,
        maxOutputTokens: blocked.automaticTranslation!.config.maxOutputTokens,
        maxBatchCues: blocked.automaticTranslation!.config.maxBatchCues,
      });
      expect(repairedExecution.knowledge?.selection).toMatchObject({ ...historicalReport.seed!.selection, disabledEntryIds: ['50000000-0000-4000-8000-000000000012'] });
      expect(repairedExecution.knowledge?.documentTopicIds).toEqual([data.subjects[0].id]);
      expect(Object.values(repairedTrack.entries)[0].text.plain).toContain('保存站');
      const reportAfterRepair = await page.evaluate(async request => {
        const report = await window.subtitleStudio.readAutomaticKnowledgeReport(request);
        if (!report.ok) throw new Error(JSON.stringify(report)); return report.value;
      }, reportRequest);
      expect(reportAfterRepair.state).toBe('available');
      if (reportAfterRepair.state !== 'available') throw new Error('Historical report disappeared after repair');
      expect(reportAfterRepair.issues).toEqual(historicalReport.issues);
      expect(reportAfterRepair.material).toEqual(historicalReport.material);
      expect(reportAfterRepair.createdAt).toBe(historicalReport.createdAt);
      expect(reportAfterRepair.documentRevision).toBe(historicalReport.documentRevision);
      expect(requests).toHaveLength(2);
      evidence.repair = { newTrackId: repairedTrack.id, oldTrackId: failedTrackId, oldReportPreserved: true, providerRequests: 1, selectedGeneration: repairedExecution.knowledge!.generation };

      // The saved picker remains usable in English and a compact dark window.
      await page.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const english = JSON.parse(await readFile(path.resolve('src/locales/en/studio.json'), 'utf8'));
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await page.getByRole('tab', { name: english.workspace_documents, exact: true }).click();
      await page.locator(`[data-testid="studio-library-row"][data-document-id="${secondState.documentId}"] .studio-document`).click();
      await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed');
      await page.getByRole('combobox', { name: english.translation_track, exact: true }).click();
      await page.getByRole('option', { name: `${blocked.document.translationTracks[0].language} · 1`, exact: true }).click();
      await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed');
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await page.getByTestId('studio-automatic-knowledge-report').click();
      const retainedDialog = page.getByRole('dialog').filter({ has: page.getByTestId('automatic-knowledge-report-content') });
      await uiExpect(page.getByTestId('automatic-knowledge-report-content')).toHaveAttribute('data-state', 'available');
      await uiExpect(retainedDialog).toContainText('savepoint 冲突译名 1');
      await uiExpect(retainedDialog).toContainText('savepoint 冲突译名 2');
      await uiExpect(retainedDialog).toContainText('We reached the savepoint.');
      expect(await retainedDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
      expect(await retainedDialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      await retainedDialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-report-dark-english-narrow.png'), animations: 'disabled' });
      await page.getByTestId('automatic-knowledge-report-recheck').click();
      const retainedRepair = page.getByRole('dialog').filter({ has: page.getByTestId('studio-translation-form') });
      await uiExpect(retainedRepair.getByRole('heading', { name: english.translation.title, exact: true })).toBeVisible();
      await uiExpect(page.getByTestId('studio-translation-check')).toBeEnabled();
      await uiExpect(retainedRepair.getByTestId('studio-materials-summary')).toContainText(data.recipes[0].name);
      await uiExpect(page.getByTestId('studio-translation-instructions')).toHaveValue(savedInstructions);
      await uiExpect(page.getByTestId('knowledge-full-preview')).toHaveCount(0);
      expect(await retainedRepair.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
      await retainedRepair.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-repair-form-dark-english-narrow.png'), animations: 'disabled' });
      await page.getByTestId('studio-translation-close').click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(requests).toHaveLength(2);
      await page.getByRole('tab', { name: english.workspace_transcription, exact: true }).click();
      const compactMaterials = page.getByTestId('studio-automatic-materials');
      await compactMaterials.getByTestId('studio-materials-choose').click();
      await uiExpect(compactMaterials.getByTestId('studio-materials-recipe')).toHaveText(data.recipes[0].name);
      await uiExpect(page.getByTestId('studio-automatic-instructions')).toHaveValue(savedInstructions);
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(await compactMaterials.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await compactMaterials.getByTestId('studio-materials-summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-selection-dark-english-narrow.png'), animations: 'disabled' });
      await compactMaterials.getByTestId('studio-materials-choose').click();
      expect(requests).toHaveLength(2); expect(errors).toEqual([]); passed = true;
    } finally {
      if (!passed && page) await page.screenshot({ path: path.join(fixture.artifacts, 'automatic-knowledge-failure.png'), animations: 'disabled' }).catch(() => undefined);
      await writeFile(path.join(fixture.artifacts, 'automatic-knowledge-evidence.json'), JSON.stringify({ passed, ...evidence, requests, errors, logs }, null, 2));
      try { const child = app?.process(); await app?.close(); if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true); }
      finally { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await fixture.cleanup(); }
    }
  }, 180000);
});
