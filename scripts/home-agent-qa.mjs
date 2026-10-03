import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

// Run after the root Vite test build. All state, files and model traffic are isolated.
const artifacts = path.resolve('test-results/home-agent');
const runRoot = path.join(artifacts, `run-${Date.now()}`);
await mkdir(runRoot, { recursive: true });
const locales = Object.fromEntries(await Promise.all(['zh', 'en', 'ja', 'zh-Hant'].map(async language => [language, JSON.parse(await readFile(`src/locales/${language}/home.json`, 'utf8'))])));
const now = Date.now();
const emptyStats = { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCost: 0, stepCount: 0, lastPromptTokens: 0, interactions: [] };
const call = (toolCallId, toolName) => ({ toolCallId, toolName, args: { query: 'Episode-12-幕后制作手记-and-a-long-production-filename.srt' } });
const fixtureSession = {
  id: 'home-agent-qa', status: 'idle', createdAt: now, updatedAt: now,
  messages: [
    { id: 'user-1', role: 'user', content: '请整理这批字幕，确认翻译资料，再准备翻译；保留失败项和未完成步骤，方便我继续处理。', timestamp: now },
    { id: 'assistant-1', role: 'assistant', content: '已检查字幕和资料。下面是各项操作的实际状态。', timestamp: now + 1, toolCalls: [call('success-call', 'list_studio_documents'), call('failed-call', 'search_translation_knowledge'), call('missing-call', 'get_studio_tasks')] },
    { id: 'tool-1', role: 'tool', content: '{"total":2}', timestamp: now + 2, toolResult: { callId: 'success-call', toolName: 'list_studio_documents', success: true, data: { total: 2, items: [{ name: 'Episode-12-幕后制作手记-and-a-long-production-filename.srt' }, { name: '片尾.srt' }] } } },
    { id: 'tool-2', role: 'tool', content: '{}', timestamp: now + 3, toolResult: { callId: 'failed-call', toolName: 'search_translation_knowledge', success: false, error: '资料读取暂时失败，请检查资料集后重试。The-recovery-diagnostic-has-a-long-unbroken-identifier-for-layout-validation-012345678901234567890123456789.', data: {} } },
  ],
  plan: { id: 'plan-qa', goal: '检查字幕与翻译资料，准备可追踪的翻译任务，保留原始文件和必要的失败诊断。', updatedAt: now, steps: [
    { id: 'inspect', title: '检查字幕文件及格式', status: 'completed', dependsOn: [] },
    { id: 'knowledge', title: '核对角色名称、专有名词与翻译资料中的长标题要求', status: 'blocked', dependsOn: ['inspect'], detail: '资料集需要进一步确认。现有文档已经保留，可以在翻译资料页检查后继续。' },
    { id: 'prepare', title: '准备翻译并确认本次文档范围', status: 'pending', dependsOn: ['knowledge'] },
    { id: 'verify', title: '查看真实任务结果', status: 'pending', dependsOn: ['prepare'] },
  ] },
};

