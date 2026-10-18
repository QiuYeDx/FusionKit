import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createTestRun } from './support/testRun';

const artifacts = path.resolve('test-results/onboarding');
const skip = process.platform === 'linux' || process.env.CODEX_SANDBOX === 'seatbelt' || process.env.FUSIONKIT_SKIP_E2E === '1';

type Look = { lang: string; theme: 'light' | 'dark'; size: [number, number] };
async function launch(profile: string, env: Record<string, string | undefined>, look: Look) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(),
    // One-click prepare must never download real models here: the Microsoft runtime is reported
    // missing and its repair declined, so preparing stops before any download.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_ONBOARDING: undefined, FUSIONKIT_TEST_DEEPSEEK_BASE_URL: undefined,
      FUSIONKIT_TEST_VC_RUNTIME: 'missing', FUSIONKIT_TEST_VC_REPAIR: 'cancelled', ...env },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setSize(size[0], size[1]); window.webContents.setBackgroundThrottling(false); }, look.size);
  await page.evaluate(({ lang, theme }) => {
    localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    location.hash = '/';
  }, look);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.getByTestId('home-agent').waitFor();
  return { app, page, errors };
}
async function shot(page: Page, name: string) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); }
const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const storedModel = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit-model') ?? 'null')?.state);
const onboardingStatus = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit-onboarding') ?? 'null')?.state?.status ?? 'never_shown');
/** The guide of the newest answer: the previous one may still be fading out. */
const guideFor = (page: Page, category: string) => page.locator(`[data-testid="connection-test-guide"][data-category="${category}"]`);

