import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';

type ResponsesBody = { instructions: string; tools: { name: string }[]; input: { type?: string; output?: string }[] };
type RevisionPayload = { request: string; items: { id: string; source: string }[] };

/** Responses API stream with the events the agent adapter reads. */
function stream(events: Record<string, unknown>[]) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const text = (value: string) => [{ type: 'response.output_text.delta', delta: value }];
function call(name: string, args: unknown) {
  const id = `dock-${name}-${Date.now()}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}

describe.runIf(process.env.FUSIONKIT_AGENT_DOCK_E2E === '1')('floating agent panel', () => {
  it('opens on tool pages, knows the page and prepares a Studio revision the user applies', async () => {
    const artifacts = path.resolve('test-results/agent-dock'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const input = path.join(root, '法厄同.srt');
    const lines = Array.from({ length: 250 }, (_, index) => `第 ${index + 1} 句台词。`);
    lines[4] = '法尔童驾着太阳车出发了。'; lines[119] = '人们说法而童太年轻了。'; lines[239] = '法尔童最终坠落了。';
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
    await writeFile(input, lines.map((line, index) => `${index + 1}\n${time(index * 2000)} --> ${time(index * 2000 + 1500)}\n${line}\n`).join('\n'));

    let app: ElectronApplication | undefined; let server: Server | undefined;
    const agentRequests: ResponsesBody[] = [];
    const revisions: RevisionPayload[] = [];
    const queue: Record<string, unknown>[][] = [];
    let hold: (() => void) | undefined;
    let holdNext = false;
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        if (request.url?.endsWith('/responses')) {
          agentRequests.push(JSON.parse(body));
          response.setHeader('Content-Type', 'text/event-stream');
          const payload = stream(queue.shift() ?? text('好的。'));
          if (holdNext) { holdNext = false; hold = () => response.end(payload); } else response.end(payload);
          return;
        }
        const payload = JSON.parse(JSON.parse(body).messages[1].content) as RevisionPayload;
        revisions.push(payload);
        const content = { items: payload.items.filter(item => /法[尔而]童/.test(item.source)).map(item => ({ id: item.id, source: item.source.replace(/法[尔而]童/, '法厄同') })), note: '已将误写更正为“法厄同”。' };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page);
      await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        const profile = { id: 'dock-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'dock-task', name: 'Controlled task', apiFormat: 'chat_completions' }], assignment: { agent: 'dock-agent', taskExecution: 'dock-task' }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      const rows = page.locator('.studio-cue-table tbody tr');
      await uiExpect(rows).toHaveCount(100);
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      /** The panel's box once its opening animation has settled. */
      const settledBox = async (locator: ReturnType<Page['getByRole']>) => {
        let previous = '';
        await expect.poll(async () => { const next = JSON.stringify(await locator.boundingBox()); const same = next === previous; previous = next; return same; }, { intervals: [120], timeout: 3000 }).toBe(true);
        return (await locator.boundingBox())!;
      };

      // The launcher mirrors the theme switch at the other bottom corner.
      const launcher = page.getByTestId('agent-dock-launcher');
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'false');
      const geometry = await page.evaluate(() => {
        const launcher = document.querySelector('[data-testid=agent-dock-launcher]')!.getBoundingClientRect();
        const theme = [...document.querySelectorAll('button')].find(button => /主题/.test(button.getAttribute('aria-label') ?? button.title ?? ''))!.getBoundingClientRect();
        return { left: launcher.left, bottom: innerHeight - launcher.bottom, size: launcher.width, themeRight: innerWidth - theme.right, themeBottom: innerHeight - theme.bottom };
      });
      expect(geometry).toMatchObject({ left: 11, size: 36 });
      expect(Math.abs(geometry.bottom - geometry.themeBottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.left - geometry.themeRight)).toBeLessThanOrEqual(1);
      // A closed panel is not a layer, so Escape still belongs to the page.
      await uiExpect(page.locator('[role=dialog]')).toHaveCount(0);

      await launcher.click();
      const panel = page.getByRole('dialog', { name: 'FusionKit Agent 对话' });
      await uiExpect(panel).toBeVisible();
      await uiExpect(page.getByTestId('agent-dock-input')).toBeFocused();
      await uiExpect(page.getByTestId('agent-dock-page')).toHaveText('字幕工作台 · 法厄同.srt');
      await uiExpect(page.getByTestId('agent-dock-suggestion')).toHaveCount(3);
      const box = await settledBox(panel);
      const nav = await page.locator('.fixed.bottom-0 .rounded-full.p-1').first().boundingBox();
      expect(box.x).toBe(11);
      // The panel stays clear of the bottom navigation.
      expect(box.y + box.height).toBeLessThan(nav!.y);
      await shot('01-open-empty-1280-light');

      // The launcher has turned into the panel: while it is open the launcher is gone from the corner.
      await uiExpect.poll(() => launcher.evaluate(element => !!element.closest('[inert]') && getComputedStyle(element.parentElement!).opacity)).toBe('0');
      // Dragged by its header, the panel stays where it is dropped, also after minimizing and reopening.
      const header = page.getByTestId('agent-dock-header');
      const headerBox = (await header.boundingBox())!;
      await page.mouse.move(headerBox.x + 120, headerBox.y + headerBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(headerBox.x + 320, headerBox.y + headerBox.height / 2 - 60, { steps: 8 });
      await page.mouse.move(headerBox.x + 420, headerBox.y + headerBox.height / 2 - 100, { steps: 8 });
      await page.mouse.up();
      const dragged = await settledBox(panel);
      expect(dragged.x).toBe(box.x + 300);
      expect(dragged.y).toBe(box.y - 100);
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'true');
      await shot('01b-dragged-1280-light');
      // Minimizing turns the panel back into the launcher at the corner.
      await page.getByTestId('agent-dock-minimize').click();
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(launcher).toBeFocused();
      await uiExpect.poll(() => launcher.evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe('1');
      await uiExpect(page.locator('[role=dialog]')).toHaveCount(0);
      await launcher.click();
      expect(await settledBox(panel)).toMatchObject({ x: dragged.x, y: dragged.y });
      // Dragging cannot take it out of the window or under the title bar.
      await page.mouse.move(dragged.x + 120, dragged.y + 20);
      await page.mouse.down();
      await page.mouse.move(dragged.x + 3000, dragged.y - 3000, { steps: 6 });
      await page.mouse.up();
      const clamped = await settledBox(panel);
      expect(clamped.x + clamped.width).toBe(await page.evaluate(() => innerWidth) - 11);
      expect(clamped.y).toBe(48);
      // A double click on the header brings it back to where it rests.
      await header.dblclick({ position: { x: 120, y: 20 } });
      expect(await settledBox(panel)).toMatchObject({ x: box.x, y: box.y });

      // Esc closes and returns focus without popping the launcher's tooltip; hovering shows it to the right.
      await page.keyboard.press('Escape');
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(launcher).toBeFocused();
      await uiExpect(page).toHaveURL(/subtitle\/studio/);
      const tooltip = page.locator('[data-slot="tooltip-content"]');
      await page.waitForTimeout(600);
      await uiExpect(tooltip).toHaveCount(0);
      await page.mouse.move(640, 300);
      await launcher.hover();
      await uiExpect(tooltip).toContainText('打开 Agent');
      const launcherBox = (await launcher.boundingBox())!, tipBox = (await tooltip.boundingBox())!;
      expect(tipBox.x).toBeGreaterThan(launcherBox.x + launcherBox.width);
      await page.screenshot({ path: path.join(artifacts, '00-launcher-tooltip.png'), clip: { x: 0, y: 760, width: 260, height: 100 } });

      // A press elsewhere on the page closes the panel and still reaches the page.
      await launcher.click();
      await uiExpect(panel).toBeVisible();
      // Choosing an execution mode from the panel's own list keeps the panel open.
      const modeSelect = page.getByTestId('agent-dock-panel').getByTestId('agent-execution-mode');
      await modeSelect.click();
      await page.getByRole('option', { name: '询问执行' }).click();
      await uiExpect(modeSelect).toContainText('询问执行');
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'true');
      // With the list open, a press elsewhere only dismisses the list.
      await modeSelect.click();
      await uiExpect(page.getByRole('option', { name: '仅添加' })).toBeVisible();
      await page.mouse.click(1000, 620);
      await uiExpect(page.getByRole('option')).toHaveCount(0);
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'true');
      await modeSelect.click();
      await page.getByRole('option', { name: '仅添加' }).click();
      await uiExpect(modeSelect).toContainText('仅添加');
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'true');
      await rows.nth(1).locator('.studio-cue-time').click();
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'false');
      await uiExpect(page.getByTestId('studio-cue-selected-count')).toHaveText('已选中 1 条');
      await page.waitForTimeout(600);
      await uiExpect(tooltip).toHaveCount(0);

      // Pinned, the panel stays open while the user works in the page.
      await launcher.click();
      await page.getByTestId('agent-dock-pin').click();
      await uiExpect(page.getByTestId('agent-dock-pin')).toHaveAttribute('aria-pressed', 'true');
      await rows.nth(2).locator('.studio-cue-time').click();
      await uiExpect(page.getByTestId('studio-cue-selected-count')).toHaveText('已选中 1 条');
      await uiExpect(launcher).toHaveAttribute('aria-expanded', 'true');

      // The agent prepares a document-wide revision; the preview opens over the panel.
      queue.push(call('studio_prepare_revision', { instructions: '文中的“法尔童”都应为“法厄同”', scope: 'document', fields: 'source', terms: ['法尔童', '法而童'] }));
      queue.push(text('已在字幕工作台打开修订预览：找到 3 处误写并建议改为“法厄同”，请在预览中确认后应用。'));
      await page.getByTestId('agent-dock-input').fill('文中的“法尔童”都应为“法厄同”');
      await page.getByTestId('agent-dock-input').press('Enter');
      const preview = page.getByRole('dialog', { name: 'AI 修订' });
      await uiExpect(preview).toBeVisible();
      const items = preview.getByTestId('studio-cue-revision-item');
      await uiExpect(items).toHaveCount(3);
      await uiExpect(preview.getByTestId('studio-cue-revision-plan')).toContainText('法而童');
      expect(revisions.length).toBe(1);
      expect(revisions[0].items).toHaveLength(3);
      const first = agentRequests[0];
      expect(first.instructions).toContain('### Current Page');
      expect(first.instructions).toContain('"route":"/tools/subtitle/studio"');
      expect(first.instructions).toContain('"subject":"法厄同.srt"');
      expect(first.instructions).toContain('"cueNumbers":[3]');
      expect(first.tools.map(item => item.name)).toEqual(expect.arrayContaining(['studio_prepare_revision', 'studio_read_cues', 'studio_find_cues', 'list_studio_documents']));
      // The modal preview hides the panel from the accessibility tree while it is open.
      await uiExpect(page.getByTestId('agent-dock-panel').getByText('已在字幕工作台打开修订预览')).toBeVisible();
      const output = JSON.parse(agentRequests[1].input.find(item => item.type === 'function_call_output')!.output!);
      expect(output).toMatchObject({ success: true, data: { status: 'awaiting_user_review', checkedCues: 3, proposedRevisions: 3 } });
      // Nothing is written until the user applies.
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('法尔童驾着太阳车出发了。');
      await shot('02-preview-over-panel');
      await preview.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(preview).toBeHidden();
      await uiExpect(rows.nth(4).locator('[data-field=source]')).toHaveText('法厄同驾着太阳车出发了。');
      await shot('03-applied-conversation');

      // Closed while replying: the launcher shows progress, then an unread reply.
      holdNext = true;
      queue.push(text('第 5 句现在是“法厄同驾着太阳车出发了。”'));
      await page.getByTestId('agent-dock-input').fill('第 5 句现在是什么？');
      await page.getByTestId('agent-dock-input').press('Enter');
      await page.getByTestId('agent-dock-minimize').click();
      await uiExpect(page.getByTestId('agent-dock-busy')).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '04-launcher-busy.png'), clip: { x: 0, y: 760, width: 200, height: 100 } });
      await expect.poll(() => !!hold).toBe(true);
      hold!();
      await uiExpect(page.getByTestId('agent-dock-unread')).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, '05-launcher-unread.png'), clip: { x: 0, y: 760, width: 200, height: 100 } });

      // Narrow dark window.
      await win.evaluate(window => window.setSize(786, 660));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await launcher.click();
      await uiExpect(page.getByTestId('agent-dock-unread')).toHaveCount(0);
      const narrow = await settledBox(panel);
      const narrowNav = await page.locator('.fixed.bottom-0 .rounded-full.p-1').first().boundingBox();
      expect(narrow.y).toBeGreaterThanOrEqual(40);
      expect(narrow.y + narrow.height).toBeLessThan(narrowNav!.y);
      await shot('06-open-786-dark');

      // The panel and its composer have smooth corners; the composer's controls sit at equal insets.
      const corners = await page.getByTestId('agent-dock-panel').evaluate(element => ({ shape: getComputedStyle(element).getPropertyValue('corner-top-left-shape') || getComputedStyle(element).getPropertyValue('corner-shape'), clip: getComputedStyle(element).clipPath }));
      expect(corners.shape).toContain('superellipse');
      expect(corners.clip).toContain('-24px');
      const composerBox = (await page.getByTestId('agent-dock-composer').boundingBox())!;
      const modeBox = (await panel.getByTestId('agent-execution-mode').boundingBox())!;
      const sendBox = (await page.getByTestId('agent-dock-send').boundingBox())!;
      const insets = [modeBox.x - composerBox.x, composerBox.y + composerBox.height - (modeBox.y + modeBox.height), composerBox.x + composerBox.width - (sendBox.x + sendBox.width)];
      expect(Math.max(...insets) - Math.min(...insets)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(artifacts, '06b-composer-786-dark.png'), clip: { x: 0, y: composerBox.y - 20, width: 440, height: composerBox.height + 40 } });

      // Up and Down recall sent messages in the panel as on the home page.
      const dockInput = page.getByTestId('agent-dock-input');
      await dockInput.click();
      await dockInput.press('ArrowUp');
      await uiExpect(dockInput).toHaveValue('第 5 句现在是什么？');
      await dockInput.press('ArrowUp');
      await uiExpect(dockInput).toHaveValue('文中的“法尔童”都应为“法厄同”');
      await dockInput.press('ArrowDown');
      await dockInput.press('ArrowDown');
      await uiExpect(dockInput).toHaveValue('');

      // A sent message offers a copy button while hovered.
      const sent = panel.locator('[data-message-role=user]').filter({ hasText: '第 5 句现在是什么？' });
      const copyButton = sent.getByTestId('agent-copy-message');
      await uiExpect(copyButton).toHaveCSS('opacity', '0');
      await sent.hover();
      await uiExpect(copyButton).toHaveCSS('opacity', '1');
      await page.screenshot({ path: path.join(artifacts, '06c-copy-message-786-dark.png'), clip: { x: 0, y: Math.max(0, ((await sent.boundingBox())!.y) - 30), width: 440, height: 110 } });
      await copyButton.click();
      await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('第 5 句现在是什么？');

      // The home page is the full assistant: no launcher, same conversation.
      await page.getByTestId('agent-dock-open-home').click();
      await page.getByTestId('home-agent').waitFor();
      await uiExpect(launcher).toHaveCount(0);
      await uiExpect(page.getByTestId('home-agent').getByText('第 5 句现在是什么？')).toBeVisible();
      await shot('07-home-same-conversation');
      // The home composer shares the input history with the panel.
      await page.getByTestId('agent-input').click();
      await page.getByTestId('agent-input').press('ArrowUp');
      await uiExpect(page.getByTestId('agent-input')).toHaveValue('第 5 句现在是什么？');
      await page.getByTestId('agent-input').press('ArrowDown');
      await uiExpect(page.getByTestId('agent-input')).toHaveValue('');
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 180000);
});