let app;
let server;
let responseQueue = [];
const requests = [];
const errors = [];
const checks = [];
const screenshots = [];
function completion(events) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 35, output_tokens: 12, total_tokens: 47 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
function toolEvent(name, args) {
  const id = `qa-${name}-${Date.now()}`;
  return [{ type: 'response.output_item.added', output_index: 0, item: { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } }];
}
try {
  server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const body = JSON.parse(text || '{}'); requests.push({ url: request.url, body });
    if (request.url?.endsWith('/responses')) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(completion(responseQueue.shift() ?? [{ type: 'response.output_text.delta', delta: '准备已完成，请检查本次操作摘要。' }]));
      return;
    }
    if (request.url?.endsWith('/chat/completions')) {
      const payload = JSON.parse(body.messages[1].content);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: '这是用于隔离验收的译文。' })) }) } }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profile = { id: 'qa-agent', name: 'Local QA', provider: 'Other', apiKey: 'synthetic-qa-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'qa-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
  const modelState = { profiles: [profile, { ...profile, id: 'qa-task', apiFormat: 'chat_completions' }], assignment: { agent: 'qa-agent', taskExecution: 'qa-task' }, audioProfiles: [], audioAssignment: {} };
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(runRoot, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const nativeWindow = await app.browserWindow(page);
  async function ready() {
    await page.getByTestId('home-agent').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'), null, { timeout: 20000 });
    await page.waitForTimeout(500);
  }
  async function capture(name) {
    const target = path.join(artifacts, `${name}.png`);
    await page.screenshot({ path: target, animations: 'disabled' });
    screenshots.push(target);
  }
  async function composerSettled() {
    let previous;
    let stableSamples = 0;
    await expect.poll(async () => {
      const metrics = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-testid="agent-composer-toolbar"]')?.getBoundingClientRect();
      const input = document.querySelector('[data-testid="agent-input"]')?.getBoundingClientRect();
      const mode = document.querySelector('[data-testid="home-agent"] [role="combobox"]')?.getBoundingClientRect();
      const send = document.querySelector('[data-testid="agent-send"]')?.getBoundingClientRect();
      if (!toolbar || !input || !mode || !send || input.top - toolbar.bottom < 0 || input.top - toolbar.bottom > 40) return null;
      const center = rect => rect.top + rect.height / 2;
      if (Math.abs(center(mode) - center(input)) > 4 || Math.abs(center(send) - center(input)) > 4) return null;
      return [toolbar.top, toolbar.bottom, input.top, input.height, mode.top, send.top];
      });
      const stable = metrics && previous && metrics.every((value, index) => Math.abs(value - previous[index]) < 0.25);
      stableSamples = stable ? stableSamples + 1 : 0;
      previous = metrics;
      return stableSamples >= 4;
    }, { timeout: 10000, intervals: [100], message: 'Composer toolbar, mode selector and send button settle beside the input after the empty-state transition' }).toBe(true);
  }
  async function configure(language, theme, session, model = true) {
    await page.evaluate(({ language, theme, session, modelState, emptyStats }) => {
      localStorage.setItem('lang', language);
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
      localStorage.setItem('fusionkit-model', JSON.stringify({ state: modelState, version: 5 }));
      localStorage.setItem('fusionkit-agent', JSON.stringify({ state: { executionMode: 'ask_before_execute', ...(session ? { session, tokenStats: emptyStats, sessionLog: [] } : {}) }, version: 0 }));
      location.hash = '/';
    }, { language, theme, session, modelState: model ? modelState : { profiles: [], assignment: { agent: null, taskExecution: null }, audioProfiles: [], audioAssignment: {} }, emptyStats });
    await page.reload(); await ready();
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*\bdark\b).*$/);
  }

  await nativeWindow.evaluate(win => win.setSize(1280, 860));
  await configure('zh', 'light', null, false);
  await page.getByTestId('agent-input').fill('测试未配置时的发送状态');
  await expect(page.getByTestId('agent-send')).toBeDisabled();
  await capture('empty-no-model-light'); checks.push('No-model send disabled');

  for (const [language, theme, width, height] of [['zh', 'light', 1280, 860], ['en', 'dark', 786, 660], ['ja', 'light', 786, 660], ['zh-Hant', 'dark', 1280, 860]]) {
    await nativeWindow.evaluate((win, size) => win.setSize(...size), [width, height]);
    await configure(language, theme, fixtureSession);
    await expect(page.locator('[data-tool-call-id="success-call"]')).toHaveAttribute('data-tool-call-status', 'completed');
    await expect(page.locator('[data-tool-call-id="failed-call"]')).toHaveAttribute('data-tool-call-status', 'failed');
    await expect(page.locator('[data-tool-call-id="missing-call"]')).toHaveAttribute('data-tool-call-status', 'incomplete');
    await expect(page.locator('[data-tool-call-id="success-call"]').getByRole('button')).toContainText(locales[language].tool_name_studio_documents);
    await page.getByTestId('agent-plan').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    await capture(`plan-${language}-${width}`);
    const plan = page.getByTestId('agent-plan');
    await plan.getByRole('button').click();
    await expect(plan.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await plan.getByRole('button').click();
    await expect(plan.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('[data-tool-call-id="failed-call"]').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await capture(`receipts-${language}-${width}`);
    await page.getByTestId('agent-capabilities-trigger').click();
    await expect(page.getByTestId('agent-capabilities-list').locator('h3')).toHaveCount(6);
    await capture(`capabilities-${language}-${width}`);
    const metrics = await page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-plan"], [data-testid="agent-capabilities-list"], [data-testid="agent-tool-result"]')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ id: element.getAttribute('data-testid'), width: element.clientWidth, overflow: element.scrollWidth - element.clientWidth })));
    if (metrics.some(item => item.overflow > 1)) throw new Error(`Horizontal overflow: ${JSON.stringify(metrics)}`);
    const untranslated = await page.locator('body').innerText();
    if (/home:[a-z_]+/.test(untranslated)) throw new Error('Untranslated HomeAgent key');
    await page.keyboard.press('Escape');
    checks.push({ language, theme, width, height, metrics });
  }

  // A real import and prepared translation exercise the new runtime/tool/UI boundary.
  await nativeWindow.evaluate(win => win.setSize(1280, 860));
  await configure('zh', 'light', null);
  const subtitle = path.join(runRoot, '真实导入-Long-production-title-Episode-01.srt');
  await writeFile(subtitle, '1\n00:00:01,000 --> 00:00:03,000\nHello from the isolated test.\n', 'utf8');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, subtitle);
  const documents = await page.evaluate(async () => {
    const imported = await window.subtitleStudio.importSubtitles({ encoding: 'utf-8' });
    if (!imported.ok || !imported.value) throw new Error('Fixture import failed');
    const listed = await window.subtitleStudio.listDocuments({ offset: 0 });
    if (!listed.ok) throw new Error(listed.error);
    return listed.value.documents.map(document => ({ documentId: document.id, revision: document.revision }));
  });
  async function prepare() {
    responseQueue = [toolEvent('update_agent_plan', { goal: '准备并确认字幕翻译', steps: [
      { id: 'review', title: '检查真实字幕文档', status: 'completed', dependsOn: [] },
      { id: 'queue', title: '准备翻译，等待确认后加入队列', status: 'in_progress', dependsOn: ['review'] },
    ] }), toolEvent('prepare_studio_translation', { documents, targetLanguage: 'zh' })];
    await page.getByTestId('agent-input').fill('请准备翻译已导入的字幕，等待我确认后执行。');
    await page.getByTestId('agent-send').click();
    await expect(page.locator('[data-action-status="ready"]')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('agent-input')).toBeEnabled({ timeout: 30000 });
    await composerSettled();
  }
  await prepare();
  await capture('prepared-translation-light');
  await page.locator('[data-action-status="ready"]').getByRole('button', { name: locales.zh.action_dismiss, exact: true }).click();
  await expect(page.locator('[data-action-status="dismissed"]')).toBeVisible();
  let taskCount = await page.evaluate(async () => { const result = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 50 }); return result.ok ? result.value.total : -1; });
  expect(taskCount).toBe(0); checks.push('Prepared cancellation starts no task');
  await prepare();
  await page.locator('[data-action-status="ready"]').getByRole('button', { name: locales.zh.action_confirm, exact: true }).click();
  await expect(page.locator('[data-action-status="completed"]')).toContainText(locales.zh.result_submitted, { timeout: 30000 });
  await expect.poll(async () => page.evaluate(async () => { const result = await window.subtitleStudio.listTranslationTasks({ offset: 0, pageSize: 50 }); return result.ok ? result.value.counts.completed : -1; }), { timeout: 30000 }).toBe(1);
  await composerSettled();
  await capture('submitted-translation-light'); checks.push('Confirmation enqueues one real fixture task; synthetic local response completes it');
  expect(errors).toEqual([]);
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ runRoot, checks, screenshots, pageErrors: errors, requestCount: requests.length, evidenceBoundary: 'Real isolated Electron and native service import/queue; model responses are synthetic loopback SSE/JSON, not real provider quality.' }, null, 2));
  console.log(JSON.stringify({ success: true, artifacts, screenshots: screenshots.length, checks: checks.length, requests: requests.length }));
} catch (error) {
  await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ message: String(error), stack: error?.stack, errors, checks, screenshots }, null, 2));
  if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(artifacts, 'failure.png') }); } catch {} }
  throw error;
} finally {
  await app?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
}
