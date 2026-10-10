import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

type RevisionPayload = { request: string; editableFields: string[]; translationKnowledge?: { items: { payload: { source?: string }; applicableItemIds: string[] }[] }; items: { id: string; source: string; target?: string }[] };

const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('AI revision and translation materials', () => {
  it('revises with the chosen materials and offers the settled wording for keeping after it is applied', async () => {
    const artifacts = path.resolve('test-results/studio-cue-revision-knowledge'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
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
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'cue-revision-model', name: 'Controlled model', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-model', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'cue-revision-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const library = () => page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });

      // A collection with an enabled term, as the user would have it.
      const collectionId = await page.evaluate(async () => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const collectionId = crypto.randomUUID(), sourceId = crypto.randomUUID();
        const pair = { source: 'ja', target: 'zh-Hans' };
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [
          { group: 'collections', record: { id: collectionId, revision: 1, archived: false, name: '绝区零 · 人物与称谓', description: '', aboutSubjectIds: [], defaultLanguagePair: pair } },
          { group: 'entries', adopt: true, source: { id: sourceId, revision: 1, kind: 'user_note', title: 'Note', excerpt: 'seed' },
            record: { id: crypto.randomUUID(), revision: 1, title: 'ホロウ', kind: 'term', collectionId, aboutSubjectIds: [], state: 'ready', scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } },
              evidence: [{ sourceId, support: 'direct' }], derivedFrom: [], payload: { source: 'ホロウ', target: '空洞', aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } } },
        ] });
        if (!saved.ok) throw new Error(saved.error);
        return collectionId;
      });

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
      if (!/日语/.test(await source.innerText())) { await source.click(); await page.getByRole('option', { name: '日语', exact: true }).click(); }
      await translation.getByTestId('studio-translation-start').click();
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('时间菲尔德家的大小姐がお見えです。');

      // Revise every line: the materials go with the requests and the dialog names them.
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+a');
      await page.getByTestId('studio-cue-toolbar-revise').click();
      const dialog = page.getByRole('dialog', { name: 'AI 修订' });
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog.getByTestId('studio-cue-revision-materials')).toHaveText('参考资料：绝区零 · 人物与称谓');
      await dialog.getByTestId('studio-cue-revision-instructions').fill('有些翻译不太合适，应该是泰姆菲尔德家的大小姐');
      await dialog.getByTestId('studio-cue-revision-field-target').click();
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await uiExpect(dialog.getByTestId('studio-cue-revision-item')).toHaveCount(2);
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
      await uiExpect(capture).toBeVisible();
      const row = capture.getByTestId('knowledge-capture-row');
      await uiExpect(row).toHaveCount(1);
      await uiExpect(row.getByRole('textbox').nth(0)).toHaveValue(SOURCE);
      await uiExpect(row.getByRole('textbox').nth(1)).toHaveValue(TARGET);
      await uiExpect(page.getByTestId('knowledge-capture-save')).toBeEnabled();
      await uiExpect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      await shot('03-capture-dialog-light');
      await page.getByTestId('knowledge-capture-save').click();
      await uiExpect(capture).toBeHidden();
      await uiExpect(offer).toHaveCount(0);
      const saved = await library();
      const kept = saved.data.entries.find(entry => entry.kind === 'term' && entry.payload.target === TARGET)!;
      expect(kept).toMatchObject({ collectionId, state: 'ready', payload: { source: SOURCE, sense: '家族名' } });
      expect(saved.approvals[kept.id]).toMatchObject({ method: 'human' });
      expect(saved.data.sources.find(item => item.id === kept.evidence[0].sourceId)).toMatchObject({ kind: 'user_note', excerpt: '有些翻译不太合适，应该是泰姆菲尔德家的大小姐' });

      // Already kept: the same wording is not offered again.
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('时间菲尔德家的大小姐がお見えです。');
      await page.keyboard.press('Control+a');
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await dialog.getByTestId('studio-cue-revision-instructions').fill('统一家族名');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await uiExpect(dialog.getByTestId('studio-cue-revision-item')).toHaveCount(2);
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();
      await page.waitForTimeout(800);
      await uiExpect(offer).toHaveCount(0);

      // A new wording is offered, and an undo takes the offer away. Dark theme.
      await page.evaluate(async id => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const result = await window.translationKnowledge.reviewEntries({ generation: current.value.generation, ids: [id], action: 'archive' });
        if (!result.ok) throw new Error(result.error);
        // Another collection translates the name differently.
        const other = crypto.randomUUID(), sourceId = crypto.randomUUID(), pair = { source: 'ja', target: 'zh-Hans' };
        const added = await window.translationKnowledge.saveRecords({ generation: result.value.generation, items: [
          { group: 'collections', record: { id: other, revision: 1, archived: false, name: '旧版译名', description: '', aboutSubjectIds: [], defaultLanguagePair: pair } },
          { group: 'entries', source: { id: sourceId, revision: 1, kind: 'user_note', title: 'Note', excerpt: 'old' },
            record: { id: crypto.randomUUID(), revision: 1, title: 'old', kind: 'term', collectionId: other, aboutSubjectIds: [], state: 'candidate', scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } },
              evidence: [{ sourceId, support: 'direct' }], derivedFrom: [], payload: { source: 'テイムフィールド家のお嬢様', target: '时间菲尔德家的大小姐', aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: false }, strength: 'preferred' } } },
        ] });
        if (!added.ok) throw new Error(added.error);
      }, kept.id);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+a');
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await dialog.getByTestId('studio-cue-revision-instructions').fill('统一家族名');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(offer).toBeVisible();
      await shot('04-offer-dark');
      await page.getByTestId('studio-knowledge-offer-open').click();
      await uiExpect(capture).toBeVisible();
      await uiExpect(capture.getByTestId('knowledge-capture-row')).toHaveAttribute('data-status', 'conflict');
      await uiExpect(capture.getByTestId('knowledge-capture-row')).toContainText('「旧版译名」中译为「时间菲尔德家的大小姐」');
      await shot('05-capture-dialog-dark');
      await page.keyboard.press('Escape');
      await uiExpect(capture).toBeHidden();
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(offer).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180000);
});
