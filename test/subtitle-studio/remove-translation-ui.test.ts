import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('translation record removal confirmation', () => {
  it('names the selected record like the selector and removes only that record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-remove-translation-'));
    const artifacts = path.resolve('test-results/studio-remove-translation');
    await mkdir(artifacts, { recursive: true });
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      requests.push(body);
      const payload = JSON.parse(JSON.parse(body).messages[1].content);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map((item: { id: string }) => ({ id: item.id, text: `译文 ${item.id}` })) }) } }], usage: { prompt_tokens: 14450, completion_tokens: 1312, total_tokens: 15762 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const filename = '原始文件名不应成为清除目标.lrc';
    const source = '[00:01.00]A quiet evening.\n[00:03.00]Time to rest.\n';
    const input = path.join(root, filename); await writeFile(input, source);
    const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
      const window = await app.browserWindow(page);
      await window.evaluate(win => { win.setSize(1280, 860); win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'remove-fixture', name: 'Local fixture', provider: 'Other', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'fixture', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'remove-fixture', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload();
      const settled = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await settled();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(2);
      const readDocument = () => page.evaluate(async () => {
        // Background translation commits can advance the revision between list and read.
        for (let attempt = 0; attempt < 10; attempt++) {
          const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw Error(listed.error);
          const document = listed.value.documents[0];
          const read = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
          if (read.ok) return read.value;
          if (read.error !== 'revision_conflict') throw Error(read.error);
        }
        throw Error('Document did not settle during bounded read retries');
      });
      for (let index = 0; index < 2; index++) {
        await page.getByRole('button', { name: '翻译', exact: true }).click();
        await uiExpect(page.getByTestId('studio-translation-name')).toHaveValue('');
        if (index === 1) {
          await page.getByTestId('studio-translation-name').fill('夜间陪伴 · 初稿');
          await page.screenshot({ path: path.join(artifacts, 'name-before-translation-light.png'), animations: 'disabled' });
        }
        await page.getByTestId('studio-translation-check').click();
        await uiExpect(page.getByTestId('studio-translation-review-start')).toBeEnabled();
        await page.getByTestId('studio-translation-review-start').click();
        await uiExpect.poll(async () => (await readDocument()).tasks.filter(task => task.status === 'completed').length).toBe(index + 1);
      }
      const initial = await readDocument(); expect(initial.translationTracks).toHaveLength(2);
      const checkToolbar = async (name: string) => {
        const toolbar = page.locator('.studio-translation-toolbar');
        await uiExpect(page.getByTestId('studio-execution-record')).toBeVisible();
        await uiExpect.poll(() => toolbar.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(46);
        expect(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        const record = (await page.getByTestId('studio-execution-record').boundingBox())!;
        const rename = (await page.getByTestId('studio-rename-translation').boundingBox())!;
        expect(Math.abs(record.y + record.height / 2 - rename.y - rename.height / 2)).toBeLessThan(2);
        await page.locator('.studio-translation-usage').hover();
        await uiExpect(page.getByRole('tooltip', { name: /实际 tokens/ })).toContainText('14,450');
        await page.mouse.move(1, 1);
        await page.screenshot({ path: path.join(artifacts, `toolbar-${name}.png`), animations: 'disabled' });
      };
      await window.evaluate(win => win.setSize(1100, 800));
      await checkToolbar('light-constrained');
      expect(initial.translationTracks[0].name).toBeUndefined();
      expect(initial.translationTracks[1].name).toBe('夜间陪伴 · 初稿');
      expect(requests.join('\n')).not.toContain('夜间陪伴');
      const selector = page.getByRole('combobox', { name: '译文轨', exact: true });
      const dialog = page.getByRole('dialog');
      const target = page.getByTestId('studio-remove-translation-target');
      const select = async (label: string) => { await selector.click(); await page.getByRole('option', { name: label, exact: true }).click(); };
      const openConfirmation = async (label: string) => {
        await select(label);
        await page.getByRole('button', { name: '清除译文', exact: true }).click();
        await uiExpect(target.locator('dd')).toHaveText(label);
        await uiExpect(dialog).not.toContainText(filename);
        await uiExpect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
        await uiExpect.poll(() => target.locator('dd').evaluate(node => getComputedStyle(node).fontSize)).toBe('13px');
        await uiExpect.poll(() => dialog.evaluate(node => Math.abs(node.getBoundingClientRect().height - node.clientHeight))).toBeLessThan(3);
      };
      await selector.click();
      const recordNames = await page.getByRole('option').allTextContents();
      expect(recordNames).toEqual(['zh · 1', '夜间陪伴 · 初稿']);
      await page.keyboard.press('Escape');
      await openConfirmation(recordNames[0]);
      await page.screenshot({ path: path.join(artifacts, 'record-1-light.png'), animations: 'disabled' });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await uiExpect(dialog).toHaveCount(0); expect((await readDocument()).translationTracks).toHaveLength(2);
      await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
      await window.evaluate(win => win.setSize(820, 700)); await page.reload(); await settled();
      await uiExpect(page.locator('html')).toHaveClass(/dark/);
      await checkToolbar('dark-narrow');
      await select(recordNames[1]);
      await page.getByTestId('studio-rename-translation').click();
      await page.getByTestId('studio-rename-input').fill('取消的改名');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await uiExpect(selector).toHaveText(recordNames[1]);
      await page.getByTestId('studio-rename-translation').click();
      await page.getByTestId('studio-rename-input').fill('夜间陪伴 · 校订版');
      await uiExpect.poll(() => dialog.evaluate(node => Math.abs(node.getBoundingClientRect().height - node.clientHeight))).toBeLessThan(3);
      await page.screenshot({ path: path.join(artifacts, 'rename-dark-narrow.png'), animations: 'disabled' });
      await page.getByTestId('studio-rename-save').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(selector).toHaveText('夜间陪伴 · 校订版');
      await page.reload(); await settled();
      await select('夜间陪伴 · 校订版');
      await page.getByTestId('studio-rename-translation').click();
      await dialog.getByRole('button', { name: '恢复自动命名', exact: true }).click();
      await page.getByTestId('studio-rename-save').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(selector).toHaveText('zh · 2');
      const longName = '很长的翻译结果名称'.repeat(10);
      await page.getByTestId('studio-rename-translation').click();
      await page.getByTestId('studio-rename-input').fill(longName);
      await page.getByTestId('studio-rename-save').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(selector).toHaveText(longName);
      expect(await selector.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await selector.click();
      const longOption = page.getByRole('option', { name: longName, exact: true });
      await uiExpect(longOption).toBeVisible();
      expect(await longOption.evaluate(node => {
        const box = node.getBoundingClientRect();
        return node.scrollWidth <= node.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth;
      })).toBe(true);
      await page.screenshot({ path: path.join(artifacts, 'long-name-dark-narrow.png'), animations: 'disabled' });
      await longOption.click();
      await page.getByTestId('studio-rename-translation').click();
      await page.getByTestId('studio-rename-input').fill('夜间陪伴 · 校订版');
      await page.getByTestId('studio-rename-save').click();
      await uiExpect(dialog).toHaveCount(0);
      recordNames[1] = '夜间陪伴 · 校订版';
      await openConfirmation(recordNames[1]);
      await page.screenshot({ path: path.join(artifacts, 'record-2-dark-narrow.png'), animations: 'disabled' });
      await dialog.getByRole('button', { name: '清除译文', exact: true }).click();
      await uiExpect(dialog).toHaveCount(0);
      const remaining = await readDocument();
      expect(remaining.translationTracks.map(track => track.id)).toEqual([initial.translationTracks[0].id]);
      expect(remaining.tasks.map(task => task.trackId)).toEqual([initial.translationTracks[0].id]);
      expect(remaining.cues).toEqual(initial.cues);
      expect(await readFile(input, 'utf8')).toBe(source);
      await uiExpect(selector).toHaveText(recordNames[0]);
      expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
      throw error;
    } finally {
      try { await app.close(); }
      finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        expect(path.dirname(root)).toBe(path.resolve(tmpdir())); expect(path.basename(root)).toMatch(/^studio-remove-translation-/);
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 120000);
});
