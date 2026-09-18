import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';

type ProviderBody = { messages: Array<{ content: string }> };
type ProviderPayload = {
  items: Array<{ id: string; text: string }>;
  translationRequirements: string;
  translationKnowledge: { items: Array<{ kind: string; applicableItemIds: string[] }> };
};

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('formal knowledge translation through native Electron', () => {
  let app: ElectronApplication | undefined, server: Server | undefined, page: Page | undefined, root = '';
  const artifacts = path.resolve('test-results/translation-knowledge-formal');
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

  it('translates beyond the trial window, retains exact knowledge after task cleanup, and protects referenced materials', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-formal-e2e-'));
    await mkdir(artifacts, { recursive: true });
    const requests: Array<{ body: ProviderBody; raw: string; payload: ProviderPayload }> = [], errors: string[] = [];
    server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw) as ProviderBody;
      const payload = JSON.parse(body.messages[1].content) as ProviderPayload;
      requests.push({ body, raw, payload });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `正式译文：${item.text.replace(/checkpoint/gi, '存档点')}` })) }),
      } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const fixture = knowledgeFixture();
    const term = fixture.entries.find(entry => entry.kind === 'term')!;
    const context = fixture.entries.find(entry => entry.kind === 'context')!;
    const rule = fixture.entries.find(entry => entry.kind === 'rule')!;
    term.scope.condition = { mode: 'none' };
    if (term.kind === 'term') term.payload.strength = 'required';
    context.scope.condition = { mode: 'requires_confirmation', text: '该句确实讨论游戏中的保存进度。' };
    rule.scope.requiredSubjects.push({ subjectId: fixture.subjects[1].id, role: 'speaker' });
    const input = path.join(root, 'formal.fktk.json'), subtitle = path.join(root, 'Formal knowledge across twenty cues.lrc');
    await writeFile(input, JSON.stringify(fixture));
    await writeFile(subtitle, Array.from({ length: 24 }, (_, index) => {
      const number = index + 1;
      const text = number === 1 || number === 21 ? `We reached checkpoint ${number}.` : `Dialogue line ${number}.`;
      return `[00:${String(number).padStart(2, '0')}]${text}`;
    }).join('\n'));
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    const ui = page;
    ui.on('pageerror', error => errors.push(error.message));
    const capture = (name: string) => ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    const dialogFor = (testId: string) => ui.getByRole('dialog').filter({ has: ui.getByTestId(testId) });
    const geometry = async (dialog: Locator) => {
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    };
    const readDocument = () => ui.evaluate(async () => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
      const document = list.value.documents[0];
      const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!result.ok) throw new Error(result.error); return result.value;
    });
    const readRecord = (batchOffset: number) => ui.evaluate(async offset => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
      const document = list.value.documents[0];
      const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!result.ok) throw new Error(result.error);
      const record = await window.subtitleStudio.readExecutionRecord({ documentId: document.id, trackId: result.value.translationTracks[0].id, batchOffset: offset });
      if (!record.ok) throw new Error(record.error);
      if (record.value.state !== 'available') throw new Error(`Unexpected record state: ${record.value.state}`);
      return record.value;
    }, batchOffset);

    try {
      await ui.evaluate(port => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'formal-fixture', name: 'Local formal translation fixture', provider: 'DeepSeek', apiKey: 'synthetic-formal-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'formal-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
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
      // Fixture approval uses the real fixed bridge; the import itself grants no trust.
      await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
        if (Object.keys(read.value.approvals).length) throw new Error('Import unexpectedly adopted entries');
        let current = read.value;
        for (const entry of read.value.data.entries) {
          const reviewed = await window.translationKnowledge.reviewEntries({ generation: current.generation, ids: [entry.id], action: 'adopt' });
          if (!reviewed.ok) throw new Error(JSON.stringify({ entryId: entry.id, ...reviewed }));
          current = reviewed.value;
        }
      });
      await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, subtitle);
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(24);
      const original = await readDocument();
      expect(original.translationTracks).toHaveLength(0);
      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await ui.getByRole('textbox', { name: '翻译要求（可选）' }).fill('Keep every line concise and preserve all information.');
      await uiExpect(ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch')).not.toBeChecked();
      await ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch').check();
      await ui.getByTestId('studio-translation-knowledge-open').click();
      const dialog = dialogFor('knowledge-trial-content');
      await uiExpect(ui.getByTestId('knowledge-full-mode')).toBeChecked();
      await uiExpect(ui.getByTestId('knowledge-full-check')).toBeDisabled();
      await ui.getByTestId('knowledge-trial-mode').check();
      await dialog.getByRole('combobox', { name: '翻译方案', exact: true }).click();
      await ui.getByRole('option', { name: fixture.recipes[0].name, exact: true }).click();
      const explicitRequirements = 'Keep every line concise and preserve all information. Use natural dialogue.';
      await ui.getByTestId('knowledge-trial-instructions').fill(explicitRequirements);
      await ui.getByTestId('knowledge-trial-close').click();
      await uiExpect(dialog).toHaveCount(0);
      // Editing a number passes through an invalid draft; that must not erase selected materials or authored requirements.
      const parent = dialogFor('studio-translation-knowledge-enabled');
      await ui.getByTestId('studio-translation-advanced').click();
      const budget = parent.getByRole('spinbutton', { name: '上下文窗口（tokens）', exact: true });
      const originalBudget = await budget.inputValue();
      await budget.fill('');
      await uiExpect(ui.getByTestId('studio-translation-knowledge-open')).toBeDisabled();
      await uiExpect(ui.getByTestId('studio-knowledge-trial')).toBeDisabled();
      await uiExpect(ui.getByTestId('studio-knowledge-selection-summary')).toContainText(fixture.recipes[0].name);
      await uiExpect(parent.getByRole('button', { name: '计算用量', exact: true })).toHaveCount(0);
      await uiExpect(parent.getByRole('button', { name: '开始翻译', exact: true })).toHaveCount(0);
      await budget.fill(originalBudget);
      await ui.getByTestId('studio-translation-advanced').click();
      await uiExpect(ui.getByTestId('studio-translation-knowledge-open')).toBeEnabled();
      await ui.getByTestId('studio-translation-knowledge-open').click();
      await uiExpect(ui.getByTestId('knowledge-trial-recipe')).toContainText(fixture.recipes[0].name);
      for (const collectionId of fixture.recipes[0].readCollectionIds) {
        await uiExpect(ui.getByTestId(`knowledge-trial-collection-${collectionId}`)).toBeChecked();
      }
      await uiExpect(ui.getByTestId('knowledge-trial-instructions')).toHaveValue(explicitRequirements);
      expect(requests).toHaveLength(0);
      await ui.getByTestId('knowledge-trial-mode').check();
      await ui.getByTestId('knowledge-trial-check').click();
      await uiExpect(ui.getByTestId('knowledge-trial-preview')).toBeVisible();
      const scopes = ui.getByTestId('knowledge-trial-scopes');
      await scopes.locator('summary').click();
      await scopes.getByRole('combobox', { name: '当前主题', exact: true }).first().click();
      await ui.getByRole('option', { name: fixture.subjects[0].name, exact: true }).click();
      await scopes.getByRole('combobox', { name: '确定说话者', exact: true }).first().click();
      await ui.getByRole('option', { name: fixture.subjects[1].name, exact: true }).click();
      await scopes.locator('summary').click();
      const conditions = ui.getByTestId('knowledge-trial-conditions');
      await conditions.locator('summary').click();
      await conditions.getByRole('checkbox').first().check();
      await conditions.locator('summary').click();

      await ui.getByTestId('knowledge-full-mode').check();
      const topics = ui.getByTestId('knowledge-document-topics');
      await topics.getByRole('checkbox', { name: fixture.subjects[0].name, exact: true }).check();
      // A person selected as a document topic must not become everyone's speaker.
      await topics.getByRole('checkbox', { name: fixture.subjects[1].name, exact: true }).check();
      await uiExpect(ui.getByTestId('knowledge-full-scope-help')).toContainText('不会扩展到全文');
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toHaveCount(0);
      await topics.scrollIntoViewIfNeeded();
      await capture('form-full-light');
      await ui.getByTestId('knowledge-full-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toContainText('24');
      await uiExpect(ui.getByTestId('knowledge-full-run')).toBeEnabled();
      expect(requests).toHaveLength(0);
      // Changing explicit topics invalidates the checked plan immediately.
      await topics.getByRole('checkbox', { name: fixture.subjects[0].name, exact: true }).uncheck();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-full-run')).toBeDisabled();
      await topics.getByRole('checkbox', { name: fixture.subjects[0].name, exact: true }).check();
      await ui.getByTestId('knowledge-full-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-run')).toBeEnabled();
      await ui.getByTestId('knowledge-full-preview').scrollIntoViewIfNeeded();
      await capture('preview-full-light');
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await ui.evaluate(() => { document.documentElement.classList.add('dark'); });
      await ui.getByTestId('knowledge-full-preview').scrollIntoViewIfNeeded();
      await capture('preview-full-dark-narrow');
      await geometry(dialog);
      await ui.getByTestId('knowledge-full-run').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      await uiExpect(ui.locator('.studio-target-text').filter({ hasText: '正式译文：' })).toHaveCount(24);
      const completed = await readDocument();
      expect(completed.tasks).toHaveLength(1);
      expect(completed.translationTracks).toHaveLength(1);
      expect(completed.translationTracks[0].origin).toBe('ai');
      expect(Object.keys(completed.translationTracks[0].entries)).toHaveLength(24);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.flatMap(request => request.payload.items.map(item => item.id))).toEqual(Array.from({ length: 24 }, (_, index) => `u${index + 1}`));
      const applicable = (kind: string) => requests.flatMap(request => request.payload.translationKnowledge.items.filter(item => item.kind === kind).flatMap(item => item.applicableItemIds));
      expect(applicable('term')).toEqual(['u1', 'u21']);
      expect(applicable('rule')).toEqual(['u1']);
      expect(applicable('context')).toEqual(['u1']);
      expect(requests.every(request => request.payload.translationRequirements === explicitRequirements)).toBe(true);
      expect(requests.every(request => request.payload.translationKnowledge.items.every(item => !['memory', 'expression'].includes(item.kind)))).toBe(true);
      for (const privateValue of [term.id, fixture.subjects[0].id, fixture.sources[0].excerpt, path.basename(subtitle)]) expect(requests.map(request => request.raw).join('\n')).not.toContain(privateValue);

      const firstRecord = await readRecord(0);
      expect(firstRecord.knowledge?.documentTopics).toEqual(expect.arrayContaining(fixture.subjects.map(subject => subject.name)));
      expect(firstRecord.knowledge?.recipeName).toBe(fixture.recipes[0].name);
      expect(firstRecord.batch.request?.httpBody).toBe(requests[0].raw);
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.evaluate(() => { document.documentElement.classList.remove('dark'); });
      await ui.getByTestId('studio-execution-record').click();
      const execution = dialogFor('studio-execution-record-content');
      const knowledge = ui.getByTestId('studio-execution-knowledge');
      await uiExpect(knowledge).toContainText(fixture.recipes[0].name);
      await knowledge.locator('summary').filter({ hasText: term.title }).click();
      await uiExpect(knowledge).toContainText(fixture.sources[0].excerpt);
      await knowledge.scrollIntoViewIfNeeded();
      await capture('execution-knowledge-light');
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await ui.evaluate(() => { document.documentElement.classList.add('dark'); });
      await knowledge.scrollIntoViewIfNeeded();
      await capture('execution-knowledge-dark-narrow');
      await geometry(execution);
      const lastOffset = firstRecord.totalBatches - 1;
      for (let offset = 0; offset < lastOffset; offset++) {
        await execution.getByRole('button', { name: '下一页', exact: true }).last().click();
        await uiExpect(ui.getByTestId('studio-execution-record-content')).toHaveAttribute('aria-busy', 'false');
      }
      const lastRecord = await readRecord(lastOffset);
      expect(lastRecord.batch.items.some(item => item.id === 'u21')).toBe(true);
      expect(lastRecord.batch.request?.httpBody).toBe(requests.at(-1)!.raw);
      expect(lastRecord.knowledge?.compiled.items.filter(item => item.kind === 'term').flatMap(item => item.applicableCueIds)).toEqual([completed.cues[20].id]);
      expect(lastRecord.knowledge?.compiled.items.some(item => item.kind === 'context' || item.kind === 'rule')).toBe(false);
      await uiExpect(knowledge.locator('summary').filter({ hasText: term.title })).toBeVisible();
      const technical = ui.getByTestId('studio-execution-technical');
      await technical.locator('summary').click();
      await uiExpect(technical.locator('pre')).toHaveText(requests.at(-1)!.raw);
      await technical.scrollIntoViewIfNeeded();
      await capture('execution-http-body-dark-narrow');
      await execution.getByRole('button', { name: '关闭', exact: true }).click();

      // Clear only the completed task via the fixed API; the retained track owns its record.
      await ui.evaluate(async ({ documentId, revision, taskId }) => {
        const result = await window.subtitleStudio.removeTask({ documentId, revision, taskId });
        if (!result.ok) throw new Error(result.error);
      }, { documentId: completed.summary.id, revision: completed.summary.revision, taskId: completed.tasks[0].id });
      await uiExpect(ui.getByTestId('studio-execution-record')).toBeVisible();
      expect((await readDocument()).tasks).toHaveLength(0);
      expect(await readRecord(lastOffset)).toEqual(lastRecord);
      await ui.getByTestId('studio-execution-record').click();
      await uiExpect(knowledge).toContainText(fixture.recipes[0].name);
      await knowledge.scrollIntoViewIfNeeded();
      await capture('execution-after-task-cleanup');
      await execution.getByRole('button', { name: '关闭', exact: true }).click();

      await ui.evaluate(() => { location.hash = '/tools/translation-knowledge'; });
      await ui.locator(`[data-entry-id="${term.id}"]`).click();
      await ui.getByTestId('knowledge-entry-maintenance').click();
      const maintenance = dialogFor('knowledge-maintenance-tasks');
      await uiExpect(maintenance).toContainText('历史保留引用');
      await uiExpect(maintenance).toContainText(path.basename(subtitle));
      await uiExpect(maintenance).toContainText('不表示所有内容都已发送给模型');
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeEnabled();
      await ui.getByTestId('knowledge-maintenance-tasks').scrollIntoViewIfNeeded();
      await capture('maintenance-archive-references');
      await ui.getByTestId('knowledge-maintenance-confirm').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await ui.locator(`[data-entry-id="${term.id}"]`).click();
      await ui.getByRole('dialog').locator('summary').filter({ hasText: '高级操作' }).click();
      await ui.getByTestId('knowledge-entry-purge').click();
      await uiExpect(ui.getByTestId('knowledge-maintenance-confirm')).toBeDisabled();
      await uiExpect(maintenance.getByRole('checkbox')).toBeDisabled();
      await uiExpect(ui.getByTestId('knowledge-maintenance-reference-blocker')).toContainText('仍有任务或历史记录保留这些资料');
      await uiExpect(maintenance).toContainText('历史保留引用');
      await ui.getByTestId('knowledge-maintenance-tasks').scrollIntoViewIfNeeded();
      await capture('maintenance-purge-blocked');
      await geometry(maintenance);
      await maintenance.getByRole('button', { name: '关闭', exact: true }).click();
      // Archiving the live entry must not rewrite or remove the frozen task evidence.
      expect(await readRecord(lastOffset)).toEqual(lastRecord);
      await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await ui.getByTestId('studio-execution-record').click();
      await uiExpect(knowledge).toContainText(fixture.recipes[0].name);
      await knowledge.locator('summary').filter({ hasText: term.title }).click();
      await uiExpect(knowledge).toContainText(fixture.sources[0].excerpt);
      await execution.getByRole('button', { name: '关闭', exact: true }).click();
      expect(errors).toEqual([]);
    } catch (error) { await capture('failure').catch(() => undefined); throw error; }
  }, 180000);
});
