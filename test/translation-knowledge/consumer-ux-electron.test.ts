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
    const translate = () => ui.getByRole('dialog').filter({ has: ui.getByTestId('studio-translation-model') });
    const openTranslation = async () => {
      await ui.getByRole('button', { name: '翻译', exact: true }).click();
      await uiExpect(translate()).toBeVisible();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
    };
    const tour = async (name: string) => {
      await ui.getByTestId('knowledge-tour-trigger').click();
      for (let i = 0; i < 5; i++) {
        const dialog = ui.locator('.knowledge-tour-popover');
        await uiExpect(dialog).toBeVisible();
        await uiExpect(dialog).toContainText(`${i + 1} / 5`);
        await uiExpect(dialog).not.toContainText('当前目标暂不可见');
        // Motion's spring/layout transitions are not CSS animations, so the
        // screenshot option alone cannot settle a newly selected Tour step.
        await dialog.evaluate(element => new Promise<void>((resolve, reject) => {
          const started = performance.now(); let previous: number[] = [], stable = 0;
          const sample = () => {
            const nodes = [element, ...element.querySelectorAll('div'), ...document.querySelectorAll('.knowledge-tour-spotlight')];
            const values = nodes.flatMap(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
            stable = values.length === previous.length && values.every((value, i) => Math.abs(value - previous[i]) < 0.1) ? stable + 1 : 0;
            previous = values;
            if (stable >= 10 && performance.now() - started > 500) { resolve(); return; }
            if (performance.now() - started > 5000) { reject(new Error('Tour layout did not settle')); return; }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }));
        // The decorative arrow intentionally extends beyond the panel. Check
        // its content box for overflow and the panel itself against the viewport.
        await geometry(dialog.locator(':scope > div'));
        expect(await dialog.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
        await capture(`${name}-step-${i + 1}`);
        await ui.getByTestId('knowledge-tour-next').click();
      }
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
    };
    const catalogSpacing = async () => {
      await ui.evaluate(() => { location.hash = '/tools'; });
      await uiExpect(ui.getByTestId('tools-catalog')).toBeVisible();
      const gaps = await ui.evaluate(() => {
        const rect = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        return [rect('tools-classic-heading').top - rect('tools-featured-grid').bottom, rect('tools-experimental-heading').top - rect('tools-classic-grid').bottom];
      });
      expect(gaps[0]).toBe(32); expect(gaps[1]).toBe(32);
    };
    try {
      await ui.evaluate(port => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('subtitle-translator-tour-done', '1');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'consumer-fixture', name: 'Local consumer UX fixture', provider: 'DeepSeek', apiKey: 'synthetic-consumer-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'consumer-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/translation-knowledge';
      }, port);
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await uiExpect(ui.locator('.knowledge-tour-popover')).toBeVisible();
      await ui.getByTestId('knowledge-tour-skip').click();
      expect(await ui.evaluate(() => localStorage.getItem('translation-knowledge-tour-done'))).toBe('1');
      await ui.reload();
      await capture('redesign-empty-zh-light', ui.getByTestId('knowledge-new-collection'));
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await tour('redesign-tour-zh-light');
      await ui.getByTestId('knowledge-new-collection').click();
      const collectionName = '旅行视频术语 · 日常维护与明确选用的资料集';
      await ui.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill(collectionName);
      await ui.getByRole('dialog').getByRole('combobox', { name: '原文语言', exact: true }).click();
      await ui.getByRole('option', { name: '英语', exact: true }).click();
      await ui.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      const collection = (await readLibrary()).data.collections[0];
      expect(collection.name).toBe(collectionName);
      expect((await readLibrary()).data.subjects).toHaveLength(0);
      const inline = ui.getByTestId('knowledge-inline-term');
      await inline.getByRole('textbox', { name: '原文', exact: true }).fill('checkpiont');
      await inline.getByRole('textbox', { name: '译文', exact: true }).fill('存档点');
      await inline.getByRole('textbox', { name: '译文', exact: true }).press('Enter');
      await uiExpect.poll(async () => (await readLibrary()).data.entries.length).toBe(1);
      let term = (await readLibrary()).data.entries[0];
      expect(term.state).toBe('ready'); expect(term.scope.requiredSubjects).toEqual([]);
      expect((await readLibrary()).approvals[term.id].revision).toBe(term.revision);
      await ui.locator(`[data-entry-id="${term.id}"]`).click();
      await ui.getByRole('dialog').getByRole('textbox', { name: '原文', exact: true }).fill('checkpoint');
      await ui.getByTestId('knowledge-save-apply').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      term = (await readLibrary()).data.entries[0];
      expect(term.revision).toBeGreaterThan(1); expect(term.state).toBe('ready');
      expect((await readLibrary()).approvals[term.id].revision).toBe(term.revision);
      await ui.getByTestId('knowledge-paste-open').click();
      await ui.getByTestId('knowledge-paste-input').fill('save slot\t存档槽\ncheckpoint\t载入游系');
      await ui.getByTestId('knowledge-paste-preview').click();
      await ui.getByTestId('knowledge-paste-rows').getByRole('textbox', { name: '译文 2', exact: true }).fill('载入游戏');
      await capture('redesign-paste-zh-light');
      await ui.getByTestId('knowledge-paste-save').click();
      await uiExpect(ui.locator('[data-paste-row][data-saved="true"]')).toHaveCount(1);
      await uiExpect(ui.getByRole('dialog').getByRole('alert')).toBeVisible();
      await capture('redesign-paste-partial-recovery');
      await ui.getByTestId('knowledge-paste-rows').getByRole('textbox', { name: '原文 2', exact: true }).fill('load game');
      await ui.getByTestId('knowledge-paste-save').click();
      await uiExpect(ui.locator('[data-paste-row][data-saved="true"]')).toHaveCount(2);
      await ui.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      expect((await readLibrary()).data.entries).toHaveLength(3);
      expect(Object.keys((await readLibrary()).approvals)).toHaveLength(3);
      await capture('redesign-collection-zh-light', ui.getByTestId('knowledge-inline-term'));

      // A different matching collection must never be implicitly selected.
      const excludedCollection = await ui.evaluate(async selectedId => {
        let result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error);
        const original = result.value.data.collections.find(item => item.id === selectedId)!;
        const other = { ...original, id: crypto.randomUUID(), revision: 1, name: '不选用的其他资料集' };
        let saved = await window.translationKnowledge.saveRecord({ generation: result.value.generation, group: 'collections', record: other });
        if (!saved.ok) throw new Error(saved.error);
        const entry = structuredClone(saved.value.data.entries[0]);
        if (entry.kind !== 'term') throw new Error('Fixture term missing');
        entry.id = crypto.randomUUID(); entry.revision = 1; entry.collectionId = other.id; entry.payload.target = '未选资料的专用译法';
        saved = await window.translationKnowledge.saveRecord({ generation: saved.value.generation, group: 'entries', record: entry, adopt: true });
        if (!saved.ok) throw new Error(saved.error); return other;
      }, collection.id);
      await ui.evaluate(() => { localStorage.setItem('lang', 'en'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(820, 700));
      await uiExpect(ui.locator('html')).toHaveClass(/dark/);
      await capture('redesign-collection-en-dark', ui.getByTestId('knowledge-new-entry'));
      await tour('redesign-tour-en-dark');
      await ui.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); });
      await ui.reload(); await nativeWindow.evaluate(win => win.setSize(1280, 860));
      await ui.getByTestId('knowledge-open-studio').click();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, subtitle);
      await ui.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(ui.locator('.studio-cue-table tbody tr')).toHaveCount(2);
      await openTranslation();
      await uiExpect(ui.getByTestId('studio-translation-knowledge-enabled')).toHaveCount(0);
      await uiExpect(ui.getByTestId('studio-materials')).toContainText('未使用资料');
      await capture('redesign-translation-no-materials');
      // Direct Start includes local preparation and never adds saved materials.
      await ui.getByTestId('studio-translation-start').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      expect(requests).toHaveLength(1); expect(requests[0].payload.translationKnowledge).toBeUndefined();
      expect((await readDocument()).translationTracks).toHaveLength(1);
      await openTranslation();
      await ui.getByTestId('studio-materials-choose').click();
      const selectedCollection = ui.getByTestId(`studio-materials-collection-${collection.id}`);
      await uiExpect(selectedCollection).not.toBeChecked();
      await uiExpect(ui.getByTestId(`studio-materials-collection-${excludedCollection.id}`)).not.toBeChecked();
      await selectedCollection.check();
      await ui.getByTestId('studio-materials-source').click();
      await ui.getByRole('option', { name: '英语', exact: true }).click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(1);
      await capture('redesign-materials-selection', ui.getByTestId('studio-materials'));
      await ui.getByTestId('studio-translation-check').click();
      await uiExpect(ui.getByTestId('knowledge-full-preview')).toBeVisible();
      expect(requests).toHaveLength(1);
      await nativeWindow.evaluate(win => win.setSize(820, 700));
      await capture('redesign-translation-selected-narrow', ui.getByTestId('knowledge-full-preview'));
      await geometry(translate());
      await ui.getByTestId('studio-translation-start').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      await uiExpect(ui.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 20000 });
      expect(requests).toHaveLength(2);
      expect(requests[1].payload.translationKnowledge?.items).toEqual([expect.objectContaining({ kind: 'term', applicableItemIds: ['u1'] })]);
      expect(requests[1].raw).toContain('存档点'); expect(requests[1].raw).not.toContain('未选资料的专用译法');
      expect((await readDocument()).translationTracks).toHaveLength(2);
      await openTranslation();
      await uiExpect(ui.getByTestId('studio-materials')).toContainText(collectionName);
      await ui.getByTestId('studio-translation-close').click();

      // Save from a subtitle row without leaving the active document. The user
      // explicitly narrows the prefilled sentence instead of auto-learning it.
      await ui.locator('.studio-cue-table tbody tr').first().getByRole('button', { name: '字幕操作', exact: true }).click();
      await ui.getByTestId('studio-remember-term').click();
      const quick = ui.getByRole('dialog').filter({ has: ui.getByTestId('quick-term-form') });
      await uiExpect(quick.getByRole('textbox', { name: '原词', exact: true })).toHaveValue('We reached checkpoint.');
      await quick.getByRole('textbox', { name: '原词', exact: true }).fill('Good morning');
      await quick.getByRole('textbox', { name: '固定译法', exact: true }).fill('早安');
      await quick.getByRole('combobox', { name: '保存到资料集', exact: true }).click();
      await ui.getByRole('option', { name: collectionName, exact: true }).click();
      await capture('redesign-remember-term-narrow');
      await ui.getByTestId('quick-term-save').click();
      await uiExpect(ui.getByRole('dialog')).toHaveCount(0);
      const remembered = (await readLibrary()).data.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'Good morning')!;
      expect(remembered.state).toBe('ready'); expect(remembered.scope.requiredSubjects).toEqual([]);
      expect((await readLibrary()).approvals[remembered.id].method).toBe('human');
      expect((await readDocument()).translationTracks).toHaveLength(2);
      await uiExpect(ui).toHaveURL(/#\/tools\/subtitle\/studio$/);

      await ui.evaluate(() => { location.hash = '/tools/subtitle/translator'; });
      await uiExpect(ui.locator('[data-testid^="subtitle-knowledge-"]')).toHaveCount(0);
      await uiExpect(ui.getByRole('link', { name: '翻译资料', exact: true })).toHaveCount(0);
      await ui.locator('#tour-output-path').getByRole('radio', { name: '与源文件同目录', exact: true }).check();
      const chooser = ui.waitForEvent('filechooser');
      await ui.getByRole('button', { name: '选择文件', exact: true }).click();
      await (await chooser).setFiles(classicSubtitle);
      await uiExpect(ui.locator('#tour-task-queue').getByText(path.basename(classicSubtitle), { exact: true })).toBeVisible();
      expect((await readDocument()).summary.origin.displayName).toBe(path.basename(subtitle));
      expect(requests).toHaveLength(2);
      await catalogSpacing();
      expect(errors).toEqual([]);
    } catch (error) {
      await ui.screenshot({ path: path.join(artifacts, 'redesign-failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    }
  }, 180000);
});
