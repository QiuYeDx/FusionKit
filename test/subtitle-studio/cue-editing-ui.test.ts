import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('subtitle preview editing', () => {
  it('selects, edits, translates, deletes and undoes cues in the preview list', async () => {
    const artifacts = path.resolve('test-results/studio-cue-editing'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const input = path.join(root, 'cue-editing.srt');
    await writeFile(input, [1, 2, 3, 4, 5].map(index => `${index}\n00:00:0${index},000 --> 00:00:0${index},800\nLine ${index}\n`).join('\n'));
    let app: ElectronApplication | undefined; let server: Server | undefined; let requests = 0;
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const payload = JSON.parse(JSON.parse(body).messages[1].content); const run = ++requests;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: `译${run} ${item.text}` })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'cue-edit-model', name: 'Controlled translation', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'controlled-translation', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'cue-edit-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(5);
      const status = page.getByTestId('studio-cue-selected-count');
      await uiExpect(status).toHaveText('');

      // Click, then Shift+click selects a range; the toolbar offers to translate it into a new track.
      await rows.nth(1).locator('.studio-cue-number').click();
      await rows.nth(2).locator('.studio-cue-number').click({ modifiers: ['Shift'] });
      await uiExpect(status).toHaveText('已选中 2 条');
      await uiExpect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.screenshot({ path: path.join(artifacts, '01-range-selected.png') });
      await page.getByTestId('studio-cue-toolbar-translate').click();
      const dialog = page.getByRole('dialog', { name: '翻译所选字幕' });
      await uiExpect(dialog).toBeVisible();
      await uiExpect(dialog.getByTestId('studio-cue-translate-scope')).toContainText('2 条');
      await dialog.getByTestId('studio-translation-start').click();
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toHaveText(/^译\d+ Line 2$/);
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toHaveText(/^译\d+ Line 3$/);
      await uiExpect(rows.nth(0).locator('[data-field=target]')).toHaveText('未翻译');

      // Retranslate one row into the existing track from the context menu.
      const before = await rows.nth(1).locator('[data-field=target]').innerText();
      await rows.nth(1).click({ button: 'right' });
      const menu = page.getByTestId('studio-cue-context-menu'); await uiExpect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: '重新翻译所选', exact: true }).click();
      const again = page.getByRole('dialog', { name: '重新翻译所选字幕' }); await uiExpect(again).toBeVisible();
      await uiExpect(again.getByTestId('studio-cue-translate-scope')).toContainText('替换');
      await again.getByTestId('studio-translation-start').click();
      await uiExpect(rows.nth(1).locator('[data-field=target]')).not.toHaveText(before);
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toHaveText(/^译\d+ Line 3$/);
      await uiExpect(page.locator('.studio-translation-track-controls [role=combobox]')).toHaveCount(1);

      // Inline source edit: the existing translation becomes stale.
      await rows.nth(1).locator('[data-field=source]').dblclick();
      const editor = rows.nth(1).locator('.studio-cue-editor textarea');
      await uiExpect(editor).toBeFocused();
      await editor.fill('Line two, corrected');
      await page.screenshot({ path: path.join(artifacts, '02-inline-editor.png') });
      await editor.press('Enter');
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText('Line two, corrected');
      await uiExpect(rows.nth(1).locator('[data-field=target]')).toContainText('原文已变更');

      // Reserved characters are refused in place; Escape keeps the saved text.
      await rows.nth(0).locator('[data-field=source]').dblclick();
      await rows.nth(0).locator('.studio-cue-editor textarea').fill('Line <b>1</b>');
      await rows.nth(0).locator('.studio-cue-editor textarea').press('Enter');
      await uiExpect(rows.nth(0).locator('.studio-cue-editor [role=alert]')).toContainText('< 或 >');
      await rows.nth(0).locator('.studio-cue-editor textarea').press('Escape');
      await uiExpect(rows.nth(0).locator('[data-field=source]')).toHaveText('Line 1');

      // Human translation, then undo and redo from the keyboard.
      await rows.nth(2).locator('[data-field=target]').dblclick();
      const target = rows.nth(2).locator('.studio-cue-editor textarea');
      await target.fill('人工译文');
      await target.press('Enter');
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toHaveText('人工译文');
      await uiExpect(rows.nth(2).getByRole('img', { name: '人工修改' })).toBeVisible();
      await uiExpect(page.getByTestId('studio-cue-list')).toBeFocused();
      await page.keyboard.press('Control+z');
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toHaveText(/^译\d+ Line 3$/);
      await page.keyboard.press('Control+y');
      await uiExpect(rows.nth(2).locator('[data-field=target]')).toHaveText('人工译文');

      // Marquee selects the last two rows; Delete removes them and the notice undoes it.
      const from = await rows.nth(3).locator('.studio-cue-time').boundingBox();
      const to = await rows.nth(4).locator('.studio-cue-time').boundingBox();
      await page.mouse.move(from!.x + from!.width - 4, from!.y + 4);
      await page.mouse.down();
      await page.mouse.move(to!.x + 20, to!.y + to!.height - 4, { steps: 8 });
      await uiExpect(page.getByTestId('studio-cue-marquee')).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '03-marquee.png') });
      await page.mouse.up();
      await uiExpect(status).toHaveText('已选中 2 条');
      await page.keyboard.press('Delete');
      await uiExpect(rows).toHaveCount(3);
      const notice = page.getByTestId('studio-cue-notice');
      await uiExpect(notice).toContainText('已删除 2 条字幕');
      await page.screenshot({ path: path.join(artifacts, '04-deleted.png') });
      await notice.getByRole('button', { name: '撤销', exact: true }).click();
      await uiExpect(rows).toHaveCount(5);
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('Line 5');

      // Review marks apply to the whole selection.
      await rows.nth(1).locator('.studio-cue-number').click();
      await rows.nth(2).locator('.studio-cue-number').click({ modifiers: ['Control'] });
      await page.getByTestId('studio-cue-toolbar-review').click();
      await uiExpect(rows.nth(1).getByRole('img', { name: '已复核' })).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '05-reviewed.png') });

      // The document on disk matches what the list shows.
      const document = await page.evaluate(async () => {
        const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
        const read = await window.subtitleStudio.readDocumentPage({ documentId: listed.value.documents[0].id, revision: listed.value.documents[0].revision, offset: 0 });
        if (!read.ok) throw Error(read.error);
        return { sources: read.value.cues.map(cue => cue.source.plain), tracks: read.value.translationTracks.length };
      });
      expect(document).toEqual({ sources: ['Line 1', 'Line two, corrected', 'Line 3', 'Line 4', 'Line 5'], tracks: 1 });
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 120000);
});
