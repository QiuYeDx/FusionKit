import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import type { DocumentPage } from '../../src/subtitle-studio/ipc-contract';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio translation recovery workspace', () => {
  let app: ElectronApplication | undefined;
  let server: Server | undefined;
  let root: string;
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('recovers committed batches after restart, requires the original model, and discards cancelled responses', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-recovery-ui-'));
    const userData = path.join(root, 'profile');
    const artifacts = path.resolve('test-results/subtitle-studio-recovery');
    await mkdir(artifacts, { recursive: true });
    type Request = { model: string; messages: { content: string }[]; thinking?: { type: string } };
    const requests: { body: Request; authorization: string | undefined }[] = [];
    const pending: { response: ServerResponse; body: Request }[] = [];
    let mode: 'hold-second' | 'success' | 'provider-wait' = 'hold-second';
    let wave = 0;
    const respond = (response: ServerResponse, body: Request) => {
      if (response.destroyed) return;
      const payload = JSON.parse(body.messages[1].content);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ items: payload.items.map((item: { id: string; text: string }) => ({ id: item.id, text: `译文：${item.text}` })) }),
      } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
    };
    server = createServer(async (request, response) => {
      let text = ''; for await (const chunk of request) text += chunk.toString();
      const body = JSON.parse(text) as Request;
      requests.push({ body, authorization: request.headers.authorization });
      wave++;
      if (mode === 'provider-wait') {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '31' });
        response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Synthetic provider wait' } }));
      } else if (mode === 'hold-second' && wave === 2) pending.push({ response, body });
      else respond(response, body);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const originalProfile = {
      id: 'studio-recovery-original', name: 'DeepSeek recovery fixture', provider: 'DeepSeek',
      apiKey: 'synthetic-original-key', baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash',
      apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
    };
    const fallbackProfile = { ...originalProfile, id: 'studio-recovery-other', name: 'Unrelated assignment', modelKey: 'different-model' };
    const errors: string[] = [];
    const openStudio = async (page: Page) => {
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    };
    const launch = async () => {
      app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await openStudio(page);
      return page;
    };
    const configureProfiles = async (page: Page, profiles: typeof originalProfile[], assigned: string, theme = 'light') => {
      await page.evaluate(({ profiles, assigned, theme }) => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles,
          assignment: { taskExecution: assigned, agent: null }, audioProfiles: [], audioAssignment: {},
        } }));
      }, { profiles, assigned, theme });
    };
    const snapshot = async (page: Page, name: string): Promise<DocumentPage> => page.evaluate(async name => {
      const list = await window.subtitleStudio.listDocuments({ offset: 0 });
      if (!list.ok) throw new Error(list.error);
      const document = list.value.documents.find(item => item.origin.displayName === name);
      if (!document) throw new Error('Missing synthetic document');
      const detail = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
      if (!detail.ok) throw new Error(detail.error);
      return detail.value;
    }, name);
    const openFile = async (page: Page, name: string, cueCount: number) => {
      const input = path.join(root, name);
      const prefix = name.replace('.lrc', '');
      await writeFile(input, Array.from({ length: cueCount }, (_, i) => `[00:${String(i).padStart(2, '0')}.00]${prefix} scene ${i + 1}.`).join('\n'));
      await app!.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(cueCount);
    };
    const start = async (page: Page) => {
      await page.getByRole('button', { name: '翻译', exact: true }).click();
      await page.getByTestId('studio-translation-advanced').click();
      await page.getByRole('spinbutton', { name: '每批字幕上限', exact: true }).fill('2');
      await page.getByRole('button', { name: '计算用量', exact: true }).click();
      await uiExpect(page.locator('.studio-translation-plan')).toBeVisible();
      await page.getByRole('button', { name: '开始翻译', exact: true }).click();
    };
    const reload = async (page: Page) => { await page.reload(); await openStudio(page); };
    const recoveryDialog = (page: Page) => page.getByRole('dialog', { name: '继续翻译', exact: true });

    let page = await launch();
    await configureProfiles(page, [originalProfile, fallbackProfile], originalProfile.id);
    await reload(page);
    let window = await app!.browserWindow(page); await window.evaluate(win => win.setSize(1280, 860));
    const restartName = 'Restart-proof.lrc';
    await openFile(page, restartName, 6);
    await start(page);
    await uiExpect.poll(() => requests.length).toBe(2);
    await uiExpect(page.locator('.studio-target-text').filter({ hasText: '译文：' })).toHaveCount(2);
    const beforeRestart = await snapshot(page, restartName);
    expect(beforeRestart.tasks[0].completedBatchIds).toHaveLength(1);
    expect(beforeRestart.tasks[0].translation?.checkpoint).toBeDefined();
    const taskId = beforeRestart.tasks[0].id;
    await page.screenshot({ path: path.join(artifacts, 'running-before-restart.png'), animations: 'disabled' });
    const crashedProcess = app!.process();
    const crashed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic Electron crash did not terminate')), 10000);
      crashedProcess.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (process.platform === 'win32') {
      // Killing only Electron's main process leaves Chromium holding the profile
      // singleton on Windows. Crash the entire owned test process tree.
      expect(crashedProcess.pid).toBeGreaterThan(0);
      execFileSync('taskkill.exe', ['/PID', String(crashedProcess.pid), '/T', '/F'], { windowsHide: true });
    } else {
      expect(crashedProcess.kill('SIGKILL')).toBe(true);
    }
    await crashed;
    app = undefined;
    mode = 'success';
    page = await launch();
    window = await app!.browserWindow(page); await window.evaluate(win => win.setSize(1280, 860));
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'interrupted');
    expect(requests).toHaveLength(2);
    await configureProfiles(page, [fallbackProfile], fallbackProfile.id);
    await reload(page);
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await uiExpect(recoveryDialog(page)).toContainText('原模型配置缺失、已变更或 API 密钥不可用');
    await uiExpect(recoveryDialog(page).getByRole('button', { name: '继续翻译', exact: true })).toBeDisabled();
    await uiExpect(recoveryDialog(page).getByRole('button', { name: '模型设置', exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    await page.screenshot({ path: path.join(artifacts, 'missing-original-model.png'), animations: 'disabled' });
    await recoveryDialog(page).getByRole('button', { name: '取消', exact: true }).click();
    await configureProfiles(page, [{ ...originalProfile, modelKey: 'changed-model' }, fallbackProfile], fallbackProfile.id);
    await reload(page);
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await uiExpect(recoveryDialog(page).getByRole('button', { name: '继续翻译', exact: true })).toBeDisabled();
    await uiExpect(recoveryDialog(page)).toContainText('deepseek-v4-flash');
    await uiExpect(recoveryDialog(page).getByRole('combobox')).toHaveCount(0);
    expect(requests).toHaveLength(2);
    await recoveryDialog(page).getByRole('button', { name: '取消', exact: true }).click();
    await configureProfiles(page, [{ ...originalProfile, apiKey: 'synthetic-rotated-key' }, fallbackProfile], fallbackProfile.id, 'dark');
    await reload(page);
    await window.evaluate(win => win.setSize(786, 540));
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await uiExpect(recoveryDialog(page)).toContainText('可能重复计费');
    await uiExpect(recoveryDialog(page).getByRole('button', { name: '继续翻译', exact: true })).toBeEnabled();
    expect(await recoveryDialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'resume-dark-narrow.png'), animations: 'disabled' });
    await recoveryDialog(page).getByRole('button', { name: '继续翻译', exact: true }).click();
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'completed', { timeout: 15000 });
    await uiExpect(page.locator('.studio-target-text').filter({ hasText: '译文：' })).toHaveCount(6);
    expect(requests).toHaveLength(4);
    expect(requests.slice(2).every(item => item.authorization === 'Bearer synthetic-rotated-key')).toBe(true);
    const resumedTexts = requests.slice(2).flatMap(item => JSON.parse(item.body.messages[1].content).items.map((cue: { text: string }) => cue.text));
    expect(resumedTexts).toEqual(['Restart-proof scene 3.', 'Restart-proof scene 4.', 'Restart-proof scene 5.', 'Restart-proof scene 6.']);
    expect(JSON.parse(requests[2].body.messages[1].content).context.priorModelTranslations).toHaveLength(2);
    const afterResume = await snapshot(page, restartName);
    expect(afterResume.tasks[0].id).toBe(taskId);
    expect(afterResume.tasks[0].completedBatchIds).toHaveLength(3);
    expect(afterResume.tasks[0].translation?.uncertainAttempts).toBeGreaterThan(0);
    expect(afterResume.translationTracks[0].entries[afterResume.cues[0].id]).toEqual(beforeRestart.translationTracks[0].entries[beforeRestart.cues[0].id]);
    await page.screenshot({ path: path.join(artifacts, 'resumed-completed-narrow.png'), animations: 'disabled' });

    await window.evaluate(win => win.setSize(1280, 860));
    await configureProfiles(page, [originalProfile, fallbackProfile], originalProfile.id);
    await reload(page);
    mode = 'hold-second'; wave = 0;
    const cancelName = 'Cancel-proof.lrc';
    await openFile(page, cancelName, 4);
    await start(page);
    await uiExpect.poll(() => requests.length).toBe(6);
    await uiExpect(page.locator('.studio-target-text').filter({ hasText: '译文：' })).toHaveCount(2);
    await page.getByRole('button', { name: '取消翻译', exact: true }).click();
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'cancelled');
    const cancelled = await snapshot(page, cancelName);
    await uiExpect(page.getByRole('button', { name: '继续翻译', exact: true })).toHaveCount(0);
    await uiExpect(page.getByRole('button', { name: '取消翻译', exact: true })).toHaveCount(0);
    await uiExpect(page.locator('.studio-translation-task-controls')).toContainText('已完成的译文已保留');
    for (const waiting of pending.splice(0)) respond(waiting.response, waiting.body);
    await page.waitForTimeout(300);
    expect((await snapshot(page, cancelName)).translationTracks).toEqual(cancelled.translationTracks);
    expect((await snapshot(page, cancelName)).tasks).toEqual(cancelled.tasks);
    expect(requests).toHaveLength(6);
    await page.screenshot({ path: path.join(artifacts, 'cancelled-desktop.png'), animations: 'disabled' });

    mode = 'provider-wait'; wave = 0;
    await openFile(page, 'Provider-wait.lrc', 2);
    await start(page);
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'failed', { timeout: 15000 });
    expect(requests).toHaveLength(7);
    await uiExpect(page.locator('.studio-translation-task-controls')).toContainText('供应商要求等待');
    await page.getByRole('button', { name: '继续翻译', exact: true }).click();
    await uiExpect(recoveryDialog(page)).toContainText('供应商要求等待');
    await uiExpect(recoveryDialog(page).getByRole('button', { name: '继续翻译', exact: true })).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, 'provider-wait.png'), animations: 'disabled' });
    await recoveryDialog(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '取消翻译', exact: true }).click();
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'cancelled');
    expect(requests).toHaveLength(7);

    await app!.close(); app = undefined;
    const repository = new DocumentRepository(path.join(userData, 'subtitle-studio', 'documents'));
    const stored = await repository.readSnapshot(afterResume.summary.id);
    await repository.transact(stored.document.id, stored.document.revision, value => {
      const task = value.tasks.find(item => item.id === taskId)!;
      task.status = 'failed';
      delete task.translation!.checkpoint;
    });
    page = await launch();
    await page.locator('.studio-document').filter({ hasText: restartName }).click();
    await uiExpect(page.locator('.studio-translation-task-controls')).toContainText('此旧任务不支持继续，请重新创建翻译。');
    await uiExpect(page.getByRole('button', { name: '继续翻译', exact: true })).toHaveCount(0);
    await uiExpect(page.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(7);
    expect(errors).toEqual([]);
  }, 180000);
});
