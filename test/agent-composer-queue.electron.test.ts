import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from '@playwright/test';
import { createTestRun } from './support/testRun';

/** Responses API stream with the events the agent adapter reads. */
function stream(text: string) {
  return [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

describe.runIf(process.env.FUSIONKIT_AGENT_QUEUE_E2E === '1')('home composer while the agent replies, and workflow templates', () => {
  it('keeps the composer usable during a reply, queues messages, and fills a template in', async () => {
    const artifacts = path.resolve('test-results/agent-composer-queue'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const sent: string[] = [];
    const held: (() => void)[] = [];
    let hold = true;
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const json = JSON.parse(body);
        response.setHeader('Content-Type', 'text/event-stream');
        if (String(json.instructions ?? '').startsWith('You name conversations.')) { response.end(stream('会话标题')); return; }
        const last = [...json.input].reverse().find((item: { role?: string }) => item.role === 'user');
        sent.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
        if (hold) held.push(() => response.end(stream('好的。'))); else response.end(stream('好的。'));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page);
      await win.evaluate(window => { window.setContentSize(1280, 820); window.webContents.setBackgroundThrottling(false); });
      await page.evaluate(port => {
        const profile = { id: 'queue-agent', name: 'Queue agent', provider: 'Other', apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile], assignment: { agent: 'queue-agent', taskExecution: 'queue-agent' }, audioProfiles: [], audioAssignment: {} } }));
        localStorage.setItem('fusionkit-onboarding', JSON.stringify({ state: { status: 'dismissed' }, version: 0 }));
        location.hash = '/';
      }, port);
      await page.reload(); await page.getByTestId('home-agent').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };

      // The empty home page offers workflows; one is filled in and put into the composer.
      await uiExpect(page.getByTestId('agent-template-card')).toHaveCount(6);
      await page.locator('[data-testid=agent-template-card][data-template=bilingual_names]').click();
      const dialog = page.getByTestId('agent-template-dialog');
      await uiExpect(dialog).toBeVisible();
      await uiExpect(page.getByTestId('agent-template-preview')).toContainText('〈文件夹路径〉');
      await page.getByTestId('agent-template-fill').click();
      await uiExpect(page.getByRole('alert')).toHaveText('请先填写文件夹路径');
      await uiExpect(page.getByTestId('agent-template-path')).toBeFocused();
      await page.getByTestId('agent-template-path').fill('D:\\字幕\\周末直播');
      await uiExpect(page.getByTestId('agent-template-preview')).toContainText('把 `D:\\字幕\\周末直播` 里（包括所有子文件夹）的文件名翻译成简体中文，命名格式：简体中文译名在前、原名在后，中间用 “ - ” 分隔');
      await page.locator('[data-testid=agent-template-target] [data-value=external]').click();
      await uiExpect(page.getByTestId('agent-template-preview')).toContainText('rename_paths');
      await uiExpect(page.getByTestId('agent-template-send')).toHaveCount(0);
      await shot('01-template-external');
      await page.locator('[data-testid=agent-template-target] [data-value=fusionkit]').click();
      await page.getByTestId('agent-template-fill').click();
      await uiExpect(dialog).toHaveCount(0);
      const input = page.getByTestId('agent-input');
      await uiExpect(input).toHaveValue(/D:\\字幕\\周末直播/);
      await uiExpect(input).toBeFocused();
      // The folder is remembered for the next time.
      await page.locator('[data-testid=agent-template-card][data-template=bilingual_names]').click();
      await uiExpect(page.getByTestId('agent-template-path')).toHaveValue('D:\\字幕\\周末直播');
      await page.keyboard.press('Escape');

      // While a reply runs, the composer stays enabled and a message waits in the queue.
      await input.fill('第一条');
      await input.press('Enter');
      await page.getByTestId('agent-thinking').waitFor();
      await uiExpect(input).toBeEnabled();
      await uiExpect(page.getByTestId('agent-send')).toHaveAttribute('data-mode', 'stop');
      await input.fill('第二条');
      await uiExpect(page.getByTestId('agent-send')).toHaveAttribute('data-mode', 'queue');
      await uiExpect(page.getByTestId('agent-send-stop')).toBeVisible();
      await input.press('Enter');
      await input.fill('第三条');
      await input.press('Enter');
      const queued = page.getByTestId('agent-queued-message');
      await uiExpect(queued).toHaveText(['1第二条', '2第三条']);
      await shot('02-queue');
      // Taken back to edit, it leaves the queue for the composer.
      await queued.nth(1).hover();
      await queued.nth(1).getByTestId('agent-queued-edit').click();
      await uiExpect(input).toHaveValue('第三条');
      await uiExpect(queued).toHaveCount(1);
      await input.press('Enter');

      // Stopping the reply pauses the queue; going on sends the rest in order.
      await page.getByTestId('agent-send').click();
      await uiExpect(page.getByTestId('agent-message-queue')).toHaveAttribute('data-paused', 'true');
      expect(sent).toEqual(['第一条']);
      await shot('03-paused');
      hold = false; held.splice(0).forEach(release => release());
      await page.getByTestId('agent-queue-resume').click();
      await expect.poll(() => sent.slice(-2)).toEqual(['第二条', '第三条']);
      await uiExpect(page.getByTestId('agent-message-queue')).toHaveCount(0);
      await uiExpect(page.locator('[data-message-role=user]')).toHaveText(['第一条', '第二条', '第三条']);

      // Ctrl+Enter during a reply stops it and sends the message at once.
      hold = true;
      await input.fill('长任务');
      await input.press('Enter');
      await expect.poll(() => held.length).toBe(1);
      await input.fill('改主意了');
      await input.press('Control+Enter');
      await expect.poll(() => sent.at(-1)).toBe('改主意了');
      hold = false; held.splice(0).forEach(release => release());
      await uiExpect(page.getByTestId('agent-message-queue')).toHaveCount(0);
      await shot('04-sent-now');
      expect(errors).toEqual([]);
    } finally {
      held.splice(0).forEach(release => release());
      await app?.close(); server?.close();
    }
  }, 240_000);
});
