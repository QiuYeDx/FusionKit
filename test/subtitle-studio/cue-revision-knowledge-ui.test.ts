import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import materials from '../../src/locales/zh/materials.json';
import knowledge from '../../src/locales/zh/knowledge.json';

type RevisionPayload = { request: string; editableFields: string[]; translationKnowledge?: { items: { payload: { source?: string }; applicableItemIds: string[] }[] }; items: { id: string; source: string; target?: string }[] };

const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const COLLECTION = '绝区零 · 人物与称谓';
const format = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key]);
const pairLabel = (source: keyof typeof knowledge.languages, target: keyof typeof knowledge.languages) => `${knowledge.languages[source]} → ${knowledge.languages[target]}`;

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('AI revision and translation materials', () => {
  it('revises with the chosen materials, keeps the applied wording enabled, and remembers a term from a cue', async () => {
    const artifacts = path.resolve('test-results/studio-cue-revision-knowledge'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-studio-cue-revision-'));
    const input = path.join(root, '绝区零-第二章.srt');
    const lines = [`${SOURCE}がお見えです。`, 'ホロウの調査に向かいます。', `${SOURCE}、こちらへどうぞ。`, 'ありがとう。'];
    await writeFile(input, lines.map((line, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 1},800\n${line}\n`).join('\n'));
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const revisions: RevisionPayload[] = [];
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        let content: unknown;
        if ('request' in payload) {
          revisions.push(payload);
          const items = (payload as RevisionPayload).items;
          content = { items: items.filter(item => item.source.includes(SOURCE)).map(item => ({ id: item.id, target: item.source.startsWith(SOURCE + 'が') ? `${TARGET}来了。` : `${TARGET}，这边请。` })),
            knowledge: [{ source: SOURCE, target: TARGET, note: '家族名' }], note: '已统一家族名的译法。' };
        } else content = { items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: item.text.includes(SOURCE) ? item.text.replace(SOURCE, '时间菲尔德家的大小姐') : `译 ${item.text}` })) };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'cue-revision-model', name: 'Controlled model', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-model', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'cue-revision-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const library = () => page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });

      // A Japanese collection with an enabled term, as the user would have it, and one translating English.
      const collectionId = await page.evaluate(async name => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const collectionId = crypto.randomUUID();
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [
          { group: 'collections', record: { id: collectionId, revision: 1, name, description: '', languagePair: { source: 'ja', target: 'zh-Hans' }, archived: false } },
          { group: 'collections', record: { id: crypto.randomUUID(), revision: 1, name: 'English names', description: '', languagePair: { source: 'en', target: 'zh-Hans' }, archived: false } },
          { group: 'entries', record: { id: crypto.randomUUID(), revision: 1, collectionId, enabled: true, kind: 'term',
            payload: { source: 'ホロウ', target: '空洞', aliases: [], note: '', strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } } } },
        ] });
        if (!saved.ok) throw new Error(saved.error);
        return collectionId;
      }, COLLECTION);

      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(4);

      // Translate with the collection chosen, as the user would before revising.
      await page.getByRole('button', { name: '翻译', exact: true }).click();
      const translation = page.getByRole('dialog').filter({ has: page.getByTestId('studio-translation-form') });
      await translation.getByTestId('studio-materials-choose').click();
      await page.getByTestId(`studio-materials-collection-${collectionId}`).check();
      await page.getByTestId('studio-materials-done').click();
      const source = translation.getByTestId('studio-materials-source');
      if (!/日语/.test(await source.innerText())) { await source.click(); await page.getByRole('option', { name: knowledge.languages.ja, exact: true }).click(); }
      await translation.getByTestId('studio-translation-start').click();
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('时间菲尔德家的大小姐がお見えです。');

      // Revise every line: the materials go with the requests and the dialog names them.
      const revise = async (instructions: string) => {
        await page.getByTestId('studio-cue-list').focus();
        await page.keyboard.press('Control+a');
        await page.getByTestId('studio-cue-toolbar-revise').click();
        await uiExpect(dialog).toBeVisible();
        await dialog.getByTestId('studio-cue-revision-instructions').fill(instructions);
        await dialog.getByTestId('studio-cue-revision-field-target').click();
        await dialog.getByTestId('studio-cue-revision-generate').click();
        await uiExpect(dialog.getByTestId('studio-cue-revision-item')).toHaveCount(2);
      };
      const dialog = page.getByRole('dialog', { name: 'AI 修订' });
      const request = '有些翻译不太合适，应该是泰姆菲尔德家的大小姐';
      await revise(request);
      await uiExpect(dialog.getByTestId('studio-cue-revision-materials')).toHaveText(`参考资料：${COLLECTION}`);
      const sent = revisions.at(-1)!;
      expect(sent.translationKnowledge?.items).toEqual([expect.objectContaining({ payload: expect.objectContaining({ source: 'ホロウ' }), applicableItemIds: ['c2'] })]);
      await uiExpect(dialog.getByTestId('studio-cue-revision-knowledge-hint')).toHaveText('应用后可将 1 条译法记入翻译资料');
      await shot('01-preview-materials-and-hint');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();

      // The applied revision offers the wording once, without interrupting.
      const offer = page.getByTestId('studio-knowledge-offer');
      await uiExpect(offer).toHaveText(/AI 修订中有 1 条译法可以记入翻译资料/);
      await shot('02-offer');
      await page.getByTestId('studio-knowledge-offer-open').click();
      const capture = page.getByTestId('knowledge-capture-form');
      const captureDialog = page.getByRole('dialog').filter({ has: capture });
      await uiExpect(capture).toBeVisible();
      await uiExpect(captureDialog).toContainText(materials.capture.title);
      const row = capture.getByTestId('knowledge-capture-row');
      await uiExpect(row).toHaveCount(1);
      await uiExpect(row.getByRole('textbox').nth(0)).toHaveValue(SOURCE);
      await uiExpect(row.getByRole('textbox').nth(1)).toHaveValue(TARGET);
      // Saving is the decision: no switch to adopt or enable the entry separately.
      await uiExpect(captureDialog.getByRole('switch')).toHaveCount(0);
      // The collection the translation used is chosen; it keeps its own direction.
      const destination = capture.getByRole('combobox', { name: materials.collection, exact: true });
      await uiExpect(destination).toHaveText(`${COLLECTION} · ${pairLabel('ja', 'zh-Hans')}`);
      await uiExpect(capture.getByTestId('capture-direction-mismatch')).toHaveCount(0);
      await uiExpect(capture.getByRole('combobox', { name: materials.source_language, exact: true })).toHaveCount(0);
      // A collection of another direction would not apply to this translation, and says so.
      await destination.click();
      await page.getByRole('option', { name: `English names · ${pairLabel('en', 'zh-Hans')}`, exact: true }).click();
      await uiExpect(capture.getByTestId('capture-direction-mismatch')).toHaveText(format(materials.direction_mismatch, { collection: pairLabel('en', 'zh-Hans'), current: pairLabel('ja', 'zh-Hans') }));
      await shot('03-capture-direction-mismatch');
      await destination.click();
      await page.getByRole('option', { name: `${COLLECTION} · ${pairLabel('ja', 'zh-Hans')}`, exact: true }).click();
      await uiExpect(capture.getByTestId('capture-direction-mismatch')).toHaveCount(0);
      await uiExpect(page.getByTestId('knowledge-capture-save')).toHaveText(format(materials.capture.save, { count: '1' }));
      await shot('04-capture-dialog-light');
      await page.getByTestId('knowledge-capture-save').click();
      await uiExpect(capture).toBeHidden();
      await uiExpect(offer).toHaveCount(0);
      const saved = await library();
      const kept = saved.data.entries.find(entry => entry.kind === 'term' && entry.payload.target === TARGET)!;
      // Enabled at once, recorded as the user's applied revision with the request as its note.
      expect(kept).toMatchObject({ collectionId, enabled: true, origin: { kind: 'revision', note: request }, payload: { source: SOURCE, target: TARGET, note: '家族名' } });
      expect(saved.data.collections).toHaveLength(2);

      // Already kept: the same wording is not offered again.
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('时间菲尔德家的大小姐がお見えです。');
      await revise('统一家族名');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();
      await page.waitForTimeout(800);
      await uiExpect(offer).toHaveCount(0);

      // Once the kept term is gone and another collection translates the name differently, it is offered again. Dark theme.
      await page.evaluate(async id => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const removed = await window.translationKnowledge.deleteRecords({ generation: current.value.generation, items: [{ group: 'entries', id }] });
        if (!removed.ok) throw new Error(removed.error);
        const other = crypto.randomUUID();
        const added = await window.translationKnowledge.saveRecords({ generation: removed.value.snapshot.generation, items: [
          { group: 'collections', record: { id: other, revision: 1, name: '旧版译名', description: '', languagePair: { source: 'ja', target: 'zh-Hans' }, archived: false } },
          { group: 'entries', record: { id: crypto.randomUUID(), revision: 1, collectionId: other, enabled: true, kind: 'term',
            payload: { source: 'テイムフィールド家のお嬢様', target: '时间菲尔德家的大小姐', aliases: [], note: '', strength: 'preferred', match: { mode: 'literal_phrase', caseSensitive: false } } } },
        ] });
        if (!added.ok) throw new Error(added.error);
      }, kept.id);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await revise('统一家族名');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(offer).toBeVisible();
      await shot('05-offer-dark');
      await page.getByTestId('studio-knowledge-offer-open').click();
      await uiExpect(capture).toBeVisible();
      await uiExpect(row).toHaveAttribute('data-status', 'conflict');
      await uiExpect(row).toContainText(format(materials.capture.status_conflict, { collection: '旧版译名', target: '时间菲尔德家的大小姐' }));
      await shot('06-capture-dialog-dark');
      // Closing keeps the offer; an undo takes it away.
      await page.keyboard.press('Escape');
      await uiExpect(capture).toBeHidden();
      await uiExpect(offer).toBeVisible();
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(offer).toHaveCount(0);

      // Kept in a new collection: it asks for a direction and starts from the one being translated.
      await revise('统一家族名');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await page.getByTestId('studio-knowledge-offer-open').click();
      await uiExpect(capture).toBeVisible();
      await destination.click();
      await page.getByRole('option', { name: materials.new_collection, exact: true }).click();
      await uiExpect(capture.getByRole('combobox', { name: materials.source_language, exact: true })).toHaveText(knowledge.languages.ja);
      await uiExpect(capture.getByRole('combobox', { name: materials.target_language, exact: true })).toHaveText(knowledge.languages['zh-Hans']);
      await uiExpect(capture).toContainText(materials.direction_hint);
      await uiExpect(page.getByTestId('knowledge-capture-save')).toBeDisabled();
      await capture.getByRole('textbox', { name: materials.collection_name, exact: true }).fill('绝区零 · 新译名');
      await uiExpect(captureDialog.getByRole('switch')).toHaveCount(0);
      await shot('07-capture-new-collection-dark');
      await page.getByTestId('knowledge-capture-save').click();
      await uiExpect(capture).toBeHidden();
      const afterNew = await library();
      const created = afterNew.data.collections.find(item => item.name === '绝区零 · 新译名')!;
      expect(created).toMatchObject({ languagePair: { source: 'ja', target: 'zh-Hans' }, archived: false });
      expect(afterNew.data.entries.filter(entry => entry.collectionId === created.id)).toEqual([expect.objectContaining({ kind: 'term', enabled: true,
        origin: expect.objectContaining({ kind: 'revision' }), payload: expect.objectContaining({ source: SOURCE, target: TARGET }) })]);

      // 记住译法 from a cue's menu: the user narrows the prefilled line to the term and saves it enabled.
      await rows.nth(3).locator('td').first().click();
      await uiExpect(page.locator('.studio-cue-table tbody tr[aria-selected=true]')).toHaveCount(1);
      await rows.nth(3).getByRole('button', { name: materials.cue_actions, exact: true }).click();
      await page.getByTestId('studio-remember-term').click();
      const quick = page.getByRole('dialog').filter({ has: page.getByTestId('quick-term-form') });
      await uiExpect(quick).toContainText(materials.title);
      await uiExpect(quick.getByRole('textbox', { name: materials.source, exact: true })).toHaveValue('ありがとう。');
      await uiExpect(quick.getByRole('switch')).toHaveCount(0);
      await quick.getByRole('textbox', { name: materials.source, exact: true }).fill('ありがとう');
      await quick.getByRole('textbox', { name: materials.target, exact: true }).fill('多谢');
      const quickDestination = quick.getByRole('combobox', { name: materials.collection, exact: true });
      await quickDestination.click();
      await page.getByRole('option', { name: materials.new_collection, exact: true }).click();
      // A new collection asks for its direction, starting from the translation language of the track.
      await uiExpect(quick.getByRole('combobox', { name: materials.target_language, exact: true })).toHaveText(knowledge.languages['zh-Hans']);
      await quick.getByRole('textbox', { name: materials.collection_name, exact: true }).fill('日常用语');
      const quickSource = quick.getByRole('combobox', { name: materials.source_language, exact: true });
      // Studio passes only the track's language to this dialog, so the source language is chosen here.
      await quickSource.click(); await page.getByRole('option', { name: knowledge.languages.ja, exact: true }).click();
      await uiExpect(quickSource).toHaveText(knowledge.languages.ja);
      await shot('08-quick-term-dark');
      await quick.getByTestId('quick-term-save').click();
      await uiExpect(quick).toBeHidden();
      const remembered = await library();
      const daily = remembered.data.collections.find(item => item.name === '日常用语')!;
      expect(daily).toMatchObject({ languagePair: { source: 'ja', target: 'zh-Hans' } });
      expect(remembered.data.entries.filter(entry => entry.collectionId === daily.id)).toEqual([expect.objectContaining({ kind: 'term', enabled: true,
        origin: expect.objectContaining({ kind: 'manual' }), payload: expect.objectContaining({ source: 'ありがとう', target: '多谢' }) })]);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      await rm(root, { recursive: true, force: true });
    }
  }, 180000);
});
