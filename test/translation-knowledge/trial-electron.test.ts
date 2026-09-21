import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFixture } from './fixtures';

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('knowledge trial through native Electron', () => {
  let app: ElectronApplication | undefined, server: Server | undefined, page: Page | undefined, root = '';
  let release: (() => void) | undefined;
  const artifacts = path.resolve('test-results/translation-knowledge-trial');
  afterAll(async () => {
    release?.();
    try {
      const child = app?.process();
      await app?.close();
      if (child) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      if (root) await rm(root, { recursive: true, force: true });
    }
  });
  it('checks explicit scopes, sends frozen guidance, shows trial results, and leaves official tracks untouched', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-trial-e2e-'));
    await mkdir(artifacts, { recursive: true });
    const requests: any[] = [], errors: string[] = [];
    let mode: 'success' | 'malformed' | 'hold' = 'success';
    server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk.toString();
      const body = JSON.parse(text); requests.push(body);
      const payload = JSON.parse(body.messages[1].content);
      if (mode === 'hold') await new Promise<void>(resolve => { release = resolve; });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: mode === 'malformed' ? '{"items":[]}' : JSON.stringify({ items: payload.items.map((item: {id: string}) => ({ id: item.id, text: item.id === 'u1' ? '我们到存档点了。' : '她提到了米拉。' })) }) } }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const fixture = knowledgeFixture();
    const term = fixture.entries.find(item => item.kind === 'term')!;
    if (term.kind === 'term') term.payload.strength = 'required';
    const rule = fixture.entries.find(item => item.kind === 'rule')!;
    rule.scope.requiredSubjects.push({ subjectId: fixture.subjects[1].id, role: 'speaker' });
    const input = path.join(root, 'trial.fktk.json'), subtitle = path.join(root, 'trial.lrc');
    await writeFile(input, JSON.stringify(fixture));
    await writeFile(subtitle, '[00:01]We reached the checkpoint.\n[00:03]She mentioned Mira.');
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const ui = page;
    try {
      await ui.evaluate(port => {
        // First-use Tour is covered by consumer-ux; keep execution fixtures focused.
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'studio-fixture', name: 'Local trial fixture', provider: 'DeepSeek', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'studio-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
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
      // Use the real fixed review bridge for fixture setup; import never auto-adopts.
      const knowledgeBefore = await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        if (Object.keys(read.value.approvals).length) throw new Error('Unexpected import approval');
        let current = read.value;
        for (const entry of read.value.data.entries) {
          const review = await window.translationKnowledge.reviewEntries({ generation: current.generation, ids: [entry.id], action: 'adopt' });
          if (!review.ok) throw new Error(review.error); current = review.value;
        }
        return current;
      });
      await ui.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, subtitle);
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(2);
      const docBefore = await ui.evaluate(async () => {
        const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
        const doc = list.value.documents[0];
        return window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 });
      });
      if (!docBefore.ok) throw new Error(docBefore.error);
      const sourceCues = docBefore.value.cues;
      const openMaterialsTrial = async () => {
        if (!(await ui.getByTestId('studio-translation-form').count())) await ui.getByRole('button', { name: /^(翻译|Translate)$/ }).click();
        const choose = ui.getByTestId('studio-materials-choose');
        if (await choose.getAttribute('aria-expanded') !== 'true') await choose.click();
        const recipe = ui.getByTestId('studio-materials-recipe');
        if (!(await recipe.textContent())?.includes(fixture.recipes[0].name)) {
          await recipe.click(); await ui.getByRole('option', { name: fixture.recipes[0].name, exact: true }).click();
        }
        await ui.getByTestId('studio-materials-done').click();
      };
      const checkTrial = async () => {
        const scopes = ui.getByTestId('knowledge-trial-scopes');
        const trigger = scopes.locator('[data-slot=accordion-trigger]').first();
        if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
        await ui.getByTestId('studio-translation-check-trial').click();
      };
      await openMaterialsTrial();
      const dialog = ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-form') });
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await ui.getByTestId('studio-translation-instructions').fill('Keep the dialogue concise.');
      await checkTrial();
      await uiExpect(ui.getByTestId('knowledge-trial-preview')).toContainText('必要主题或人物角色尚未确认');
      expect(requests).toHaveLength(0);
      const scopes = ui.getByTestId('knowledge-trial-scopes');
      for (const cue of sourceCues) {
        await ui.getByTestId(`studio-materials-role-${cue.id}-topic`).click();
        await ui.getByRole('option', { name: '游戏 X', exact: true }).click();
      }
      await ui.getByTestId(`studio-materials-role-${sourceCues[0].id}-speaker`).click();
      await ui.getByRole('option', { name: '米拉（虚构人物）', exact: true }).click();
      await ui.getByTestId(`studio-materials-role-${sourceCues[1].id}-mentioned`).click();
      await ui.getByRole('option', { name: '米拉（虚构人物）', exact: true }).click();
      await ui.getByTestId(`studio-materials-confirm-${sourceCues[0].id}-${term.id}`).check();
      await checkTrial();
      await uiExpect(ui.getByTestId('studio-translation-trial')).toBeEnabled();
      const excluded = ui.getByTestId('knowledge-trial-preview').locator('[data-issue-code=condition_unconfirmed]');
      await ui.getByTestId('knowledge-trial-preview').getByTestId('studio-materials-issues-excluded').locator('[data-slot=accordion-trigger]').first().click();
      await excluded.locator('[data-slot=accordion-trigger]').first().click();
      await uiExpect(excluded).toContainText('2. She mentioned Mira.');
      await ui.getByTestId('knowledge-trial-preview').scrollIntoViewIfNeeded();
      await ui.screenshot({ path: path.join(artifacts, 'preview-light.png'), animations: 'disabled' });
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toContainText('我们到存档点了。');
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toContainText('实际请求 1 次 · 输入 120 · 输出 40');
      expect(requests).toHaveLength(1);
      const payload = JSON.parse(requests[0].messages[1].content);
      expect(payload.translationRequirements).toBe('Keep the dialogue concise.');
      expect(payload.translationKnowledge.items.find((item: any) => item.kind === 'term').applicableItemIds).toEqual(['u1']);
      expect(payload.translationKnowledge.items.find((item: any) => item.kind === 'rule').applicableItemIds).toEqual(['u1']);
      expect(payload.translationKnowledge.items.some((item: any) => ['memory', 'expression'].includes(item.kind))).toBe(false);
      for (const privateValue of [fixture.subjects[0].id, term.id, fixture.sources[0].excerpt, 'trial.lrc']) expect(JSON.stringify(requests)).not.toContain(privateValue);
      await ui.getByTestId('knowledge-trial-result').scrollIntoViewIfNeeded();
      await ui.screenshot({ path: path.join(artifacts, 'result-light.png'), animations: 'disabled' });
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await ui.evaluate(() => { document.documentElement.classList.add('dark'); });
      await ui.screenshot({ path: path.join(artifacts, 'result-dark-narrow.png'), animations: 'disabled' });
      expect(await dialog.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
      mode = 'malformed';
      await checkTrial();
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toContainText('试译未全部完成');
      await uiExpect(ui.getByTestId('knowledge-trial-result')).not.toContainText('我们到存档点了。');
      mode = 'hold';
      await checkTrial();
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect.poll(() => requests.length).toBe(3);
      await ui.getByTestId('studio-translation-cancel-trial').click();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toContainText('试译未全部完成');
      release?.(); mode = 'success';
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
      await openMaterialsTrial();
      await uiExpect(ui.getByTestId('studio-translation-trial')).toBeEnabled();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toHaveCount(0);
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
      const after = await ui.evaluate(async () => {
        const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
        const doc = list.value.documents[0];
        return { doc: await window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 }), knowledge: await window.translationKnowledge.read() };
      });
      expect(after.doc).toEqual(docBefore);
      expect(after.knowledge).toEqual({ ok: true, value: knowledgeBefore });
      // A second check must not apply confirmations to an unseen library revision.
      await openMaterialsTrial();
      await uiExpect(ui.getByTestId('studio-translation-trial')).toBeEnabled();
      await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        const entry = read.value.data.entries.find(item => item.kind === 'memory')!;
        const review = await window.translationKnowledge.reviewEntries({ generation: read.value.generation, ids: [entry.id], action: 'reject' });
        if (!review.ok) throw new Error(review.error);
      });
      await checkTrial();
      await uiExpect(dialog).toContainText('资料已更新，旧的适用条件确认已清除');
      await uiExpect(ui.getByTestId('knowledge-trial-preview')).toHaveCount(0);
      await uiExpect(ui.getByTestId(`studio-materials-confirm-${sourceCues[0].id}-${term.id}`)).not.toBeChecked();
      expect(requests).toHaveLength(3);
      await checkTrial();
      await uiExpect(ui.getByTestId('knowledge-trial-preview')).toBeVisible();
      mode = 'hold';
      await ui.getByTestId('studio-translation-trial').click();
      await uiExpect.poll(() => requests.length).toBe(4);
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
      release?.(); mode = 'success';
      await openMaterialsTrial();
      await uiExpect(ui.getByTestId('studio-translation-trial')).toBeEnabled();
      await uiExpect(ui.getByTestId('knowledge-trial-result')).toHaveCount(0);
      await ui.getByTestId('studio-translation-close').click();
      await uiExpect(ui.getByTestId('studio-translation-form')).toHaveCount(0);
      await ui.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await ui.reload();
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await ui.getByRole('button', { name: 'Translate', exact: true }).click();
      await ui.getByRole('combobox', { name: 'Target language', exact: true }).click();
      await ui.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
      await openMaterialsTrial();
      await uiExpect(ui.getByTestId('studio-translation-trial')).toBeEnabled();
      await ui.screenshot({ path: path.join(artifacts, 'form-english-narrow.png'), animations: 'disabled' });
      expect(errors).toEqual([]);
    } catch (error) { await ui.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); throw error; }
  }, 120000);
});
