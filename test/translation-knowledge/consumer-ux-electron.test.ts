import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type TranslationPayload = {
  items: Array<{ id: string; text: string }>;
  translationKnowledge?: { items: Array<{ kind: string; applicableItemIds: string[] }> };
};

describe.runIf(process.env.FUSIONKIT_KNOWLEDGE_E2E === '1')('translation materials first-use journey in native Electron', () => {
  let app: ElectronApplication | undefined, server: Server | undefined, page: Page | undefined;
  let root = '';
  const artifacts = path.resolve('test-results/translation-knowledge-consumer-ux');

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

  it('uses explicitly selected materials in Studio and keeps classic subtitle imports in the classic queue', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fusionkit-knowledge-consumer-ux-'));
    await mkdir(artifacts, { recursive: true });
    const requests: Array<{ raw: string; payload: TranslationPayload }> = [], errors: string[] = [];
    server = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk.toString();
        const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
        const payload = JSON.parse(body.messages[1].content) as TranslationPayload;
        requests.push({ raw, payload });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          items: payload.items.map(item => ({ id: item.id, text: `译文：${payload.translationKnowledge ? item.text.replace(/checkpoint/g, '存档点') : item.text}` })),
        }) } }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }));
      } catch (error) {
        errors.push(`Fixture request: ${String(error)}`);
        response.writeHead(500).end();
      }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const subtitle = path.join(root, 'A first translation with selected travel terminology.srt');
    await writeFile(subtitle, '1\n00:00:01,000 --> 00:00:02,000\nWe reached checkpoint.\n\n2\n00:00:03,000 --> 00:00:04,000\nGood morning.\n');
    const classicSubtitle = path.join(root, 'Classic subtitle stays in its own queue.lrc');
    await writeFile(classicSubtitle, '[00:01.00]A subtitle for the classic translator.\n');
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    page = await app.firstWindow();
    const ui = page;
    ui.on('pageerror', error => errors.push(error.message));
    const nativeWindow = await app.browserWindow(ui);
    const capture = async (name: string, target?: Locator) => {
      await ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      if (target) await target.scrollIntoViewIfNeeded();
      await ui.waitForTimeout(150);
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
    };
    const geometry = async (target: Locator) => {
      expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await target.locator('[data-slot="scroll-area-viewport"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      expect(await target.evaluate(element => element.getBoundingClientRect().bottom <= window.innerHeight + 1)).toBe(true);
    };
    const readLibrary = () => ui.evaluate(async () => {
      const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value;
    });
    const readDocument = () => ui.evaluate(async () => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!list.ok) throw new Error(list.error);
      const document = list.value.documents[0];
      const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!result.ok) throw new Error(result.error); return result.value;
    });
    const parentDialog = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-knowledge-enabled') });
    const knowledgeDialog = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('knowledge-trial-content') });
    const assertNoOrdinaryAction = async () => {
      await uiExpect(parentDialog().getByRole('button', { name: '计算用量', exact: true })).toHaveCount(0);
      await uiExpect(parentDialog().getByRole('button', { name: '开始翻译', exact: true })).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-translation-knowledge-open')).toBeEnabled();
    };
    const tourTargets = [
      '#knowledge-tour-collection',
      '[data-testid="knowledge-views"] [role="tab"]:has([data-knowledge-tour="materials"])',
      '[data-testid="knowledge-views"] [role="tab"]:has([data-knowledge-tour="review"])',
      '[data-testid="knowledge-views"] [role="tab"]:has([data-knowledge-tour="plans"])',
      '#knowledge-tour-studio',
    ];
    const tourTitles = {
      zh: ['先建一个资料集', '从一条术语开始', '采纳后，才能用于翻译', '重复使用时，再建方案', '到工作台，按次选择资料'],
      en: ['Start with a collection', 'Add your first term', 'Review before using', 'Reuse a setup with recipes', 'Choose materials in Studio'],
    };
    const assertTourStep = async (locale: 'zh' | 'en', step: number) => {
      const tour = ui.getByRole('dialog', { name: tourTitles[locale][step], exact: true });
      await uiExpect(tour).toBeVisible();
      await uiExpect(tour).toContainText(`${step + 1} / ${tourTargets.length}`);
      await uiExpect(tour).not.toContainText('当前目标暂不可见');
      // Measure the actual highlighted control after the shared Tour has scrolled
      // and settled. A matching heading alone would not prove correct anchoring.
      await uiExpect.poll(async () => ui.evaluate(selector => {
        const target = document.querySelector(selector)?.getBoundingClientRect();
        const spotlight = document.querySelector('.knowledge-tour-spotlight')?.getBoundingClientRect();
        if (!target || !spotlight) return false;
        return target.width > 0 && target.height > 0
          && target.top >= 0 && target.bottom <= innerHeight
          && target.left >= 0 && target.right <= innerWidth
          && spotlight.left <= target.left + 1 && spotlight.right >= target.right - 1
          && spotlight.top <= target.top + 1 && spotlight.bottom >= target.bottom - 1
          && Math.abs(spotlight.left - target.left) <= 16 && Math.abs(spotlight.right - target.right) <= 16
          && Math.abs(spotlight.top - target.top) <= 16 && Math.abs(spotlight.bottom - target.bottom) <= 16;
      }, tourTargets[step])).toBe(true);
      await geometry(tour);
      expect(await tour.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0;
      })).toBe(true);
      return tour;
    };
    const finishTour = async (locale: 'zh' | 'en', name: string) => {
      await ui.getByTestId('knowledge-tour-trigger').click();
      for (let step = 0; step < tourTargets.length; step++) {
        await assertTourStep(locale, step);
        await capture(`${name}-step-${step + 1}`);
        await ui.getByTestId('knowledge-tour-next').click();
      }
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(await ui.evaluate(() => localStorage.getItem('translation-knowledge-tour-done'))).toBe('1');
    };
    const checkCatalogSpacing = async (name: string) => {
      await ui.evaluate(() => { location.hash = '/tools'; });
      await uiExpect(ui.getByTestId('tools-catalog')).toBeVisible();
      await ui.getByTestId('tools-classic-grid').evaluate(element => element.scrollIntoView({ block: 'center' }));
      const measure = () => ui.evaluate(() => {
        const rect = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
        return {
          classicGap: rect('tools-classic-heading').top - rect('tools-featured-grid').bottom,
          experimentalGap: rect('tools-experimental-heading').top - rect('tools-classic-grid').bottom,
          viewport: { width: innerWidth, height: innerHeight },
        };
      });
      await uiExpect.poll(async () => {
        const { classicGap, experimentalGap } = await measure();
        return Math.abs(classicGap - experimentalGap);
      }).toBeLessThanOrEqual(1);
      const measured = await measure();
      expect(measured.classicGap).toBeGreaterThan(0);
      await writeFile(path.join(artifacts, `${name}-geometry.json`), JSON.stringify(measured, null, 2));
      await capture(name);
    };

    try {
      await ui.evaluate(port => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'consumer-ux-fixture', name: 'Local consumer UX fixture', provider: 'DeepSeek', apiKey: 'synthetic-consumer-ux-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'consumer-ux-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/translation-knowledge';
      }, port);
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await assertTourStep('zh', 0);
      await capture('tour-first-visit-zh-light-wide');
      expect((await readLibrary()).data.entries).toHaveLength(0);
      await ui.getByTestId('knowledge-tour-skip').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      expect(await ui.evaluate(() => localStorage.getItem('translation-knowledge-tour-done'))).toBe('1');
      await ui.reload();
      await capture('workspace-empty-zh-light-wide', ui.getByTestId('knowledge-new-entry'));
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-guide')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-open-studio')).toBeVisible();
      await finishTour('zh', 'tour-zh-light-wide');
      expect((await readLibrary()).data.entries).toHaveLength(0);

      await ui.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await capture('workspace-empty-en-dark-narrow', ui.getByTestId('knowledge-new-entry'));
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByTestId('knowledge-guide')).toHaveCount(0);
      await finishTour('en', 'tour-en-dark-narrow');
      expect((await readLibrary()).data.collections).toHaveLength(0);

      await ui.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.getByTestId('knowledge-new-entry').click();
      const collectionName = '旅行视频术语 · 首次使用时明确选择的资料集';
      const catalog = ui.getByRole('dialog').filter({ has: ui.getByRole('textbox', { name: '名称', exact: true }) });
      await catalog.getByRole('textbox', { name: '名称', exact: true }).fill(collectionName);
      await catalog.getByRole('combobox', { name: '原文语言', exact: true }).click();
      await ui.getByRole('option', { name: '英语', exact: true }).click();
      await catalog.getByRole('combobox', { name: '目标语言', exact: true }).click();
      await ui.getByRole('option', { name: '简体中文', exact: true }).click();
      await catalog.getByRole('button', { name: '保存', exact: true }).click();
      // Saving the first collection continues into its entry editor without another action.
      const editor = ui.getByRole('dialog').filter({ has: ui.getByRole('textbox', { name: '原文', exact: true }) });
      await uiExpect(editor).toBeVisible();
      await uiExpect(catalog).toHaveCount(0);
      await uiExpect(editor.getByRole('combobox', { name: '资料集', exact: true })).toContainText(collectionName);
      await uiExpect(editor.getByRole('combobox', { name: '原文语言', exact: true })).toContainText('英语');
      await editor.getByRole('textbox', { name: '原文', exact: true }).fill('checkpoint');
      await editor.getByRole('textbox', { name: '译文', exact: true }).fill('存档点');
      await editor.getByRole('checkbox', { name: '我已核对内容与范围，保存后采纳此条资料', exact: true }).check();
      await capture('first-term-adoption-zh-light', editor.getByRole('button', { name: '保存并采纳', exact: true }));
      await editor.getByRole('button', { name: '保存并采纳', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByText('已保存并采纳。翻译时选择所在资料集，符合语言和范围的内容才会参与。', { exact: true })).toBeVisible();
      const library = await readLibrary();
      expect(library.data.collections).toHaveLength(1);
      expect(library.data.entries).toHaveLength(1);
      const entry = library.data.entries[0], collection = library.data.collections[0];
      expect(entry.kind).toBe('term');
      expect(entry.scope.languagePair).toEqual({ source: 'en', target: 'zh-Hans' });
      expect(library.approvals[entry.id]?.method).toBe('human');

      // Another approved collection also matches the subtitles; only the selected collection may enter the request.
      const excludedCollection = await ui.evaluate(async () => {
        const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(read.error);
        const otherCollection = { ...structuredClone(read.value.data.collections[0]), id: crypto.randomUUID(), name: '其他项目的独立术语' };
        const savedCollection = await window.translationKnowledge.saveRecord({ generation: read.value.generation, group: 'collections', record: otherCollection });
        if (!savedCollection.ok) throw new Error(savedCollection.error);
        const originalTerm = read.value.data.entries.find(item => item.kind === 'term');
        if (!originalTerm || originalTerm.kind !== 'term') throw new Error('Expected the term created through the editor');
        const otherTerm = { ...structuredClone(originalTerm), id: crypto.randomUUID(), collectionId: otherCollection.id, title: '未选资料不得发送', payload: { ...originalTerm.payload, source: 'morning', target: '未选资料的专用译法' } };
        const savedTerm = await window.translationKnowledge.saveRecord({ generation: savedCollection.value.generation, group: 'entries', record: otherTerm, adopt: true });
        if (!savedTerm.ok) throw new Error(savedTerm.error);
        return otherCollection;
      });
      await capture('workspace-first-term-zh-light-wide', ui.getByTestId('knowledge-new-entry'));
      await ui.getByTestId('knowledge-open-studio').click();
      await ui.waitForURL(/#\/tools\/subtitle\/studio$/);
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      expect(await ui.evaluate(async () => {
        const result = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!result.ok) throw new Error(result.error); return result.value.documents.length;
      })).toBe(0);
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, subtitle);
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(2);
      await uiExpect(ui.locator('.studio-cue-table')).toBeVisible();
      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await uiExpect(ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch')).not.toBeChecked();
      await uiExpect(ui.getByTestId('studio-translation-model')).toContainText('Local consumer UX fixture');
      await uiExpect(parentDialog().getByRole('button', { name: '计算用量', exact: true })).toBeEnabled();
      await ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch').check();
      await assertNoOrdinaryAction();
      await ui.getByTestId('studio-translation-knowledge-open').click();
      await uiExpect(ui.getByTestId('knowledge-full-mode')).toBeChecked();
      await uiExpect(ui.getByTestId('knowledge-trial-source-language')).toContainText('选择字幕原文语言');
      await ui.getByTestId('knowledge-trial-source-language').click();
      await ui.getByRole('option', { name: '英语', exact: true }).click();
      await uiExpect(ui.getByTestId('knowledge-trial-target-language')).toContainText('简体中文');
      const selectedCollection = ui.getByTestId(`knowledge-trial-collection-${collection.id}`);
      await uiExpect(selectedCollection).not.toBeChecked();
      await uiExpect(ui.getByTestId(`knowledge-trial-collection-${excludedCollection.id}`)).not.toBeChecked();
      await uiExpect(ui.getByTestId('knowledge-full-check')).toBeDisabled();
      expect(requests).toHaveLength(0);
      await capture('studio-materials-unselected-zh-light-wide', ui.getByTestId('knowledge-trial-source-language'));
      await selectedCollection.check();
      await ui.getByTestId('knowledge-trial-close').click();
      await uiExpect(knowledgeDialog()).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-knowledge-selection-summary')).toContainText(collectionName);
      await assertNoOrdinaryAction();
      await ui.getByTestId('studio-translation-knowledge-open').click();
      await uiExpect(selectedCollection).toBeChecked();
      await selectedCollection.uncheck();
      await ui.getByTestId('knowledge-trial-close').click();
      await uiExpect(knowledgeDialog()).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-knowledge-selection-summary')).not.toContainText(collectionName);
      await assertNoOrdinaryAction();

      // Disabling materials explicitly permits ordinary translation, with no library context.
      await ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch').uncheck();
      await uiExpect(ui.getByTestId('studio-translation-knowledge-open')).toHaveCount(0);
      await parentDialog().getByRole('button', { name: '计算用量', exact: true }).click();
      await uiExpect(parentDialog().getByRole('button', { name: '开始翻译', exact: true })).toBeEnabled();
      expect(requests).toHaveLength(0);
      await parentDialog().getByRole('button', { name: '开始翻译', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      expect(requests).toHaveLength(1);
      expect(requests[0].payload.translationKnowledge).toBeUndefined();
      expect(requests[0].raw).not.toContain('存档点');
      expect((await readDocument()).translationTracks).toHaveLength(1);

      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await ui.getByTestId('studio-translation-knowledge-enabled').getByRole('switch').check();
      await ui.getByTestId('studio-translation-knowledge-open').click();
      await ui.getByTestId('knowledge-trial-source-language').click();
      await ui.getByRole('option', { name: '英语', exact: true }).click();
      await selectedCollection.check();
      await ui.getByTestId('knowledge-full-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toBeVisible();
      await uiExpect(ui.getByTestId('knowledge-full-run')).toBeEnabled();
      expect(requests).toHaveLength(1);
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await capture('selected-materials-preview-zh-light-narrow', ui.getByTestId('knowledge-full-preview'));
      await geometry(knowledgeDialog());
      await ui.getByTestId('knowledge-full-run').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      expect(requests).toHaveLength(2);
      expect(requests[1].payload.translationKnowledge?.items).toEqual([expect.objectContaining({ kind: 'term', applicableItemIds: ['u1'] })]);
      expect(requests[1].raw).toContain('存档点');
      expect(requests[1].raw).not.toContain('未选资料的专用译法');
      expect((await readDocument()).translationTracks).toHaveLength(2);

      // The classic translator keeps its own configuration, upload flow and task queue.
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.evaluate(() => { location.hash = '/tools/subtitle/translator'; });
      await ui.getByRole('button', { name: 'Skip', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.getByRole('link', { name: '翻译资料', exact: true })).toHaveCount(0);
      await uiExpect(ui.getByRole('radiogroup', { name: '翻译资料', exact: true })).toHaveCount(0);
      await uiExpect(ui.locator('[data-testid^="subtitle-knowledge-"]')).toHaveCount(0);
      for (const selector of ['#tour-lang-pair', '#tour-output-mode', '#tour-slice-mode', '#tour-output-path', '#tour-upload-zone']) {
        await uiExpect(ui.locator(selector)).toBeVisible();
      }
      await ui.locator('#tour-output-path').getByRole('radio', { name: '与源文件同目录', exact: true }).check();
      const chooser = ui.waitForEvent('filechooser');
      await ui.getByRole('button', { name: '选择文件', exact: true }).click();
      await (await chooser).setFiles(classicSubtitle);
      await uiExpect(ui.locator('#tour-task-queue').getByText(path.basename(classicSubtitle), { exact: true })).toBeVisible();
      await uiExpect(ui.locator('#tour-start-all-btn')).toBeEnabled();
      await uiExpect(ui).toHaveURL(/#\/tools\/subtitle\/translator$/);
      const studioDocuments = await ui.evaluate(async () => {
        const result = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!result.ok) throw new Error(result.error); return result.value.documents;
      });
      expect(studioDocuments).toHaveLength(1);
      expect(studioDocuments[0].origin.displayName).toBe(path.basename(subtitle));
      expect(requests).toHaveLength(2);
      await capture('classic-translator-zh-light-wide', ui.locator('#tour-upload-zone'));
      await ui.evaluate(() => {
        localStorage.setItem('lang', 'en');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 }));
      });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await uiExpect(ui.getByRole('link', { name: 'Translation materials', exact: true })).toHaveCount(0);
      await uiExpect(ui.getByRole('radiogroup', { name: 'Translation materials', exact: true })).toHaveCount(0);
      await uiExpect(ui.locator('[data-testid^="subtitle-knowledge-"]')).toHaveCount(0);
      // The classic pending queue is in memory; add a fresh native file after
      // reloading the locale/theme, without assuming implicit task recovery.
      const englishChooser = ui.waitForEvent('filechooser');
      await ui.locator('#tour-upload-zone').getByRole('button').click();
      await (await englishChooser).setFiles(classicSubtitle);
      await uiExpect(ui.locator('#tour-task-queue').getByText(path.basename(classicSubtitle), { exact: true })).toBeVisible();
      await capture('classic-translator-en-dark-narrow', ui.locator('#tour-upload-zone'));
      await checkCatalogSpacing('catalog-spacing-en-dark-narrow');
      await ui.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); });
      await ui.reload();
      await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await checkCatalogSpacing('catalog-spacing-zh-light-wide');
      expect(errors).toEqual([]);
    } catch (error) {
      await ui.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 150000);
});
