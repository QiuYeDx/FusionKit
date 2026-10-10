import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

const SOURCE = 'テイムフィールド家のお嬢様';
const RIGHT = '泰姆菲尔德家的大小姐';
const WRONG = '时间菲尔德家的大小姐';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('terminology consistency check', () => {
  it('finds a name translated two ways across documents, unifies it, keeps it and undoes it', async () => {
    const artifacts = path.resolve('test-results/studio-consistency'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const write = async (name: string, lines: string[]) => { const file = path.join(root, name); await writeFile(file, lines.map((line, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 1},800\n${line}\n`).join('\n')); return file; };
    const files = [
      await write('第一集.srt', [`${SOURCE}がお見えです。`, `${SOURCE}！`, 'こんにちは。']),
      await write('第二集.srt', [`${SOURCE}、どうぞ。`, `${SOURCE}！大変です！`, 'ありがとう。']),
    ];
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const checks: { lines: { source: string; target?: string }[] }[] = [];
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        let content: unknown;
        if ('lines' in payload) { checks.push(payload); content = { terms: [{ source: SOURCE, targets: [RIGHT, WRONG], sourceVariants: [] }, { source: 'こんにちは', targets: ['你好'], sourceVariants: [] }] }; }
        else content = { items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: item.text.replace(SOURCE, item.text.includes('！') ? WRONG : RIGHT) })) };
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
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'consistency-model', name: 'Controlled model', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-model', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'consistency-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const targets = () => page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const result: Record<string, string[]> = {};
        for (const doc of listed.value.documents) {
          const read = await window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 }); if (!read.ok) throw Error(read.error);
          const track = read.value.translationTracks.at(-1);
          result[doc.origin.displayName] = read.value.cues.map(cue => track?.entries[cue.id]?.text.plain ?? '');
        }
        return result;
      });

      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, files);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success', { timeout: 30000 });
      await page.getByRole('button', { name: '完成', exact: true }).click();
      // Translate both documents.
      await page.getByTestId('studio-library-select-all').check();
      await page.getByRole('button', { name: '批量翻译', exact: true }).click();
      const translation = page.getByRole('dialog').filter({ has: page.getByTestId('studio-translation-form') });
      await translation.getByTestId('studio-translation-check').click();
      await page.getByRole('dialog').filter({ has: page.getByTestId('studio-translation-review-dialog') }).getByTestId('studio-translation-review-start').click();
      await uiExpect(page.getByTestId('studio-batch-result')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
      await expect.poll(async () => Object.values(await targets()).flat().filter(Boolean).length, { timeout: 30000 }).toBe(6);
      expect((await targets())['第一集.srt']).toEqual([`${RIGHT}がお見えです。`, `${WRONG}！`, 'こんにちは。']);

      // Check both selected documents from the batch menu.
      await page.locator('#studio-library-batch-actions').click();
      await page.getByTestId('studio-library-batch-consistency').click();
      const dialog = page.getByRole('dialog', { name: '术语一致性检查' });
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog).toContainText('检查所选 2 个文档共 6 条字幕');
      await dialog.getByTestId('studio-consistency-focus').fill('人名');
      await dialog.getByTestId('studio-consistency-check').click();
      const groups = dialog.getByTestId('studio-consistency-group');
      await uiExpect(groups).toHaveCount(1);
      expect(checks.at(-1)).toMatchObject({ focus: '人名' });
      expect(checks.at(-1)!.lines).toHaveLength(6);
      await uiExpect(dialog.getByTestId('studio-consistency-result')).toContainText('发现 1 组写法不统一（检查 6 条）');
      const variants = groups.first().getByTestId('studio-consistency-variant');
      await uiExpect(variants).toHaveCount(2);
      await uiExpect(variants.nth(0)).toHaveAttribute('aria-checked', 'true');
      await uiExpect(variants.nth(0)).toContainText(`${RIGHT}2推荐`);
      await uiExpect(variants.nth(1)).toContainText(`${WRONG}2`);
      await groups.first().getByTestId('studio-consistency-places-toggle').click();
      await uiExpect(groups.first().getByTestId('studio-consistency-places').locator('li')).toHaveCount(4);
      await uiExpect(groups.first().getByTestId('studio-consistency-places')).toContainText('第二集.srt · #2');
      await uiExpect(groups.first().getByTestId('studio-consistency-places').locator('mark').filter({ hasText: WRONG })).toHaveCount(2);
      await uiExpect(dialog.getByTestId('studio-consistency-apply')).toHaveText('统一 1 组（修改 2 条）');
      await shot('01-result-two-documents');

      // Unify, keep the wording, then undo everything from the receipt.
      await dialog.getByTestId('studio-consistency-apply').click();
      await uiExpect(dialog.getByTestId('studio-consistency-receipt')).toContainText('已统一 1 组写法，修改 2 条字幕（2 个文档）');
      expect(Object.values(await targets()).flat().filter(text => text.includes(WRONG))).toEqual([]);
      expect((await targets())['第二集.srt']).toEqual([`${RIGHT}、どうぞ。`, `${RIGHT}！大変です！`, 'ありがとう。']);
      await uiExpect(dialog.getByTestId('studio-consistency-receipt')).toContainText('统一后的 1 个写法可以记入翻译资料');
      await dialog.getByTestId('studio-consistency-keep-open').click();
      const capture = page.getByTestId('knowledge-capture-form');
      await uiExpect(capture).toBeVisible();
      await uiExpect(capture.getByTestId('knowledge-capture-row').getByRole('textbox').nth(1)).toHaveValue(RIGHT);
      await capture.getByRole('combobox').first().click();
      await page.getByRole('option', { name: '新建资料集…' }).or(page.getByRole('option', { name: /新建资料集/ })).first().click();
      await capture.getByRole('textbox', { name: '资料集名称' }).fill('绝区零 · 人物与称谓');
      const sourceLanguage = capture.getByRole('combobox').nth(1);
      if (!/日语/.test(await sourceLanguage.innerText())) { await sourceLanguage.click(); await page.getByRole('option', { name: '日语', exact: true }).click(); }
      await shot('02-keep-wording');
      await page.getByTestId('knowledge-capture-save').click();
      await uiExpect(capture).toBeHidden();
      const kept = await page.evaluate(async () => { const read = await window.translationKnowledge.read(); if (!read.ok) throw Error(read.error); return read.value.data.entries.map(entry => entry.kind === 'term' ? `${entry.payload.source}→${entry.payload.target}` : ''); });
      expect(kept).toEqual([`${SOURCE}→${RIGHT}`]);
      // Kept: the receipt no longer offers it.
      await uiExpect(dialog.getByTestId('studio-consistency-keep-open')).toHaveCount(0);
      await shot('03-receipt');
      await dialog.getByTestId('studio-consistency-undo').click();
      await uiExpect(dialog.getByTestId('studio-consistency-receipt')).toContainText('已撤销本次统一');
      expect((await targets())['第一集.srt']).toEqual([`${RIGHT}がお見えです。`, `${WRONG}！`, 'こんにちは。']);
      expect((await targets())['第二集.srt']).toEqual([`${RIGHT}、どうぞ。`, `${WRONG}！大変です！`, 'ありがとう。']);
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await uiExpect(dialog).toBeHidden();

      // The open document from the preview toolbar, in a narrow dark window; its change joins undo.
      await page.getByTestId('studio-library-select-all').uncheck();
      await page.getByTestId('studio-library-row').filter({ hasText: '第一集' }).locator('.studio-document').click();
      await win.evaluate(window => window.setSize(786, 660));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByTestId('studio-cue-toolbar-consistency').click();
      await uiExpect(dialog).toContainText('检查本文档 3 条字幕');
      await dialog.getByTestId('studio-consistency-check').click();
      await uiExpect(groups).toHaveCount(1);
      await groups.first().getByTestId('studio-consistency-custom').click();
      await groups.first().getByRole('textbox', { name: '自定义标准写法' }).fill('泰姆菲尔德小姐');
      await uiExpect(dialog.getByTestId('studio-consistency-apply')).toHaveText('统一 1 组（修改 2 条）');
      await shot('04-current-document-narrow-dark');
      await groups.first().getByTestId('studio-consistency-keep').uncheck();
      await dialog.getByTestId('studio-consistency-apply').click();
      await uiExpect(dialog.getByTestId('studio-consistency-receipt')).toContainText('修改 2 条字幕（1 个文档）');
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toHaveText('泰姆菲尔德小姐！');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：统一 2 条字幕的写法');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toHaveText(`${WRONG}！`);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180000);

  it('offers one direction per name when only the source spellings differ, and unifies the one chosen', async () => {
    const artifacts = path.resolve('test-results/studio-consistency'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const lines = ['先輩、おはよう。', '先輩！', 'せんぱい？', 'シロバトさん、こっち。', 'ハトさんだ。', 'シロバトさん！'];
    const file = path.join(root, '未翻译.srt');
    await writeFile(file, lines.map((line, index) => `${index + 1}\n00:00:0${index + 1},000 --> 00:00:0${index + 1},800\n${line}\n`).join('\n'));
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const errors: string[] = [];
    try {
      // As reported in a real check: the same name under two headwords, pointing opposite ways, and a headword no line uses.
      server = createServer(async (request, response) => {
        for await (const _ of request) { /* drain */ }
        const content = { terms: [{ source: 'センパイ', targets: [], sourceVariants: ['先輩'] }, { source: '先輩', targets: [], sourceVariants: ['せんぱい'] },
          { source: 'シロバトさん', targets: [], sourceVariants: ['ハトさん'] }, { source: 'ハトさん', targets: [], sourceVariants: ['シロバトさん'] }] };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'consistency-model', name: 'Controlled model', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-model', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'consistency-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const sources = () => page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const doc = listed.value.documents[0];
        const read = await window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 }); if (!read.ok) throw Error(read.error);
        return read.value.cues.map(cue => cue.source.plain);
      });

      await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [file]);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(6);
      await page.getByTestId('studio-cue-toolbar-consistency').click();
      const dialog = page.getByRole('dialog', { name: '术语一致性检查' });
      await dialog.getByTestId('studio-consistency-check').click();
      const groups = dialog.getByTestId('studio-consistency-group');
      // Four reported terms, two names; the headword no line uses is gone.
      await uiExpect(groups).toHaveCount(2);
      const senpai = groups.filter({ hasText: '先輩' });
      const spellings = senpai.getByTestId('studio-consistency-spelling');
      await uiExpect(spellings).toHaveCount(2);
      await uiExpect(spellings.nth(0)).toContainText('先輩2最常见');
      await uiExpect(spellings.nth(1)).toContainText('せんぱい1');
      await uiExpect(senpai).not.toContainText('センパイ');
      await uiExpect(senpai).toContainText('原文统一为');
      // Nothing to record without a translation; nothing chosen yet.
      await uiExpect(dialog.getByTestId('studio-consistency-keep')).toHaveCount(0);
      const apply = dialog.getByTestId('studio-consistency-apply');
      await uiExpect(apply).toHaveText('统一 0 组（修改 0 条）');
      await uiExpect(apply).toBeDisabled();
      await senpai.getByTestId('studio-consistency-apply-group').click();
      await uiExpect(apply).toHaveText('统一 1 组（修改 1 条）');
      await uiExpect(apply).toBeEnabled();
      // Choosing the other spelling turns the direction around; only one is ever selected.
      await spellings.nth(1).click();
      await uiExpect(apply).toHaveText('统一 1 组（修改 2 条）');
      await uiExpect(senpai.locator('[data-testid=studio-consistency-spelling][aria-checked=true]')).toHaveCount(1);
      await spellings.nth(0).click();
      // Picking a direction in the other group selects it too.
      const pigeon = groups.filter({ hasText: 'シロバトさん' });
      await pigeon.getByTestId('studio-consistency-spelling').filter({ hasText: 'シロバトさん' }).click();
      await uiExpect(apply).toHaveText('统一 2 组（修改 2 条）');
      await shot('05-source-spellings-dark');
      await apply.click();
      await uiExpect(dialog.getByTestId('studio-consistency-receipt')).toContainText('修改 2 条字幕');
      await uiExpect(dialog.getByTestId('studio-consistency-keep-open')).toHaveCount(0);
      expect(await sources()).toEqual(['先輩、おはよう。', '先輩！', '先輩？', 'シロバトさん、こっち。', 'シロバトさんだ。', 'シロバトさん！']);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180000);
});
