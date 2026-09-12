import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import type { DocumentPage } from '../../src/subtitle-studio/ipc-contract';

describe.runIf(process.env.FUSIONKIT_STUDIO_I6_COPY_UI === '1')('I6 explicit copy and concise results', () => {
  it('copies the selected content and reveals operation details only on request', async () => {
    const artifacts = path.resolve('test-results/studio-i6-copy'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-')); const profile = path.join(root, 'profile');
    const lrc = path.join(root, '01-双语剪贴板测试.lrc');
    await writeFile(lrc, '[00:01.000]Hello world.\n[00:01.000]你好世界。\n[00:03.000]The light is on.\n[00:03.000]灯已经亮了。\n[00:05.000]We can leave now.\n[00:05.000]我们现在可以走了。\n[00:07.000]One more line.\n');
    const srts = [path.join(root, '02-完整时间与长名称-字幕内容测试-September.srt'), path.join(root, '03-待翻译字幕.srt')];
    for (const file of srts) await writeFile(file, '1\n00:00:01,250 --> 00:00:03,900\nOriginal second document.\n');
    const invalid = path.join(root, '04-invalid.bin'); await writeFile(invalid, 'not a supported subtitle');
    let app: ElectronApplication | undefined; let server: Server | undefined; let restored = false;
    const errors: string[] = []; let requests = 0; const evidence: Record<string, unknown> = {};
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const input = JSON.parse(JSON.parse(body).messages[1].content); requests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: input.items.map((item: { id: string }) => ({ id: item.id, text: 'Controlled translation.' })) }) } }] }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', '--user-data-dir=' + profile], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      // Preserve the existing clipboard in main-process memory, including image/rich text. Never log it.
      await app.evaluate(({ clipboard }) => {
        const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage(), bookmark: clipboard.readBookmark().title };
        (globalThis as typeof globalThis & { __i6RestoreClipboard?: () => void }).__i6RestoreClipboard = () => clipboard.write(saved);
      });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(port => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{ id: 'i6-copy-model', name: 'Controlled translation', provider: 'Other', apiKey: 'synthetic-test-key', baseUrl: 'http://127.0.0.1:' + port + '/v1', modelKey: 'controlled-translation', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }], assignment: { taskExecution: 'i6-copy-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, lrc);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const bilingual = page.getByRole('dialog', { name: '整理双语字幕', exact: true }); await uiExpect(bilingual).toBeVisible();
      await bilingual.getByRole('button', { name: '确认整理', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);
      const trigger = page.locator('.studio-cue-table tbody tr').first().getByRole('button', { name: '选择复制内容', exact: true });
      // Windows clipboard text uses CRLF; compare content without changing spaces or source lines.
      const readClipboard = async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
      await app.evaluate(({ clipboard }) => clipboard.writeText('i6-copy-sentinel'));
      await trigger.click(); expect(await readClipboard()).toBe('i6-copy-sentinel');
      await page.screenshot({ path: path.join(root, '01-copy-options-light.png'), animations: 'disabled' });
      await page.getByRole('menuitem', { name: '复制译文', exact: true }).click();
      await uiExpect.poll(readClipboard).toBe('你好世界。');
      await trigger.click(); await page.getByRole('menuitem', { name: '复制双语', exact: true }).click();
      await uiExpect.poll(readClipboard).toBe('Hello world.\n你好世界。');
      await trigger.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: '复制原文', exact: true }).focus(); await page.keyboard.press('Enter');
      await uiExpect.poll(readClipboard).toBe('Hello world.');
      await trigger.click(); await page.getByRole('menuitem', { name: '带时间信息复制', exact: true }).hover();
      const timed = page.getByTestId('studio-copy-timed-menu'); await uiExpect(timed).toBeVisible(); await uiExpect(timed).toContainText('结束时间未知');
      await timed.getByRole('menuitem', { name: '复制双语', exact: true }).click();
      await uiExpect.poll(readClipboard).toBe('[00:00:01.000]\nHello world.\n你好世界。');
      await page.locator('.studio-cue-table tbody tr').last().getByRole('button', { name: '选择复制内容', exact: true }).click();
      await uiExpect(page.getByRole('menuitem', { name: '复制译文', exact: true })).toHaveAttribute('aria-disabled', 'true');
      await uiExpect(page.getByRole('menuitem', { name: '复制双语', exact: true })).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape');
      evidence.copy = { openingDoesNotCopy: true, source: true, target: true, bilingual: true, unknownEndNotInvented: true, missingTranslationDisabled: true, keyboard: true };

      await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [...srts, invalid]);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const result = page.getByTestId('studio-library-result'); await uiExpect(result).toBeVisible();
      await uiExpect(result.locator('.studio-document-row')).toHaveCount(0);
      await uiExpect(result).toContainText('成功 2 份'); await uiExpect(result).toContainText('失败 1 份');
      await page.screenshot({ path: path.join(root, '02-import-result-summary.png'), animations: 'disabled' });
      await result.locator('summary', { hasText: '查看失败详情' }).click();
      await uiExpect(result.locator('.studio-document-row')).toHaveCount(1); await uiExpect(result).toContainText('04-invalid.bin');
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('.studio-document').filter({ hasText: path.basename(srts[0]) }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(1);
      const sourceTrigger = page.locator('.studio-cue-table').getByRole('button', { name: '选择复制内容', exact: true });
      await sourceTrigger.click(); await page.getByRole('menuitem', { name: '带时间信息复制', exact: true }).hover();
      await page.getByTestId('studio-copy-timed-menu').getByRole('menuitem', { name: '复制原文', exact: true }).click();
      await uiExpect.poll(readClipboard).toBe('[00:00:01.250 → 00:00:03.900]\nOriginal second document.'); evidence.knownTime = true;

      await page.getByTestId('studio-library-select-all').check(); await page.getByRole('button', { name: '批量翻译', exact: true }).click();
      const translation = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '计算用量', exact: true }) }); await uiExpect(translation).toBeVisible();
      await translation.getByRole('button', { name: '计算用量', exact: true }).click();
      await uiExpect(translation.getByTestId('studio-batch-plan')).toBeVisible();
      expect(await translation.locator('.studio-translation-plan-details').evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
      await translation.getByRole('button', { name: /开始翻译.*就绪/ }).click();
      const submitted = page.getByTestId('studio-batch-result'); await uiExpect(submitted).toBeVisible();
      await uiExpect(submitted.locator('.studio-document-row')).toHaveCount(0); await uiExpect(submitted).toContainText('已提交');
      await page.screenshot({ path: path.join(root, '03-translation-submitted-summary.png'), animations: 'disabled' });
      await submitted.locator('summary', { hasText: '查看成功详情' }).click(); await uiExpect(submitted.locator('.studio-document-row')).toHaveCount(3);
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      evidence.results = { importSummaryBeforeDetails: true, failureOnDemand: true, translationSubmittedNotCompleted: true, translationDetailsOnDemand: true };

      await uiExpect.poll(() => requests).toBe(3);
      await uiExpect.poll(() => page.evaluate(async () => {
        const result = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 50 });
        return result.ok ? result.value.counts.completed : -1;
      })).toBe(3);
      // Exercise the stale-text visual state without inventing a source editing workflow.
      // The production handler still enforces ownership; only its returned cue revision is decorated.
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const channel = 'subtitle-studio:read-page'; const original = handlers.get(channel);
        if (!original) throw new Error('Missing production read-page handler');
        handlers.set(channel, async (event, input) => {
          const result = await original(event, input) as { ok: boolean; value?: DocumentPage };
          if (!result.ok || !result.value) return result;
          const decorated = structuredClone(result);
          for (const cue of decorated.value!.cues) cue.sourceRevision++;
          return decorated;
        });
        (globalThis as typeof globalThis & { __i6RestoreReader?: () => void }).__i6RestoreReader = () => handlers.set(channel, original);
      });
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await win.evaluate(window => window.setSize(787, 540)); await uiExpect(page.locator('html')).toHaveClass(/dark/);
      const narrowTrigger = page.locator('.studio-cue-table tbody tr').first().getByRole('button', { name: '选择复制内容', exact: true });
      await narrowTrigger.click(); const menuBox = await page.getByTestId('studio-copy-menu').boundingBox();
      await uiExpect(page.getByTestId('studio-copy-menu')).toContainText('已过期');
      expect(menuBox).not.toBeNull(); expect(menuBox!.x).toBeGreaterThanOrEqual(0); expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(786);
      await page.screenshot({ path: path.join(root, '04-copy-narrow-dark.png'), animations: 'disabled' });
      await page.getByRole('menuitem', { name: '复制译文', exact: true }).click();
      await uiExpect.poll(readClipboard).toBe('Controlled translation.');
      evidence.staleTranslation = { responseRevisionDecorationOnly: true, warningVisible: true, copiesVisibleTarget: true };
      await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Controlled clipboard denial'); } }); });
      await narrowTrigger.click(); await page.getByRole('menuitem', { name: '复制原文', exact: true }).click();
      await uiExpect(page.locator('[role=alert]').filter({ hasText: '复制失败' })).toBeVisible();
      evidence.clipboardDeniedVisible = true; evidence.pageErrors = errors; evidence.controlledTranslationRequests = requests;
      expect(errors).toEqual([]); await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
    } finally {
      if (app) {
        try { await app.evaluate(() => {
          const state = globalThis as typeof globalThis & { __i6RestoreReader?: () => void; __i6RestoreClipboard?: () => void };
          try { state.__i6RestoreReader?.(); } finally { state.__i6RestoreClipboard?.(); }
        }); restored = true; }
        finally { await app.close(); }
      }
      server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ electronClosed: true, serverClosed: true, profileRemoved: true, clipboardRestored: restored }));
    }
  }, 180_000);
});
