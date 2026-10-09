import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';

type ResponsesBody = { instructions: string; tools: { name: string }[]; input: { type?: string; name?: string; output?: string }[] };
type Sample = { t: number; left: number; top: number; width: number; height: number; panelOpacity: number; homeOpacity: number | null };

function stream(events: Record<string, unknown>[]) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const text = (value: string) => [{ type: 'response.output_text.delta', delta: value }];
function call(name: string, args: unknown) {
  const id = `handoff-${name}-${Math.random().toString(36).slice(2)}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}

/** Records the dock frame's rectangle and opacities every animation frame from when it appears. */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const samples: unknown[] = [];
    (window as unknown as { __dockSamples: unknown[] }).__dockSamples = samples;
    let start = 0;
    /** Effective opacity: the product over the element and its ancestors. */
    const opacity = (element: Element) => { let value = 1; for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity); return Math.round(value * 100) / 100; };
    const tick = (now: number) => {
      // A previous, closed surface may still be finishing its exit: follow the open one.
      const panel = document.querySelector('[data-testid=agent-dock-panel][data-open]') ?? document.querySelector('[data-testid=agent-dock-panel]');
      const frame = panel?.closest('[data-testid=agent-dock-frame]');
      const home = document.querySelector('[data-testid=home-agent]');
      if (frame && panel) {
        if (!start) start = now;
        const rect = frame.getBoundingClientRect();
        samples.push({ t: Math.round(now - start), left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          panelOpacity: Number(getComputedStyle(panel).opacity), homeOpacity: home ? opacity(home) : null });
      } else if (start) samples.push({ t: Math.round(now - start), gone: true });
      if (samples.length < 240) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const takeSamples = (page: Page) => page.evaluate(() => (window as unknown as { __dockSamples: Sample[] }).__dockSamples);

describe.runIf(process.env.FUSIONKIT_AGENT_DOCK_E2E === '1')('home and panel handoff', () => {
  it('hands the conversation between home and the panel, follows the translator page settings and opens pages', async () => {
    const artifacts = path.resolve('test-results/agent-handoff'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const input = path.join(root, 'episode.srt');
    await writeFile(input, '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n');
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const requests: ResponsesBody[] = [];
    const queue: Record<string, unknown>[][] = [];
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        requests.push(JSON.parse(body));
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(stream(queue.shift() ?? text('好的。')));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page);
      await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        const profile = { id: 'handoff-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile], assignment: { agent: 'handoff-agent', taskExecution: 'handoff-agent' }, audioProfiles: [], audioAssignment: {} } }));
        localStorage.setItem('subtitle-translator-tour-done', '1');
        location.hash = '/';
      }, port);
      await page.reload(); await page.getByTestId('home-agent').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const launcher = page.getByTestId('agent-dock-launcher');
      await uiExpect(launcher).toHaveCount(0);

      // 1. The agent opens the translator page from home: the conversation flies into the panel.
      queue.push(call('open_app_page', { page: 'subtitle_translator' }));
      queue.push(text('已打开字幕翻译页。'));
      await startSampling(page);
      await page.getByTestId('agent-input').fill('打开字幕翻译页');
      await page.getByTestId('agent-input').press('Enter');
      await page.waitForURL(/subtitle\/translator/);
      const panel = page.getByTestId('agent-dock-panel');
      await uiExpect(panel).toHaveAttribute('data-open', 'true');
      await uiExpect(panel.getByText('已打开字幕翻译页。')).toBeVisible();
      await page.waitForTimeout(700);
      const arrival = (await takeSamples(page)).filter(sample => 'left' in sample);
      await writeFile(path.join(artifacts, 'arrival-samples.json'), JSON.stringify(arrival, null, 2));
      // Starts on the home column (centered, 672 wide) and lands on the panel's place, moving monotonically.
      expect(arrival[0].left).toBeGreaterThan(250);
      expect(Math.abs(arrival[0].width - 672)).toBeLessThan(40);
      const landed = arrival.at(-1)!;
      expect(landed).toMatchObject({ left: 11, width: 400, height: 620, panelOpacity: 1 });
      for (let index = 1; index < arrival.length; index++) {
        expect(arrival[index].left).toBeLessThanOrEqual(arrival[index - 1].left + 0.5);
        expect(arrival[index].width).toBeLessThanOrEqual(arrival[index - 1].width + 0.5);
      }
      expect(arrival.length).toBeGreaterThan(10);
      await uiExpect(page.getByTestId('agent-dock-input')).toBeFocused();
      const opened = JSON.parse(requests[1].input.find(item => item.type === 'function_call_output')!.output!);
      expect(opened).toMatchObject({ success: true, data: { route: '/tools/subtitle/translator', title: '字幕AI翻译', snapshot: { settings: { targetLang: 'ZH' } } } });
      await page.screenshot({ path: path.join(artifacts, '01-arrived-translator.png') });

      // 2. On the translator page: the page context, a settings change and a task that follows the page's settings.
      queue.push(call('subtitle_translator_update_settings', { targetLang: 'EN', translationOutputMode: 'target_only', sliceType: 'CUSTOM', customSliceLength: 1200 }));
      queue.push(text('已把目标语言改为英文、仅输出译文。'));
      await page.getByTestId('agent-dock-input').fill('把目标语言改成英文，只要译文');
      await page.getByTestId('agent-dock-input').press('Enter');
      await uiExpect(panel.getByText('已把目标语言改为英文、仅输出译文。')).toBeVisible();
      expect(requests[2].instructions).toContain('"route":"/tools/subtitle/translator"');
      expect(requests[2].tools.map(item => item.name)).toContain('subtitle_translator_update_settings');
      // The open page reflects what the agent changed without leaving and re-entering it.
      await uiExpect(page.locator('input[type="number"][max="2000"]')).toHaveValue('1200');
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      queue.push(call('queue_subtitle_translate', {}));
      queue.push(text('已按字幕翻译页的设置加入 1 个任务。'));
      await page.getByTestId('agent-dock-input').fill('翻译一个字幕文件');
      await page.getByTestId('agent-dock-input').press('Enter');
      await uiExpect(panel.getByText('已按字幕翻译页的设置加入 1 个任务。')).toBeVisible();
      // Requests replay the whole history; the latest tool output is the queue receipt.
      const queued = JSON.parse(requests.at(-1)!.input.filter(item => item.type === 'function_call_output').at(-1)!.output!);
      expect(queued).toMatchObject({ success: true, data: { queuedCount: 1, appliedSettings: { targetLang: { value: 'EN', source: 'tool_page' }, translationOutputMode: { value: 'target_only', source: 'tool_page' }, sourceLang: { source: 'tool_page' } } } });
      await uiExpect(page.getByText('episode.srt').first()).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '02-translator-settings-and-task.png') });
      // The panel's list uses an overlay scrollbar that appears while hovered, without a track.
      const list = page.getByTestId('agent-dock-messages');
      await list.hover();
      await uiExpect(page.locator('.agent-dock-scroll [data-slot="scroll-area-scrollbar"]')).toBeVisible();
      expect(await list.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(artifacts, '02b-panel-scrollbar.png') });
      // The input's own scrollbar follows the same look once a long draft overflows it.
      const draft = page.getByTestId('agent-dock-input');
      await draft.fill(Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行草稿`).join('\n'));
      await draft.hover();
      expect(await draft.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, '02c-input-scrollbar.png') });
      await draft.fill('');

      // 3. Back to home: the panel flies to the home column and the home conversation takes over.
      await startSampling(page);
      const shots: string[] = [];
      await page.getByTestId('agent-dock-open-home').click();
      for (const name of ['03a', '03b', '03c']) { const file = path.join(artifacts, `${name}-return.png`); await page.screenshot({ path: file }); shots.push(file); }
      await page.getByTestId('home-agent').waitFor();
      await page.waitForTimeout(700);
      const returning = (await takeSamples(page)).filter(sample => 'left' in sample);
      await writeFile(path.join(artifacts, 'return-samples.json'), JSON.stringify(returning, null, 2));
      expect(returning[0]).toMatchObject({ left: 11, width: 400 });
      const last = returning.at(-1)!;
      expect(last.left).toBeGreaterThan(250);
      expect(Math.abs(last.width - 672)).toBeLessThan(40);
      await uiExpect(launcher).toHaveCount(0);
      await uiExpect(page.getByTestId('home-agent').getByText('已按字幕翻译页的设置加入 1 个任务。')).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '04-home-again.png') });

      // 4. User navigation from home also hands over; screenshots during the flight for review (narrow, dark).
      await win.evaluate(window => window.setSize(786, 660));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.waitForTimeout(300);
      await startSampling(page);
      await page.getByRole('button', { name: '工具', exact: true }).click();
      for (const name of ['05a', '05b', '05c', '05d']) await page.screenshot({ path: path.join(artifacts, `${name}-leave-786-dark.png`) });
      await uiExpect(panel).toHaveAttribute('data-open', 'true');
      await page.waitForTimeout(600);
      const narrow = await page.getByTestId('agent-dock-frame').boundingBox();
      expect(narrow).toMatchObject({ x: 11, width: 400 });
      const leavingNarrow = (await takeSamples(page)).filter(sample => 'left' in sample);
      await writeFile(path.join(artifacts, 'arrival-786-dark-samples.json'), JSON.stringify(leavingNarrow, null, 2));
      expect(leavingNarrow[0].left).toBeGreaterThan(40);
      expect(leavingNarrow.at(-1)).toMatchObject({ left: 11, width: 400 });
      await page.screenshot({ path: path.join(artifacts, '06-landed-786-dark.png') });

      // 5. The return flight at the narrow size, then an empty conversation does not open the panel when leaving home.
      await startSampling(page);
      await page.getByTestId('agent-dock-open-home').click();
      for (const name of ['07a', '07b', '07c']) await page.screenshot({ path: path.join(artifacts, `${name}-return-786-dark.png`) });
      await page.getByTestId('home-agent').waitFor();
      await page.waitForTimeout(700);
      const returningNarrow = (await takeSamples(page)).filter(sample => 'left' in sample);
      await writeFile(path.join(artifacts, 'return-786-dark-samples.json'), JSON.stringify(returningNarrow, null, 2));
      expect(returningNarrow[0]).toMatchObject({ left: 11, width: 400 });
      expect(returningNarrow.at(-1)!.left).toBeGreaterThan(40);
      await page.screenshot({ path: path.join(artifacts, '08-home-786-dark.png') });
      const reset = page.getByRole('button', { name: '新对话' });
      await reset.click(); await page.getByRole('button', { name: '确认新建?' }).click();
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await page.waitForURL(/#\/tools$/);
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(panel).not.toHaveAttribute('data-open', 'true');

      // 6. Reduced motion: the handover fades without a flight.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: '主页', exact: true }).click();
      await page.getByTestId('home-agent').waitFor();
      queue.push(text('你好。'));
      await page.getByTestId('agent-input').fill('你好');
      await page.getByTestId('agent-input').press('Enter');
      await uiExpect(page.getByTestId('home-agent').getByText('你好。')).toBeVisible();
      await startSampling(page);
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await uiExpect(panel).toHaveCount(1);
      await uiExpect(panel).toHaveAttribute('data-open', 'true');
      await page.waitForTimeout(500);
      const reduced = (await takeSamples(page)).filter(sample => 'left' in sample);
      expect(reduced[0]).toMatchObject({ left: 11, width: 400 });
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180000);
});