describe.skipIf(skip)('welcome wizard', () => {
  it('opens on a fresh profile when a test asks, saves a tested DeepSeek key for both roles and leaves the composer ready', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
    try {
      // A DeepSeek stand-in: a wrong key is refused like DeepSeek refuses it, one key breaks the
      // connection (as a blocked network does), the good key works.
      server = createServer(async (request, response) => {
        let raw = ''; for await (const part of request) raw += part.toString();
        requests.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(raw || '{}') });
        if (request.headers.authorization === 'Bearer sk-wizard-drop-key') { request.socket.destroy(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (request.headers.authorization !== 'Bearer sk-wizard-good-key') {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key: ****-key is invalid', type: 'authentication_error' } }));
          return;
        }
        response.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'deepseek-v4-flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }] }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), { FUSIONKIT_TEST_ONBOARDING: '1', FUSIONKIT_TEST_DEEPSEEK_BASE_URL: baseUrl }, { lang: 'zh', theme: 'light', size: [786, 540] }));

      // While a step changes, the old one is still on screen for a moment: look for the new one.
      const step = (name: string) => page.locator(`[data-testid="welcome-wizard"][data-step="${name}"]`);
      await uiExpect(step('choose')).toBeVisible();
      await uiExpect(page.getByRole('dialog')).toContainText('欢迎使用 FusionKit');
      await uiExpect(page.getByTestId('welcome-choice-ai')).toContainText('推荐');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '01-choose-zh-light-786x540');

      await page.getByTestId('welcome-choice-ai').click();
      await uiExpect(step('deepseek')).toBeVisible();
      // The links lead to DeepSeek's own pages (not clicked: they open the system browser).
      await uiExpect(page.getByTestId('welcome-deepseek-keys')).toHaveAttribute('data-href', 'https://platform.deepseek.com/api_keys');
      await uiExpect(page.getByTestId('welcome-deepseek-top-up')).toHaveAttribute('data-href', 'https://platform.deepseek.com/top_up');
      const key = page.getByTestId('welcome-deepseek-key');
      await uiExpect(key).toHaveAttribute('type', 'password');
      await page.getByRole('button', { name: '显示密钥' }).click();
      await uiExpect(key).toHaveAttribute('type', 'text');
      await page.getByRole('button', { name: '隐藏密钥' }).click();
      await uiExpect(key).toHaveAttribute('type', 'password');

      // More than the key pasted: said right away, and the test says so without sending anything.
      await key.fill('Key：sk-wizard-good-key');
      await uiExpect(page.getByTestId('api-key-characters')).toContainText('多复制了别的文字');
      await page.getByTestId('welcome-deepseek-save').click();
      await uiExpect(page.locator('[data-testid="connection-test-status"][data-reason="key_characters"]')).toContainText('只粘贴密钥本身');
      expect(requests).toHaveLength(0);

      // A wrong key: the cause and the next step, and nothing is saved.
      await key.fill('sk-wizard-wrong-key');
      await uiExpect(page.getByTestId('api-key-characters')).toHaveCount(0);
      await page.getByTestId('welcome-deepseek-save').click();
      const guide = guideFor(page, 'auth');
      await uiExpect(guide).toContainText('密钥（API Key）不对');
      await uiExpect(guide.locator('[data-action="open_deepseek_keys"]')).toBeVisible();
      await uiExpect(guide).not.toContainText('sk-wizard-wrong-key');
      // The service's own words, labelled as such; not our English wrapper.
      await uiExpect(guide).toContainText('服务返回：HTTP 401 · Authentication Fails');
      await uiExpect(guide).not.toContainText('Model request failed');
      expect((await storedModel(page))?.profiles ?? []).toEqual([]);
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '02-deepseek-wrong-key-zh-light-786x540');

      // A broken connection: "open network settings" steps away without counting the wizard as
      // seen, and the notice brings it back with the key still filled in.
      await key.fill('sk-wizard-drop-key');
      await page.getByTestId('welcome-deepseek-save').click();
      const network = guideFor(page, 'network');
      await uiExpect(network.getByTestId('connection-test-guide-detail')).toHaveAttribute('data-source', 'connection');
      await uiExpect(network).toContainText('连接情况：');
      await network.locator('[data-action="open_network_settings"]').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      await uiExpect(page.getByTestId('setting-tab-proxy')).toHaveAttribute('aria-current', 'page');
      expect(await onboardingStatus(page)).toBe('never_shown');
      await shot(page, '02b-left-for-network-zh-light-786x540');
      await page.getByRole('button', { name: '回到新手引导' }).click();
      await uiExpect(step('deepseek')).toBeVisible();
      await uiExpect(key).toHaveValue('sk-wizard-drop-key');

      // The right key is tested with one tiny request, then saved for the Agent and for tasks.
      await key.fill('sk-wizard-good-key');
      await page.getByTestId('welcome-deepseek-save').click();
      await uiExpect(step('local')).toBeVisible();
      expect(requests).toHaveLength(3);
      expect(requests[2]).toMatchObject({ url: '/v1/chat/completions', headers: { authorization: 'Bearer sk-wizard-good-key' }, body: { model: 'deepseek-v4-flash', max_tokens: 16 } });
      let model = await storedModel(page);
      expect(model.profiles).toHaveLength(1);
      expect(model.profiles[0]).toMatchObject({ provider: 'DeepSeek', baseUrl, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', apiKey: 'sk-wizard-good-key' });
      expect(model.assignment).toEqual({ agent: model.profiles[0].id, taskExecution: model.profiles[0].id });
      await uiExpect(page.getByTestId('welcome-local-prepare')).toBeVisible();
      await shot(page, '03-local-zh-light-786x540');

      // Back and "test and save" again with the same key: the saved profile is reused, not copied.
      await page.getByRole('button', { name: '返回' }).click();
      await page.getByTestId('welcome-choice-ai').click();
      await uiExpect(step('deepseek')).toBeVisible();
      await uiExpect(key).toHaveValue('sk-wizard-good-key');
      await page.getByTestId('welcome-deepseek-save').click();
      await uiExpect(step('local')).toBeVisible();
      expect(requests).toHaveLength(4);
      model = await storedModel(page);
      expect(model.profiles).toHaveLength(1);
      expect(model.assignment).toEqual({ agent: model.profiles[0].id, taskExecution: model.profiles[0].id });

      // "Prepare" starts preparing in the background and carries on to the done page. Without the
      // Microsoft runtime it stops before downloading and offers the repair (declined here) first.
      await page.getByTestId('welcome-local-prepare').click();
      await uiExpect(step('done')).toBeVisible();
      const runtime = page.getByTestId('welcome-vc-runtime');
      await uiExpect(runtime).toContainText('需要安装微软运行库');
      await uiExpect(runtime).toContainText('装好后会自动开始下载推荐模型和语音检测。');
      await runtime.getByTestId('welcome-vc-runtime-repair').click();
      await uiExpect(runtime.getByTestId('welcome-vc-runtime-result')).toHaveAttribute('data-outcome', 'cancelled');
      await uiExpect(page.getByTestId('welcome-open-resources')).toHaveText('打开本地资源');
      const examples = page.getByTestId('welcome-example');
      await uiExpect(examples).toHaveCount(3);
      // Each example is a button inside a list item.
      await uiExpect(page.getByRole('dialog').getByRole('listitem').getByRole('button')).toHaveCount(3);
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '04-done-zh-light-786x540');
      // An example fills the composer like a home page suggestion.
      await examples.first().click();
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);
      const input = page.getByTestId('agent-input');
      await uiExpect(input).toHaveValue('请帮我在字幕工作台准备字幕翻译，先检查可用的翻译资料和配置。');
      await uiExpect(page.getByTestId('agent-send')).toBeEnabled();
      await uiExpect(page.getByText('尚未配置 Agent 所用的模型')).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit-onboarding') ?? 'null')?.state)).toEqual({ status: 'completed' });
      await shot(page, '05-home-ready-zh-light-786x540');

      // Finished once, it does not come back by itself.
      await page.reload();
      await page.getByTestId('home-agent').waitFor();
      await page.waitForTimeout(1_000);
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      expect(requests).toHaveLength(4);
      expect(errors).toEqual([]);
    } finally {
      await app?.close().catch(() => undefined);
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180_000);

  it('stays closed on a fresh profile in UI tests, can be reopened, and the profile dialog tests a connection', async () => {
    await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined; let server: Server | undefined;
    let calls = 0;
    try {
      // First answer: DeepSeek's empty account. Then a broken connection. Then it works.
      server = createServer(async (request, response) => {
        for await (const _part of request) { /* drain */ }
        calls += 1;
        if (calls === 2) { request.socket.destroy(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (calls === 1) { response.statusCode = 402; response.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error' } })); return; }
        response.end(JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }] }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      let page: Page; let errors: string[];
      ({ app, page, errors } = await launch(path.join(root, 'profile'), {}, { lang: 'zh', theme: 'dark', size: [1080, 786] }));
      await page.waitForTimeout(1_500);
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      // The missing model notice leads to the model tab.
      await page.getByRole('button', { name: '前往设置' }).click();
      await uiExpect(page.getByTestId('setting-tab-model')).toHaveAttribute('aria-current', 'page');
      await uiExpect(page.getByTestId('model-assignment-agent-role')).toContainText('和你对话');
      await uiExpect(page.getByTestId('model-assignment-task-role')).toContainText('字幕翻译');
      await page.getByTestId('reopen-onboarding').click();
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="choose"]')).toBeVisible();
      await shot(page, '06-reopened-zh-dark-1080x786');
      await page.getByTestId('welcome-skip').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fusionkit-onboarding') ?? 'null')?.state)).toEqual({ status: 'dismissed' });

      // The profile dialog: DeepSeek first and recommended, the key hidden, the advanced settings folded away.
      await page.getByRole('button', { name: '添加配置' }).click();
      const dialog = page.getByRole('dialog');
      await uiExpect(dialog.getByRole('radio', { name: 'DeepSeek（推荐）' })).toHaveAttribute('aria-checked', 'true');
      await uiExpect(page.getByTestId('deepseek-links')).toContainText('获取 Key');
      await uiExpect(page.getByTestId('model-profile-api-key')).toHaveAttribute('type', 'password');
      await uiExpect(dialog.getByRole('button', { name: /高级设置/ })).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(page.getByTestId('model-profile-test')).toBeDisabled();
      // An empty address is named as such, without a request.
      await page.getByTestId('model-profile-api-key').fill('sk-dialog-key');
      await page.getByLabel('接口地址').fill('');
      await page.getByTestId('model-profile-test').click();
      await uiExpect(page.locator('[data-testid="connection-test-status"][data-reason="missing_url"]')).toContainText('还没有填写接口地址');
      expect(calls).toBe(0);
      await page.getByLabel('接口地址').fill(baseUrl);
      await page.getByTestId('model-profile-test').click();
      const guide = guideFor(page, 'balance');
      await uiExpect(guide).toContainText('余额不足');
      await uiExpect(guide.locator('[data-action="open_deepseek_topup"]')).toBeVisible();
      // Already in the model settings: no button that leads back here.
      await uiExpect(guide.locator('[data-action="open_model_settings"]')).toHaveCount(0);
      await uiExpect(guide).toContainText('服务返回：HTTP 402 · Insufficient Balance');
      await shot(page, '07-dialog-balance-zh-dark-1080x786');

      // A broken connection: "open network settings" leaves the form, and "continue" brings it back filled in.
      await page.getByTestId('model-profile-test').click();
      await guideFor(page, 'network').locator('[data-action="open_network_settings"]').click();
      await uiExpect(dialog).toHaveCount(0);
      await uiExpect(page.getByTestId('setting-tab-proxy')).toHaveAttribute('aria-current', 'page');
      await page.getByRole('button', { name: '继续填写' }).click();
      await uiExpect(page.getByTestId('setting-tab-model')).toHaveAttribute('aria-current', 'page');
      await uiExpect(page.getByTestId('model-profile-api-key')).toHaveValue('sk-dialog-key');
      await uiExpect(page.getByLabel('接口地址')).toHaveValue(baseUrl);
      expect((await storedModel(page))?.profiles ?? []).toEqual([]);
      await page.getByTestId('model-profile-test').click();
      // The previous answer fades out while the new one comes in.
      await uiExpect(page.locator('[data-testid="connection-test-status"][data-state="ok"]')).toBeVisible();
      await page.getByTestId('model-profile-save').click();
      await uiExpect(dialog).toHaveCount(0);
      const model = await storedModel(page);
      expect(model.profiles).toHaveLength(1);
      expect(model.assignment).toEqual({ agent: model.profiles[0].id, taskExecution: model.profiles[0].id });
      expect(calls).toBe(3);

      // "Claude Code, Codex or Cursor": no key, but the local step comes first (external agents
      // transcribe through FusionKit too), and the done page leads to the External agents settings.
      await page.getByTestId('reopen-onboarding').click();
      await page.getByTestId('welcome-choice-external').click();
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="local"]')).toBeVisible();
      await uiExpect(page.getByTestId('welcome-local-external-note')).toContainText('Claude Code、Codex 或 Cursor');
      await page.getByTestId('welcome-local-later').click();
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="done"]')).toBeVisible();
      await uiExpect(page.getByTestId('welcome-open-external')).toContainText('连接 Claude Code、Codex 或 Cursor');
      expect(await noHorizontalOverflow(page)).toBe(true);
      await shot(page, '07b-external-done-zh-dark-1080x786');
      await page.getByTestId('welcome-finish').click();
      await uiExpect(page.getByTestId('welcome-wizard')).toHaveCount(0);
      await uiExpect(page.getByTestId('setting-tab-external')).toHaveAttribute('aria-current', 'page');

      // Reopened, "prepare" on the local step leads to the done page, whose first item opens the
      // resource manager of Studio's transcription view (preparing waits there for the runtime).
      await page.getByTestId('setting-tab-model').click();
      await page.getByTestId('reopen-onboarding').click();
      await page.getByTestId('welcome-choice-local').click();
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="local"]')).toBeVisible();
      await page.getByTestId('welcome-local-prepare').click();
      await uiExpect(page.locator('[data-testid="welcome-wizard"][data-step="done"]')).toBeVisible();
      await page.getByTestId('welcome-open-resources').click();
      await uiExpect(page.locator('.studio-transcription-resource-dialog')).toBeVisible();
      await uiExpect(page.getByTestId('studio-resources-prepare')).toHaveAttribute('data-phase', 'runtime_needed');
      await uiExpect(page.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', 'transcription');
      expect(await page.evaluate(() => location.hash)).not.toContain('resources=open');
      expect(errors).toEqual([]);
    } finally {
      await app?.close().catch(() => undefined);
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 120_000);
});
