import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

type RevisionPayload = { request: string; editableFields: string[]; items: { id: string; source: string; target?: string }[] };

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('subtitle AI revision', () => {
  it('proposes, previews, applies and undoes an AI revision of selected cues', async () => {
    const artifacts = path.resolve('test-results/studio-cue-revision'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const input = path.join(root, 'cue-revision.srt');
    const lines = ['Welcome back', 'Today deep sea released a new model', 'Deep sea says it is open', 'Thanks for watching', 'See you'];
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
          content = /nothing/.test(payload.request) ? { items: [], note: '所选字幕无需修改。' } : {
            items: items.filter(item => /deep sea/i.test(item.source)).map(item => ({
              id: item.id, source: item.source.replace(/deep sea/i, 'DeepSeek'),
              // The first line's translation is kept as it is; the others are revised.
              ...(item.source.startsWith('Today') ? {} : { target: `DeepSeek 表示它是开源的` }),
            })),
            note: '已将“deep sea”更正为 DeepSeek。',
          };
        } else content = { items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: `译 ${item.text}` })) };
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
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(5);

      // Translate everything first, so that the revision can update translations too.
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+a');
      await page.getByTestId('studio-cue-toolbar-translate').click();
      await page.getByRole('dialog', { name: '翻译所选字幕' }).getByTestId('studio-translation-start').click();
      await uiExpect(rows.nth(4).locator('[data-field=target]')).toHaveText('译 See you');

      // Select rows 1–3 and open AI revision from the context menu.
      await rows.nth(0).locator('.studio-cue-number').click();
      await rows.nth(2).locator('.studio-cue-number').click({ modifiers: ['Shift'] });
      await rows.nth(1).click({ button: 'right' });
      const menu = page.getByTestId('studio-cue-context-menu'); await uiExpect(menu).toBeVisible();
      await menu.getByTestId('studio-cue-revise').click();
      const dialog = page.getByRole('dialog', { name: 'AI 修订' });
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog).toContainText('已选 3 条字幕');
      const instructions = dialog.getByTestId('studio-cue-revision-instructions');
      await uiExpect(instructions).toBeFocused();
      await uiExpect(dialog.getByTestId('studio-cue-revision-field-both')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(dialog.getByTestId('studio-cue-revision-model')).toContainText('Controlled model');
      await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, '01-request.png') });

      // A request with nothing to change says so and offers nothing to apply.
      await instructions.fill('nothing to fix here');
      await instructions.press('Control+Enter');
      await uiExpect(dialog.getByTestId('studio-cue-revision-result')).toContainText('AI 认为这些字幕无需修改。');
      await uiExpect(dialog.getByTestId('studio-cue-revision-apply')).toHaveCount(0);

      await instructions.fill('“deep sea” 是转写错误，应为公司名 DeepSeek');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      const items = dialog.getByTestId('studio-cue-revision-item');
      await uiExpect(items).toHaveCount(2);
      expect(revisions.at(-1)).toMatchObject({ editableFields: ['source', 'target'], items: [{ source: 'Welcome back' }, { source: 'Today deep sea released a new model' }, { source: 'Deep sea says it is open' }] });
      await uiExpect(items.nth(0).locator('del')).toHaveText('deep sea');
      await uiExpect(items.nth(0).locator('ins')).toHaveText('DeepSeek');
      await uiExpect(items.nth(0)).toContainText('译文沿用');
      await uiExpect(items.nth(1).locator('[data-field=target] ins').first()).toBeVisible();
      await uiExpect(dialog.getByTestId('studio-cue-revision-note')).toContainText('DeepSeek');
      await uiExpect(dialog).toContainText('本次用量 120 tokens');
      await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, '02-preview.png') });

      // Leave the second proposal out, then apply.
      await items.nth(1).getByRole('checkbox').click();
      const apply = dialog.getByTestId('studio-cue-revision-apply');
      await uiExpect(apply).toHaveText('应用 1 条修订');
      await apply.click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText('Today DeepSeek released a new model');
      // The kept translation stays current; the excluded row is untouched.
      await uiExpect(rows.nth(1).locator('[data-field=target]')).not.toContainText('原文已变更');
      await uiExpect(rows.nth(2).locator('[data-field=source]')).toHaveText('Deep sea says it is open');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：AI 修订 1 条字幕');
      await page.screenshot({ path: path.join(artifacts, '03-applied.png') });

      // One undo restores the revision.
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText('Today deep sea released a new model');
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toHaveText('译 Today deep sea released a new model');

      // From the toolbar, revise row 3 both ways, in dark theme and a narrow window.
      await win.evaluate(window => window.setSize(800, 600));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await rows.nth(2).locator('.studio-cue-number').click();
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog).toContainText('已选 1 条字幕');
      await dialog.getByTestId('studio-cue-revision-instructions').fill('deep sea → DeepSeek');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await uiExpect(items).toHaveCount(1);
      await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, '04-narrow-dark.png') });
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(rows.nth(2).locator('[data-field=source]')).toHaveText('DeepSeek says it is open');
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toContainText('DeepSeek 表示它是开源的');

      const stored = await page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const read = await window.subtitleStudio.readDocumentPage({ documentId: listed.value.documents[0].id, revision: listed.value.documents[0].revision, offset: 0 });
        if (!read.ok) throw Error(read.error);
        const track = read.value.translationTracks[0];
        return { sources: read.value.cues.map(cue => cue.source.plain), entry: track.entries[read.value.cues[2].id], current: track.entries[read.value.cues[2].id].sourceRevision === read.value.cues[2].sourceRevision };
      });
      expect(stored.sources).toEqual(['Welcome back', 'Today deep sea released a new model', 'DeepSeek says it is open', 'Thanks for watching', 'See you']);
      expect(stored.entry).toMatchObject({ origin: 'ai', reviewStatus: 'reviewed', text: { plain: 'DeepSeek 表示它是开源的' } });
      expect(stored.current).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 120000);

  it('finds and revises a misheard name across the whole document without a selection', async () => {
    const artifacts = path.resolve('test-results/studio-cue-revision'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'document-'));
    const input = path.join(root, 'cue-revision-document.srt');
    // 250 lines; the misheard name appears on pages 1 and 3, once with another wrong character.
    const lines = Array.from({ length: 250 }, (_, index) => `第 ${index + 1} 句台词。`);
    lines[4] = '法尔童驾着太阳车出发了。'; lines[119] = '人们说法而童太年轻了。'; lines[239] = '法尔童最终坠落了。'; lines[59] = '法厄同是太阳神的儿子。';
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
    await writeFile(input, lines.map((line, index) => `${index + 1}\n${time(index * 2000)} --> ${time(index * 2000 + 1500)}\n${line}\n`).join('\n'));
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const locates: { request: string; lineCount: number; sample: string[] }[] = [];
    let revised = 0;
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content);
        let content: unknown;
        if ('lineCount' in payload) {
          locates.push(payload);
          content = /句号/.test(payload.request) ? { strategy: 'all', note: '需要逐句检查标点。' } : { strategy: 'terms', terms: ['法尔童'], note: '查找“法尔童”及相近写法。' };
        } else {
          const items = (payload as RevisionPayload).items;
          revised += items.length;
          content = { items: items.filter(item => /法[尔而]童/.test(item.source)).map(item => ({ id: item.id, source: item.source.replace(/法[尔而]童/, '法厄同') })), note: '已将误写更正为“法厄同”。' };
        }
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
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(100);

      // With nothing selected the toolbar opens a revision of the whole document.
      await uiExpect(page.getByTestId('studio-cue-selected-count')).toHaveText('');
      await uiExpect(page.getByTestId('studio-cue-toolbar-revise')).toHaveAccessibleName('AI 修订整个文档…');
      await page.getByTestId('studio-cue-toolbar-revise').click();
      const dialog = page.getByRole('dialog', { name: 'AI 修订' });
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog.getByTestId('studio-cue-revision-scope-document')).toHaveAttribute('aria-checked', 'true');
      await uiExpect(dialog.getByTestId('studio-cue-revision-scope-selection')).toBeDisabled();
      const instructions = dialog.getByTestId('studio-cue-revision-instructions');
      await instructions.fill('文中的“法尔童”都应为“法厄同”');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      const items = dialog.getByTestId('studio-cue-revision-item');
      await uiExpect(items).toHaveCount(3);
      expect(locates[0]).toMatchObject({ request: '文中的“法尔童”都应为“法厄同”', lineCount: 250 });
      expect(locates[0].sample.length).toBeGreaterThan(0);
      // Only the found lines were sent for revision: the exact, the near miss and the correct form's neighbours are not.
      expect(revised).toBe(3);
      const plan = dialog.getByTestId('studio-cue-revision-plan');
      await uiExpect(plan).toContainText('法尔童');
      await uiExpect(plan).toContainText('找到 3 条相关字幕');
      await uiExpect(items.nth(1).locator('.studio-cue-revision-number')).toHaveText('120');
      await uiExpect(items.nth(1).locator('del')).toHaveText('而童');
      await uiExpect(items.nth(2).locator('del')).toHaveText('尔童');
      await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, '05-document-preview.png') });
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('法厄同驾着太阳车出发了。');
      const sources = () => page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const doc = listed.value.documents[0]; const all: string[] = [];
        for (let offset = 0; offset < doc.cueCount; offset += 100) {
          const read = await window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset });
          if (!read.ok) throw Error(read.error);
          all.push(...read.value.cues.map(cue => cue.source.plain));
        }
        return all;
      });
      const fixed = await sources();
      expect([fixed[4], fixed[119], fixed[239], fixed[59]]).toEqual(['法厄同驾着太阳车出发了。', '人们说法厄同太年轻了。', '法厄同最终坠落了。', '法厄同是太阳神的儿子。']);
      // Lines on other pages are undone together with the visible one.
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：AI 修订 3 条字幕');
      await page.getByTestId('studio-cue-undo').click();
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('法尔童驾着太阳车出发了。');
      expect((await sources())[119]).toBe('人们说法而童太年轻了。');

      // A request no wording can find checks every line, after asking.
      revised = 0;
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await instructions.fill('把所有句末的句号去掉');
      await instructions.press('Control+Enter');
      const confirm = dialog.getByTestId('studio-cue-revision-confirm');
      await uiExpect(confirm).toContainText('需要逐条检查 250 条字幕，约 7 次模型请求');
      expect(revised).toBe(0);
      await uiExpect(dialog.getByTestId('studio-cue-revision-generate')).toHaveText('继续检查');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await uiExpect(dialog.getByTestId('studio-cue-revision-result')).toContainText('逐条检查全部 250 条字幕');
      expect(revised).toBe(250);
      await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, '06-document-scan.png') });
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 120000);
});
