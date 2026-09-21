import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { validateExecutionRecord } from '../../src/subtitle-studio/execution-record-contract';
import { ENTITY_ARRAYS } from '../../src/translation-knowledge/schemas';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { DocumentPage } from '../../src/subtitle-studio/ipc-contract';
import type { KnowledgeBatchTranslationRequest, KnowledgeBatchTranslationPreview, KnowledgeBatchTranslationResult } from '../../src/subtitle-studio/knowledge-batch-contract';

type ProviderPayload = {
  items: Array<{ id: string; text: string }>;
  translationRequirements: string;
  context: { precedingSource: string[]; followingSource: string[]; priorModelTranslations: string[] };
  translationKnowledge: { items: Array<{ kind: string; required: boolean; applicableItemIds: string[] }> };
};

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('batch knowledge translation through native Electron', () => {
  let app: ElectronApplication | undefined, server: Server | undefined, root = '';
  const artifacts = path.resolve('test-results/translation-knowledge-batch');
  afterAll(async () => {
    try {
      const child = app?.process();
      await app?.close();
      if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('checks three files, explicitly starts two ready files, and retains independent frozen knowledge and requests', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-batch-e2e-'));
    await mkdir(artifacts, { recursive: true });
    const requests: Array<{ raw: string; payload: ProviderPayload }> = [], errors: string[] = [];
    server = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk.toString();
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
        const payload = JSON.parse(body.messages[1].content) as ProviderPayload;
        requests.push({ raw, payload });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
          content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `批量译文：${item.text.replace(/checkpoint/gi, '存档点')}` })) }),
        } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
      } catch (error) {
        errors.push(`Provider fixture: ${String(error)}`);
        response.writeHead(500); response.end();
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const fixture = knowledgeFixture();
    const term = fixture.entries.find(entry => entry.kind === 'term')!;
    const context = fixture.entries.find(entry => entry.kind === 'context')!;
    const rule = fixture.entries.find(entry => entry.kind === 'rule')!;
    term.scope.condition = { mode: 'none' };
    if (term.kind === 'term') term.payload.strength = 'required';
    context.scope.condition = { mode: 'requires_confirmation', text: '这句已由用户确认在讨论游戏保存进度。' };
    rule.scope.requiredSubjects.push({ subjectId: fixture.subjects[1].id, role: 'speaker' });
    const historicalSource = { ...fixture.sources[0], id: '40000000-0000-4000-8000-000000000010', title: '历史出处', excerpt: '仅用于验证冻结历史派生证据，不能发送给供应商。' };
    fixture.sources.push(historicalSource);
    term.derivedFrom.push({ entryId: '50000000-0000-4000-8000-000000000010', revision: 1, digest: sha256Canonical('historical term'), evidenceSourceId: historicalSource.id });
    const destination = { ...fixture.collections[0], id: '30000000-0000-4000-8000-000000000010', name: '以后人工保存的资料' };
    fixture.collections.push(destination);
    fixture.recipes[0].learningSuggestion = 'save_reviewed'; fixture.recipes[0].suggestedDestinationCollectionId = destination.id;
    // The third file alone matches these incompatible required terms.
    for (const [index, target] of ['保存站', '存档柱'].entries()) fixture.entries.push({
      ...structuredClone(term), id: `50000000-0000-4000-8000-00000000001${index + 1}`, title: `savepoint 的冲突译名 ${index + 1}`,
      derivedFrom: [], payload: { ...term.payload, source: 'savepoint', target, aliases: [] },
    });
    const input = path.join(root, 'batch.fktk.json');
    const sources = [
      { name: '01 Alpine — twenty four subtitle cues across independent analysis windows.lrc', marker: 'Alpine', count: 24 },
      { name: '02 Birch — separate short document.lrc', marker: 'Birch', count: 2 },
      { name: '03 Cobalt — conflicting required terminology needs review.lrc', marker: 'Cobalt', count: 2 },
    ];
    const texts = sources.map(source => Array.from({ length: source.count }, (_, index) => {
      const number = index + 1;
      const text = source.marker === 'Cobalt' ? `Cobalt savepoint ${number}.`
        : number === 1 || number === 21 ? `${source.marker} checkpoint ${number}.` : `${source.marker} dialogue ${number}.`;
      return `[00:${String(number).padStart(2, '0')}]${text}`;
    }).join('\n'));
    await writeFile(input, JSON.stringify(fixture));
    await Promise.all(sources.map((source, index) => writeFile(path.join(root, source.name), texts[index])));
    const profile = path.join(root, 'profile');
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const ui: Page = await app.firstWindow();
    ui.on('pageerror', error => errors.push(error.message));
    const settledFrames = () => ui.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const capture = async (name: string, target?: Locator) => {
      if (target) await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await settledFrames();
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const dialogFor = (testId: string) => ui.getByRole('dialog').filter({ has: ui.getByTestId(testId) });
    const geometry = async (dialog: Locator) => {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    };
    const readDocument = (name: string): Promise<DocumentPage> => ui.evaluate(async name => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
      const document = list.value.documents.find(item => item.origin.displayName === name);
      if (!document) throw new Error('Missing batch fixture document');
      const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!result.ok) throw new Error(result.error); return result.value;
    }, name);

    try {
      await ui.evaluate(port => {
        // First-use Tour is covered by consumer-ux; keep execution fixtures focused.
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'batch-knowledge-fixture', name: 'Local batch translation fixture', provider: 'DeepSeek', apiKey: 'synthetic-batch-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'batch-knowledge-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/translation-knowledge';
      }, port);
      await ui.reload();
      const nativeWindow = await app.browserWindow(ui);
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await ui.getByTestId('knowledge-import').click();
      await ui.getByRole('button', { name: '确认导入', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      const approved = await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        if (Object.keys(read.value.approvals).length) throw new Error('Import unexpectedly adopted entries');
        let current = read.value;
        for (const entry of read.value.data.entries) {
          const review = await window.translationKnowledge.reviewEntries({ generation: current.generation, ids: [entry.id], action: 'adopt' });
          if (!review.ok) throw new Error(JSON.stringify(review)); current = review.value;
        }
        return current;
      });
      await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, sources.map(source => path.join(root, source.name)));
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await ui.locator('#studio-result-close').click();
      const documents = await Promise.all(sources.map(source => readDocument(source.name)));
      const baseline = await Promise.all(documents.map(document => repository.readSnapshot(document.summary.id)));
      for (const document of documents) {
        expect(document.translationTracks).toHaveLength(0); expect(document.tasks).toHaveLength(0);
        await ui.locator(`[data-testid="studio-library-row"][data-document-id="${document.summary.id}"]`).getByRole('checkbox').check();
      }
      await uiExpect(ui.getByTestId('studio-batch-toolbar')).toContainText('3');
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: '批量翻译', exact: true }).click();
      const requirements = 'Keep each subtitle concise; preserve every file independently.';
      const dialog = dialogFor('studio-translation-form');
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await ui.getByTestId('studio-translation-advanced').click();
      await ui.getByRole('spinbutton', { name: '每批字幕上限', exact: true }).fill('20');
      await ui.getByTestId('studio-translation-advanced').click();
      const preview = ui.getByTestId('knowledge-batch-preview'), start = ui.getByTestId('studio-translation-review-start');
      const selectKnowledge = async (_english = false) => {
        const choose = ui.getByTestId('studio-materials-choose');
        if (await choose.getAttribute('aria-expanded') !== 'true') await choose.click();
        const recipe = ui.getByTestId('studio-materials-recipe');
        if (!(await recipe.textContent())?.includes(fixture.recipes[0].name)) {
          await recipe.click(); await ui.getByRole('option', { name: fixture.recipes[0].name, exact: true }).click();
        }
        await ui.getByTestId('studio-materials-done').click();
        const topics = ui.getByTestId('studio-materials-topics');
        const topicTrigger = topics.locator('[data-slot=accordion-trigger]').first();
        if (await topicTrigger.getAttribute('aria-expanded') !== 'true') await topicTrigger.click();
        for (const subject of fixture.subjects.slice(0, 2)) {
          const topic = ui.getByTestId(`studio-materials-topic-${subject.id}`);
          if (!(await topic.isChecked())) await topic.check();
        }
      };
      await selectKnowledge();
      await ui.getByTestId('studio-translation-instructions').fill(requirements);
      // A batch offers common document topics, never cue roles or confirmations.
      await uiExpect(dialog.getByRole('combobox', { name: '确定说话者', exact: true })).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-trial-scopes')).toHaveCount(0);
      await capture('configuration-light', ui.getByTestId('studio-translation-form'));
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(start).toBeEnabled();
      const file = (index: number) => ui.getByTestId(`knowledge-batch-file-${documents[index].summary.id}`);
      await uiExpect(file(0)).toHaveAttribute('data-state', 'ready');
      await uiExpect(file(1)).toHaveAttribute('data-state', 'ready');
      await uiExpect(file(2)).toHaveAttribute('data-state', 'blocked');
      await uiExpect(start).toContainText('2');
      expect(requests).toHaveLength(0);
      expect(await Promise.all(documents.map(document => repository.readSnapshot(document.summary.id)))).toEqual(baseline);

      // Editing scope clears the checked plan before another explicit start.
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId(`studio-materials-topic-${fixture.subjects[0].id}`).uncheck();
      await uiExpect(preview).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-translation-start')).not.toContainText('2');
      expect(requests).toHaveLength(0);
      await ui.getByTestId(`studio-materials-topic-${fixture.subjects[0].id}`).check();
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(preview).toBeVisible();
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: '批量翻译', exact: true }).click();
      await uiExpect(preview).toHaveCount(0);
      await selectKnowledge();
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(requirements);
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(file(2)).toHaveAttribute('data-state', 'blocked');
      await uiExpect(start).toContainText('2');
      await file(2).locator('[data-issue-code="term_conflict"] [data-slot=accordion-trigger]').first().click();
      await uiExpect(file(2)).toContainText('savepoint');
      await capture('per-file-conflict-light', file(2));
      await geometry(dialogFor('studio-translation-review-dialog'));
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await ui.evaluate(() => { document.documentElement.classList.add('dark'); });
      await capture('preview-dark-narrow', preview);
      await geometry(dialogFor('studio-translation-review-dialog'));
      expect(requests).toHaveLength(0);
      await start.click();

      const result = ui.getByTestId('studio-batch-result');
      await uiExpect(result).toHaveAttribute('data-outcome', 'partial');
      await result.locator('summary').click();
      await uiExpect(result.locator('[data-state="success"]')).toHaveCount(2);
      await uiExpect(result.locator(`[data-result-id="${documents[2].summary.id}"]`)).toHaveAttribute('data-state', 'failed');
      await capture('partial-admission-dark-narrow', result);
      await geometry(dialogFor('studio-batch-result'));
      await result.getByRole('button', { name: '查看翻译进度', exact: true }).click();
      const overview = ui.getByTestId('studio-translation-overview-list');
      await uiExpect(overview.locator('[data-task-id]')).toHaveCount(2);
      await uiExpect(overview.locator('[data-state="completed"]')).toHaveCount(2, { timeout: 30000 });
      await uiExpect(overview).toContainText(sources[0].name);
      await uiExpect(overview).toContainText(sources[1].name);
      await uiExpect(overview).not.toContainText(sources[2].name);
      await capture('completed-overview-dark-narrow', overview);
      await ui.getByRole('dialog').filter({ has: overview }).getByRole('button', { name: '关闭', exact: true }).click();
      const completed = await Promise.all(sources.map(source => readDocument(source.name)));
      expect(completed[2]).toEqual(documents[2]);
      for (const [index, document] of completed.slice(0, 2).entries()) {
        expect(document.tasks).toHaveLength(1); expect(document.tasks[0].status).toBe('completed');
        expect(document.translationTracks).toHaveLength(1);
        expect(Object.keys(document.translationTracks[0].entries)).toHaveLength(sources[index].count);
      }
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.every(request => request.payload.translationRequirements === requirements)).toBe(true);
      for (const source of sources.slice(0, 2)) {
        const ownRequests = requests.filter(request => request.payload.items[0].text.startsWith(source.marker));
        expect(ownRequests.flatMap(request => request.payload.items.map(item => item.id))).toEqual(Array.from({ length: source.count }, (_, index) => `u${index + 1}`));
        expect(ownRequests[0].payload.context.priorModelTranslations).toEqual([]);
        for (const { payload } of ownRequests) {
          expect(payload.items.every(item => item.text.startsWith(source.marker))).toBe(true);
          const context = [...payload.context.precedingSource, ...payload.context.followingSource, ...payload.context.priorModelTranslations];
          expect(context.every(text => text.includes(source.marker))).toBe(true);
          for (const other of sources.filter(item => item.marker !== source.marker)) expect(JSON.stringify(payload)).not.toContain(other.marker);
          expect(payload.translationKnowledge.items.every(item => item.kind === 'term' && item.required)).toBe(true);
        }
        expect(ownRequests.flatMap(request => request.payload.translationKnowledge.items.flatMap(item => item.applicableItemIds))).toEqual(source.count > 20 ? ['u1', 'u21'] : ['u1']);
        if (source.count > 20) expect(ownRequests[1].payload.context.priorModelTranslations.length).toBeGreaterThan(0);
      }
      for (const privateValue of [term.id, ...fixture.subjects.map(subject => subject.id), ...fixture.sources.map(source => source.excerpt), ...sources.map(source => source.name)]) expect(requests.map(request => request.raw).join('\n')).not.toContain(privateValue);

      // Inspect full private records only in this disposable profile; public pages remain bounded.
      for (const [index, document] of completed.slice(0, 2).entries()) {
        const snapshot = await repository.readSnapshot(document.summary.id), track = snapshot.document.translationTracks[0];
        const record = validateExecutionRecord(snapshot.executionRecords![track.executionRef!.id], { ref: track.executionRef, documentId: document.summary.id, trackId: track.id });
        const frozen = record.knowledge!;
        expect(frozen.selection.bindings).toEqual([]); expect(frozen.selection.confirmations).toEqual([]);
        expect(frozen.documentTopicIds).toEqual(expect.arrayContaining(fixture.subjects.map(subject => subject.id)));
        expect(frozen.generation).toBe(approved.generation);
        for (const group of ENTITY_ARRAYS) expect(frozen.data[group]).toEqual(group === 'preferenceTemplates' ? [] : approved.data[group]);
        expect(frozen.approvals).toEqual(approved.approvals);
        expect(frozen.data.entries.find(entry => entry.id === term.id)?.derivedFrom).toEqual(term.derivedFrom);
        const ownCueIds = new Set(document.cues.map(cue => cue.id));
        for (const batch of record.plan.batches) {
          const compiled = frozen.batches[batch.id];
          expect(compiled.items.every(item => item.applicableCueIds.every(cueId => ownCueIds.has(cueId)))).toBe(true);
          expect(compiled.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'condition_unconfirmed', entryIds: [context.id] }),
            expect.objectContaining({ code: 'subject_unbound', entryIds: [rule.id] }),
          ]));
          const captured = requests.find(request => request.raw === record.requests[batch.id].httpBody);
          expect(captured?.payload.items[0].text.startsWith(sources[index].marker)).toBe(true);
        }
        const originalRecord = structuredClone(record);
        await ui.evaluate(async document => {
          const result = await window.subtitleStudio.removeTask({ documentId: document.summary.id, revision: document.summary.revision, taskId: document.tasks[0].id });
          if (!result.ok) throw new Error(result.error);
        }, document);
        const retained = await repository.readSnapshot(document.summary.id);
        expect(retained.tasks).toHaveLength(0);
        expect(retained.executionRecords![record.id]).toEqual(originalRecord);
      }
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.evaluate(() => { document.documentElement.classList.remove('dark'); });
      await ui.locator(`[data-testid="studio-library-row"][data-document-id="${documents[0].summary.id}"] .studio-document`).click();
      await ui.getByTestId('studio-execution-record').click();
      const knowledge = ui.getByTestId('studio-execution-knowledge');
      await uiExpect(knowledge).toContainText(fixture.recipes[0].name);
      await knowledge.locator('summary').filter({ hasText: term.title }).click();
      await uiExpect(knowledge).toContainText(historicalSource.excerpt);
      await capture('retained-batch-evidence-light', knowledge);
      await geometry(dialogFor('studio-execution-record-content'));
      await dialogFor('studio-execution-record-content').getByRole('button', { name: '关闭', exact: true }).click();

      // Both completed files retain the same materials after task-row cleanup.
      // The blocked file must never appear as a retained translation reference.
      const beforeMaintenance = await Promise.all(documents.slice(0, 2).map(document => repository.readSnapshot(document.summary.id)));
      await ui.evaluate(() => { location.hash = '/tools/translation-knowledge'; });
      await ui.getByTestId(`knowledge-entry-details-${term.id}`).click();
      await ui.getByTestId('knowledge-entry-maintenance').click();
      const maintenance = dialogFor('knowledge-maintenance-tasks');
      const references = ui.getByTestId('knowledge-maintenance-tasks');
      await uiExpect(references).toContainText(sources[0].name);
      await uiExpect(references).toContainText(sources[1].name);
      await uiExpect(references).not.toContainText(sources[2].name);
      await uiExpect(references).toContainText('历史保留引用');
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
      await capture('maintenance-two-retained-files-light', references);
      await geometry(maintenance);
      await ui.getByTestId('knowledge-maintenance-confirm').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await ui.getByTestId('knowledge-archive').click();
      await ui.getByTestId(`knowledge-entry-details-${term.id}`).click();
      await ui.getByRole('dialog').locator('[data-slot=accordion-trigger]').filter({ hasText: '高级操作' }).click();
      await ui.getByTestId('knowledge-entry-purge').click();
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeDisabled();
      await uiExpect(maintenance.getByRole('checkbox')).toBeDisabled();
      await uiExpect(ui.getByTestId('knowledge-maintenance-reference-blocker')).toContainText('仍有任务或历史记录保留这些资料');
      await uiExpect(references).toContainText(sources[0].name);
      await uiExpect(references).toContainText(sources[1].name);
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await ui.evaluate(() => { document.documentElement.classList.add('dark'); });
      await capture('maintenance-purge-blocked-dark-narrow', references);
      await geometry(maintenance);
      await maintenance.getByRole('button', { name: '关闭', exact: true }).click();
      expect(await Promise.all(documents.slice(0, 2).map(document => repository.readSnapshot(document.summary.id)))).toEqual(beforeMaintenance);

      // Reload to rehydrate English and dark mode. Select files at desktop width
      // before switching to the narrow modal; its library is otherwise hidden.
      const sentBeforeEnglish = requests.length;
      await ui.evaluate(() => {
        localStorage.setItem('lang', 'en');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      for (const document of documents) await ui.locator(`[data-testid="studio-library-row"][data-document-id="${document.summary.id}"]`).getByRole('checkbox').check();
      await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: 'Translate selected documents', exact: true }).click();
      await selectKnowledge(true);
      // A preset cannot silently replace the parent's target, and explicit
      // requirements survive temporary invalid and custom language inputs.
      await uiExpect(ui.getByTestId('studio-translation-language')).toHaveText('English');
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeDisabled();
      await uiExpect(dialog).toContainText('This preset has a different target language.');
      const explicitRequirements = 'Keep this explicit draft when changing the target language.';
      await ui.getByTestId('studio-translation-instructions').fill(explicitRequirements);
      await ui.getByRole('combobox', { name: 'Target language', exact: true }).click();
      await ui.getByRole('option', { name: 'Other language', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-translation-start')).toBeDisabled();
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeDisabled();
      await uiExpect(ui.getByTestId('studio-materials-summary')).toContainText(fixture.recipes[0].name);
      await ui.getByRole('textbox', { name: 'Language name', exact: true }).fill('中文');
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(explicitRequirements);
      await uiExpect(dialog).toContainText('For a custom language, use a language code');
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeDisabled();
      await ui.getByRole('textbox', { name: 'Language name', exact: true }).fill('it');
      await uiExpect(ui.getByRole('textbox', { name: 'Language name', exact: true })).toHaveValue('it');
      await uiExpect(dialog).not.toContainText('For a custom language, use a language code');
      await uiExpect(ui.getByTestId('studio-translation-check')).toBeDisabled();
      await ui.getByRole('combobox', { name: 'Target language', exact: true }).click();
      await ui.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-translation-language')).toHaveText('Simplified Chinese');
      await uiExpect(ui.getByTestId('studio-translation-instructions')).toHaveValue(explicitRequirements);
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(start).toContainText('2');
      await uiExpect(file(2)).toHaveAttribute('data-state', 'blocked');
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await capture('batch-english-dark-narrow', preview);
      await geometry(dialogFor('studio-translation-review-dialog'));
      await ui.getByTestId('studio-translation-review-close').click();
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(requests).toHaveLength(sentBeforeEnglish);

      // Controlled renderer lifecycle fixture: preserve production authorization,
      // planning, first-file admission and cancellation, but delay its ACK and
      // synthesize the remaining per-file cancelled outcomes. The earlier flow
      // above covers the production batch loop without this adapter.
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      const lifecycleNames = ['Lifecycle first accepted.lrc', 'Lifecycle second never admitted.lrc'];
      await Promise.all(lifecycleNames.map((name, index) => writeFile(path.join(root, name), `[00:01]Lifecycle file ${index + 1}.`)));
      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, lifecycleNames.map(name => path.join(root, name)));
      await ui.getByRole('button', { name: 'Open subtitle file', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
      await ui.locator('#studio-result-close').click();
      const lifecycleDocuments = await Promise.all(lifecycleNames.map(readDocument));
      for (const document of lifecycleDocuments) await ui.locator(`[data-testid="studio-library-row"][data-document-id="${document.summary.id}"]`).getByRole('checkbox').check();
      const lifecycleChannels = {
        plan: 'subtitle-studio:plan-knowledge-translation-batch', start: 'subtitle-studio:create-knowledge-translation-batch',
        cancel: 'subtitle-studio:cancel-knowledge-translation-batch-plan', tasks: 'subtitle-studio:list-translation-tasks',
      };
      type LifecycleState = { holding: boolean; cancelled: number; returned: boolean; taskId: string | null; tracked: string[][]; restore: () => void };
      await app.evaluate(({ ipcMain }, channels) => {
        type Result<T> = { ok: true; value: T } | { ok: false; error: string };
        type Envelope<T> = { capability: string; payload: T };
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const originals = new Map<string, Handler>();
        for (const channel of Object.values(channels)) {
          const handler = handlers.get(channel); if (!handler) throw new Error(`Missing lifecycle fixture handler ${channel}`);
          originals.set(channel, handler);
        }
        let checked: { request: KnowledgeBatchTranslationRequest; preview: KnowledgeBatchTranslationPreview } | undefined;
        let release: (() => void) | undefined;
        const state: LifecycleState = { holding: false, cancelled: 0, returned: false, taskId: null, tracked: [], restore: () => {
          release?.(); for (const [channel, original] of originals) handlers.set(channel, original);
        } };
        (globalThis as typeof globalThis & { __knowledgeBatchLifecycle?: LifecycleState }).__knowledgeBatchLifecycle = state;
        handlers.set(channels.plan, async (event, input) => {
          const result = await originals.get(channels.plan)!(event, input) as Result<KnowledgeBatchTranslationPreview>;
          if (result.ok) checked = { request: structuredClone((input as Envelope<KnowledgeBatchTranslationRequest>).payload), preview: result.value };
          return result;
        });
        handlers.set(channels.start, async (event, input) => {
          if (!checked || checked.preview.items.length !== 2 || checked.preview.readyCount !== 2) throw new Error('Expected two checked lifecycle documents');
          const envelope = input as Envelope<{ planId: string; apiKey: string }>;
          const first = checked.preview.items[0], second = checked.preview.items[1];
          const request = checked.request;
          const single = await originals.get(channels.plan)!(event, { ...envelope, payload: { ...request, documents: request.documents.filter(document => document.documentId === first.documentId) } }) as Result<KnowledgeBatchTranslationPreview>;
          if (!single.ok) return single;
          const accepted = await originals.get(channels.start)!(event, { ...envelope, payload: { ...envelope.payload, planId: single.value.planId } }) as Result<KnowledgeBatchTranslationResult>;
          if (!accepted.ok || !accepted.value.items[0]?.ok) throw new Error('Lifecycle first-file admission did not succeed');
          const task = accepted.value.items[0]; state.taskId = task.taskId;
          const acknowledgement = new Promise<void>(resolve => { release = () => { state.holding = false; release = undefined; resolve(); }; });
          state.holding = true;
          await acknowledgement;
          state.returned = true;
          return { ok: true, value: { items: [task, { documentId: second.documentId, displayName: second.displayName, ok: false, error: 'access_denied' }] } };
        });
        handlers.set(channels.cancel, async (event, input) => {
          const result = await originals.get(channels.cancel)!(event, input);
          if (state.holding) { state.cancelled++; release?.(); }
          return result;
        });
        handlers.set(channels.tasks, async (event, input) => {
          const ids = (input as Envelope<{ taskIds?: string[] }>).payload.taskIds;
          if (ids?.length) state.tracked.push([...ids]);
          return originals.get(channels.tasks)!(event, input);
        });
      }, lifecycleChannels);
      const lifecycle = () => app!.evaluate(() => {
        const state = (globalThis as typeof globalThis & { __knowledgeBatchLifecycle?: LifecycleState }).__knowledgeBatchLifecycle;
        if (!state) throw new Error('Missing lifecycle observation');
        const { restore: _restore, ...value } = state; return value;
      });
      try {
        await ui.getByTestId('studio-batch-toolbar').getByRole('button', { name: 'Translate selected documents', exact: true }).click();
        await ui.getByRole('combobox', { name: 'Target language', exact: true }).click();
        await ui.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
        await selectKnowledge(true);
        // These fixture lines contain no matching terms. Shared topics never
        // create speaker or condition authorizations for these new documents.
        await uiExpect(ui.getByTestId('knowledge-trial-scopes')).toHaveCount(0);
        await ui.getByTestId('studio-translation-check').click();
        await uiExpect(start).toBeEnabled();
        await uiExpect(preview.locator('[data-state="ready"]')).toHaveCount(2);
        await start.click();
        await uiExpect.poll(async () => (await lifecycle()).holding).toBe(true);
        const firstAccepted = await lifecycle(); expect(firstAccepted.taskId).toBeTruthy();
        // This must be an actual route exit. A committed task revision changing
        // the form inputs is intentionally insufficient to cancel an admission.
        await ui.evaluate(() => { location.hash = '/tools/translation-knowledge'; });
        await uiExpect(ui.getByTestId('knowledge-import')).toBeVisible();
        await uiExpect.poll(async () => (await lifecycle()).cancelled).toBe(1);
        await uiExpect.poll(async () => (await lifecycle()).returned).toBe(true);
        await uiExpect.poll(async () => (await lifecycle()).tracked.some(ids => ids.length === 1 && ids[0] === firstAccepted.taskId)).toBe(true);
        await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
        await ui.getByTestId('studio-translation-overview-details').click();
        const admittedRow = ui.getByTestId('studio-translation-overview-list').locator(`[data-task-id="${firstAccepted.taskId}"]`);
        await uiExpect(admittedRow).toBeVisible();
        await uiExpect(admittedRow).toHaveAttribute('data-state', 'completed', { timeout: 30000 });
        const afterLifecycle = await Promise.all(lifecycleNames.map(readDocument));
        expect(afterLifecycle.map(document => document.tasks.length).sort()).toEqual([0, 1]);
        const acceptedDocument = afterLifecycle.find(document => document.tasks.length)!;
        expect(acceptedDocument.tasks[0].id).toBe(firstAccepted.taskId);
        const untouchedDocument = afterLifecycle.find(document => !document.tasks.length)!;
        expect(untouchedDocument.translationTracks).toHaveLength(0);
        expect(untouchedDocument).toEqual(lifecycleDocuments.find(document => document.summary.id === untouchedDocument.summary.id));
        await capture('route-unmount-retains-accepted-task', admittedRow);
        await geometry(ui.getByRole('dialog').filter({ has: admittedRow }));
        await ui.getByRole('dialog').filter({ has: admittedRow }).locator('button[data-variant="outline"]').filter({ hasText: /^Close$/ }).click();
        await writeFile(path.join(artifacts, 'route-unmount-lifecycle.json'), JSON.stringify({
          fixture: 'Registered IPC adapter: real first-file plan/admission and cancel; delayed ACK; synthetic second-file cancelled result.',
          observation: await lifecycle(), acceptedDocumentId: acceptedDocument.summary.id, untouchedDocumentId: untouchedDocument.summary.id,
        }, null, 2));
      } finally {
        await app.evaluate(() => {
          const shared = globalThis as typeof globalThis & { __knowledgeBatchLifecycle?: LifecycleState };
          shared.__knowledgeBatchLifecycle?.restore(); delete shared.__knowledgeBatchLifecycle;
        });
      }
      expect(errors).toEqual([]);
    } catch (error) {
      await capture('failure').catch(() => undefined);
      await writeFile(path.join(artifacts, 'failure.txt'), await ui.locator('body').innerText()).catch(() => undefined);
      throw error;
    }
  }, 180000);
});
