import { createServer, type Server } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createTestRun } from './support/testRun';

type ResponsesBody = { instructions: string; tools?: { name: string }[]; input: { role?: string; content?: unknown }[] };
const TITLE_PREFIX = 'You name conversations.';

/** Responses API stream with the events the agent adapter reads. */
function stream(text: string) {
  return [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const DAY = 24 * 60 * 60 * 1000;
/** A saved session in the export format, as the app writes it. */
function savedSession(id: string, title: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1, exportedAt: updatedAt, executionMode: 'queue_only',
    session: { id, status: 'idle', createdAt: updatedAt - 60_000, updatedAt, title, titleSource: 'generated',
      messages: [
        { id: `${id}-u`, role: 'user', content: `关于「${title}」的请求`, timestamp: updatedAt - 50_000 },
        { id: `${id}-a`, role: 'assistant', content: `已处理：${title}。`, timestamp: updatedAt - 40_000 },
      ], ...extra },
    tokenStats: { totalPromptTokens: 100, totalCompletionTokens: 20, totalTokens: 120, totalCost: 0.001, stepCount: 1, lastPromptTokens: 100, interactions: [] },
    sessionLog: [],
  });
}

async function seed(profile: string) {
  const folder = path.join(profile, 'agent-sessions');
  await mkdir(folder, { recursive: true });
  const now = Date.now();
  const titles: [string, number, Record<string, unknown>?][] = [
    ['你好', now - 5 * 60_000],
    ['把工作台里还没翻译的日语字幕翻成中文并导出双语 SRT 文件', now - 30 * 60_000],
    ['Translate EP01–EP12 subtitles into Simplified Chinese', now - 2 * 60 * 60_000],
    ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.srt', now - 3 * 60 * 60_000],
    ['《绝区零》译名整理', now - 4 * 60 * 60_000, { pinned: true }],
    ['统一「泰姆菲尔德家的大小姐」的写法', now - 40 * DAY, { pinned: true }],
    ['LRC 转 SRT', now - DAY - 60_000],
    ['提取双语字幕中的中文', now - DAY - 2 * 60 * 60_000],
    ['恢复上次失败的翻译', now - 2 * DAY],
    ['重命名动画文件夹', now - 3 * DAY],
    ['转写 10 个音频并翻译', now - 4 * DAY],
    ['术语一致性检查', now - 5 * DAY],
    ['フォルダ名を翻訳', now - 6 * DAY],
    ['旧会话 1', now - 10 * DAY],
    ['旧会话 2', now - 20 * DAY],
    ['旧会话 3', now - 30 * DAY],
    ['旧会话 4', now - 50 * DAY],
    ['旧会话 5', now - 60 * DAY],
    ['旧会话 6', now - 70 * DAY],
  ];
  for (const [index, [title, time, extra]] of titles.entries()) await writeFile(path.join(folder, `seed-${index}.json`), savedSession(`seed-${index}`, title, time, extra));
  await writeFile(path.join(folder, 'seed-broken.json'), '{ this file is damaged');
}

interface Harness { app: ElectronApplication; page: Page; requests: ResponsesBody[]; replies: string[]; hold: () => () => void; close: () => Promise<void> }

async function launch(root: string, port: number, size: [number, number]): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const page = await app.firstWindow();
  const win = await app.browserWindow(page);
  await win.evaluate((window, [width, height]) => { window.setSize(width, height); window.webContents.setBackgroundThrottling(false); window.show(); }, size);
  await page.evaluate(port => {
    const profile = { id: 'sessions-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
    localStorage.setItem('lang', 'zh');
    if (!localStorage.getItem('fusionkit-theme')) localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
    localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'sessions-task', name: 'Controlled task', apiFormat: 'chat_completions' }], assignment: { agent: 'sessions-agent', taskExecution: 'sessions-task' }, audioProfiles: [], audioAssignment: {} } }));
    location.hash = '/';
  }, port);
  await page.reload();
  await page.getByTestId('home-agent').waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  // The first route change may still be fading the previous page copy out.
  await uiExpect(page.getByTestId('home-agent')).toHaveCount(1);
  return { app, page };
}

async function harness(root: string, size: [number, number] = [1440, 900]): Promise<Harness & { port: number; server: Server }> {
  const requests: ResponsesBody[] = [];
  const replies: string[] = [];
  const held: (() => void)[] = [];
  let holdNext = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part.toString();
    const parsed = JSON.parse(body) as ResponsesBody;
    requests.push(parsed);
    response.setHeader('Content-Type', 'text/event-stream');
    if (parsed.instructions.startsWith(TITLE_PREFIX)) {
      const asked = JSON.stringify(parsed.input);
      response.end(stream(asked.includes('第一个会话') ? '“第一个会话的标题。”' : asked.includes('第二个会话') ? '第二个会话标题' : '生成的标题'));
      return;
    }
    const payload = stream(replies.shift() ?? '好的。');
    if (holdNext) { holdNext = false; held.push(() => response.end(payload)); } else response.end(payload);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const { app, page } = await launch(root, port, size);
  const result = {
    app, page, requests, replies, port, server,
    hold: () => { holdNext = true; return () => held.shift()?.(); },
    // The app may have been relaunched meanwhile: close the current one.
    close: async () => { await result.app.close().catch(() => undefined); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  return result;
}

const settle = (page: Page) => page.waitForTimeout(450);
/** Makes the page exactly this wide: the window frame adds a few pixels that differ between machines. */
async function setPageSize(app: ElectronApplication, page: Page, width: number, height: number) {
  const win = await app.browserWindow(page);
  await win.evaluate((window, [w, h]) => window.setContentSize(w, h), [width, height]);
  await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));
  const extra = await page.evaluate(width => innerWidth - width, width);
  if (extra) await win.evaluate((window, [w, h]) => window.setContentSize(w, h), [width - extra, height]);
  await page.waitForFunction(width => innerWidth === width, width);
}
async function reloadHome(page: Page) {
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=home-agent]').length === 1 && !document.querySelector('.app-loading-wrap'));
}

describe.runIf(process.env.FUSIONKIT_AGENT_SESSIONS_E2E === '1')('agent sessions', () => {
  it('lists, finds, renames, pins, opens and deletes saved sessions in the home sidebar', async () => {
    const artifacts = path.resolve('test-results/agent-sessions'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts, 'list-');
    await seed(path.join(root, 'profile'));
    let run: Awaited<ReturnType<typeof harness>> | undefined;
    const errors: string[] = [];
    try {
      run = await harness(root);
      const { page } = run;
      page.on('pageerror', error => errors.push(error.message));
      const shot = async (name: string) => { await settle(page); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const sidebar = page.getByTestId('agent-sessions-sidebar');
      await page.screenshot({ path: path.join(artifacts, '00-start.png') });
      await uiExpect(sidebar).toHaveAttribute('data-mode', 'docked');
      const rows = sidebar.locator('[data-session-row]');
      await uiExpect(rows).toHaveCount(20);
      // Starting the app shows a blank conversation, not the last one.
      await uiExpect(page.getByTestId('agent-input')).toHaveValue('');
      await uiExpect(page.locator('[data-message-role]')).toHaveCount(0);
      const groups = await sidebar.locator('section h3').allTextContents();
      expect(groups).toEqual(['置顶', '今天', '昨天', '近 7 天', '更早']);
      await uiExpect(sidebar.locator('section').first().locator('[data-session-row]')).toHaveText(['《绝区零》译名整理', '统一「泰姆菲尔德家的大小姐」的写法']);
      await uiExpect(sidebar.locator('[data-session-state=unreadable]')).toHaveCount(1);
      // The conversation is centered in the space beside the docked list.
      const geometry = await page.evaluate(() => {
        const side = document.querySelector('[data-testid=agent-sessions-sidebar]')!.getBoundingClientRect();
        const capsule = document.querySelector('[data-testid=agent-input]')!.closest('.max-w-2xl')!.getBoundingClientRect();
        return { sideRight: side.right, columnLeft: capsule.left, columnRight: capsule.right, width: innerWidth };
      });
      expect(geometry.sideRight).toBeLessThan(geometry.columnLeft);
      expect(Math.abs((geometry.columnLeft - geometry.sideRight) - (geometry.width - geometry.columnRight))).toBeLessThanOrEqual(2);
      await shot('01-sidebar-1440-light');

      // A long title is cut on one line; its tooltip shows the whole title.
      const longRow = sidebar.locator('[data-session-id=seed-3]');
      await longRow.hover();
      await uiExpect(page.getByRole('tooltip')).toContainText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.srt');
      await shot('02-long-title-tooltip');
      // A short title has no tooltip.
      await sidebar.locator('[data-session-id=seed-0]').hover();
      await page.waitForTimeout(700);
      await uiExpect(page.getByRole('tooltip')).toHaveCount(0);

      // Search by title and by the latest words.
      const search = page.getByTestId('agent-sessions-search');
      await search.fill('ep01');
      await uiExpect(rows).toHaveText(['Translate EP01–EP12 subtitles into Simplified Chinese']);
      await search.fill('已处理：LRC');
      await uiExpect(rows).toHaveText(['LRC 转 SRT']);
      await search.fill('没有这个');
      await uiExpect(page.getByTestId('agent-sessions-empty')).toHaveText('没有匹配的会话');
      await shot('03-search-no-match');
      await search.press('Escape');
      await uiExpect(rows).toHaveCount(20);

      // Opening a saved session reads it from disk and shows its messages.
      await sidebar.locator('[data-session-id=seed-6]').click();
      await uiExpect(page.locator('[data-message-role=assistant]')).toContainText('已处理：LRC 转 SRT。');
      await uiExpect(sidebar.locator('[data-session-id=seed-6]')).toHaveAttribute('aria-current', 'true');
      await shot('04-opened-saved');

      // Rename: Escape keeps the name, Enter saves it; the place in the list stays.
      const menuOf = (id: string) => sidebar.locator(`[data-session-item="${id}"]`).getByTestId('agent-session-menu');
      await menuOf('seed-7').click();
      await shot('05-row-menu');
      await page.getByRole('menuitem', { name: '重命名' }).click();
      const field = page.getByTestId('agent-session-rename');
      await uiExpect(field).toBeFocused();
      await field.fill('不会保存');
      await field.press('Escape');
      await uiExpect(sidebar.locator('[data-session-id=seed-7]')).toHaveText('提取双语字幕中的中文');
      await menuOf('seed-7').click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await page.getByTestId('agent-session-rename').fill('中文提取（已改名）');
      await page.getByTestId('agent-session-rename').press('Enter');
      await uiExpect(sidebar.locator('[data-session-id=seed-7]')).toHaveText('中文提取（已改名）');
      await expect.poll(async () => JSON.parse(await readFile(path.join(root, 'profile/agent-sessions/seed-7.json'), 'utf8')).session).toMatchObject({ title: '中文提取（已改名）', titleSource: 'manual' });

      // Pin moves it to the pinned group; the file remembers.
      await menuOf('seed-9').click();
      await page.getByRole('menuitem', { name: '置顶' }).click();
      await uiExpect(sidebar.locator('section').first().locator('[data-session-row]')).toContainText(['重命名动画文件夹']);
      await expect.poll(async () => JSON.parse(await readFile(path.join(root, 'profile/agent-sessions/seed-9.json'), 'utf8')).session.pinned).toBe(true);

      // Keyboard: Up/Down move between rows, Enter opens.
      await sidebar.locator('[data-session-id=seed-0]').focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await uiExpect(page.locator('[data-message-role=assistant]')).toContainText('把工作台里还没翻译的日语字幕');

      // Deleting the shown session asks first, then shows a blank one; the file is gone.
      await menuOf('seed-1').click();
      await page.getByRole('menuitem', { name: '删除' }).click();
      const dialog = page.getByRole('dialog');
      await uiExpect(dialog).toContainText('删除这个会话？');
      await uiExpect(dialog).toContainText('「把工作台里还没翻译的日语字幕翻成中文并导出双语 SRT 文件」及其全部消息将被永久删除');
      await shot('06-delete-confirm');
      await dialog.getByRole('button', { name: '删除' }).click();
      await uiExpect(sidebar.locator('[data-session-id=seed-1]')).toHaveCount(0);
      await uiExpect(page.locator('[data-message-role]')).toHaveCount(0);
      await expect.poll(async () => (await readdir(path.join(root, 'profile/agent-sessions'))).includes('seed-1.json')).toBe(false);
      // The damaged file can still be deleted.
      await menuOf('seed-broken').click();
      await uiExpect(page.getByRole('menuitem')).toHaveCount(1);
      await page.getByRole('menuitem', { name: '删除' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
      await uiExpect(sidebar.locator('[data-session-state=unreadable]')).toHaveCount(0);

      // Dark theme.
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
      await reloadHome(page); await page.getByTestId('agent-sessions-sidebar').waitFor();
      await page.getByTestId('agent-sessions-sidebar').locator('[data-session-id=seed-6]').click();
      await uiExpect(page.locator('[data-message-role=assistant]')).toContainText('已处理：LRC 转 SRT。');
      await shot('07-sidebar-1440-dark');

      // At 1000px the list still stays beside the conversation, which is centered in the space left of it.
      const win = await run.app.browserWindow(page);
      await setPageSize(run.app, page, 1000, 700);
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveAttribute('data-mode', 'docked');
      await page.waitForTimeout(600);
      const narrowDocked = await page.evaluate(() => {
        const side = document.querySelector('[data-testid=agent-sessions-sidebar]')!.getBoundingClientRect();
        const column = document.querySelector('[data-testid=home-agent] .max-w-2xl')!.getBoundingClientRect();
        return { gapLeft: column.left - side.right, gapRight: innerWidth - column.right, width: innerWidth };
      });
      expect(narrowDocked.width).toBe(1000);
      expect(narrowDocked.gapLeft).toBeGreaterThanOrEqual(16);
      expect(Math.abs(narrowDocked.gapLeft - narrowDocked.gapRight)).toBeLessThanOrEqual(2);
      await shot('07b-docked-1000-dark');

      // A narrower window: the list opens over the page from the top-left button and closes on picking.
      await setPageSize(run.app, page, 960, 700);
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveCount(0);
      await shot('08-collapsed-960-dark');
      await page.getByTestId('agent-sessions-expand').click();
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveAttribute('data-mode', 'overlay');
      await uiExpect(page.getByTestId('agent-sessions-search')).toBeFocused();
      await shot('09-overlay-960-dark');
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveCount(0);
      await uiExpect(page.getByTestId('agent-sessions-expand')).toBeFocused();
      await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); });
      await reloadHome(page); await page.getByTestId('agent-sessions-expand').waitFor();
      await win.evaluate(window => window.setSize(786, 540));
      await page.getByTestId('agent-sessions-expand').click();
      await page.getByTestId('agent-sessions-sidebar').locator('[data-session-id=seed-8]').click();
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveCount(0);
      await uiExpect(page.locator('[data-message-role=assistant]')).toContainText('恢复上次失败的翻译');
      await page.getByTestId('agent-sessions-expand').click();
      await shot('10-overlay-786-light');
      const visibleRows = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid=agent-sessions-sidebar]')!.getBoundingClientRect();
        return [...document.querySelectorAll('[data-testid=agent-sessions-sidebar] [data-session-row]')].filter(row => row.getBoundingClientRect().bottom <= panel.bottom).length;
      });
      // Ends above the bottom navigation; seven whole rows still fit at the smallest window.
      expect(visibleRows).toBeGreaterThanOrEqual(7);
      const clear = await page.evaluate(() => document.querySelector('[data-testid=agent-sessions-sidebar]')!.getBoundingClientRect().bottom < document.querySelector('.fixed.bottom-0 .rounded-full.p-1, nav')!.getBoundingClientRect().top);
      expect(clear).toBe(true);
      // Wide again with the sidebar hidden by the user: it stays hidden after a restart.
      await page.keyboard.press('Escape');
      await win.evaluate(window => window.setSize(1440, 900));
      await page.getByTestId('agent-sessions-collapse').click();
      await uiExpect(page.getByTestId('agent-sessions-expand')).toBeVisible();
      await reloadHome(page); await page.getByTestId('agent-sessions-expand').waitFor();
      await uiExpect(page.getByTestId('agent-sessions-sidebar')).toHaveCount(0);
      // English wording, with the row menu open.
      await page.evaluate(() => localStorage.setItem('lang', 'en'));
      await reloadHome(page);
      await page.getByTestId('agent-sessions-expand').click();
      const english = page.getByTestId('agent-sessions-sidebar');
      await uiExpect(english.locator('section h3')).toHaveText(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier']);
      await english.locator('[data-session-item="seed-6"]').getByTestId('agent-session-menu').click();
      await uiExpect(page.getByRole('menuitem')).toHaveText(['Rename', 'Pin', 'Export', 'Delete']);
      await shot('18-sidebar-en-menu');
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    } finally { await run?.close(); }
  }, 240_000);

  it('grows the list out of its two buttons and shrinks it back into them', async () => {
    const artifacts = path.resolve('test-results/agent-sessions'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts, 'motion-');
    await seed(path.join(root, 'profile'));
    let run: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      run = await harness(root);
      const { page } = run;
      await page.getByTestId('agent-sessions-sidebar').waitFor();
      /** Every animation frame for a while: the container, the open/close button and the layers' opacity. */
      type Frame = { t: number; w: number; h: number; bx: number; by: number; surface: number; panel: number; cx: number };
      const sample = (ms: number) => page.evaluate(ms => new Promise<Frame[]>(resolve => {
        const frames: Frame[] = [];
        const start = performance.now();
        const tick = () => {
          const shell = document.querySelector('[data-testid=agent-sessions-shell]')!.getBoundingClientRect();
          const button = document.querySelector('[data-testid=agent-sessions-expand], [data-testid=agent-sessions-collapse]')!.getBoundingClientRect();
          const surface = Number(getComputedStyle(document.querySelector('[data-testid=agent-sessions-shell] > [aria-hidden]')!).opacity);
          const panelNode = document.querySelector('[data-testid=agent-sessions-sidebar]');
          const column = document.querySelector('[data-testid=agent-input]')!.closest('.max-w-2xl')!.getBoundingClientRect();
          frames.push({ cx: Math.round(column.left + column.width / 2), t: Math.round(performance.now() - start), w: Math.round(shell.width), h: Math.round(shell.height), bx: Math.round(button.left), by: Math.round(button.top),
            surface: Math.round(surface * 100) / 100, panel: panelNode ? Math.round(Number(getComputedStyle(panelNode).opacity) * 100) / 100 : 0 });
          if (performance.now() - start < ms) requestAnimationFrame(tick); else resolve(frames);
        };
        requestAnimationFrame(tick);
      }), ms);
      const continuous = (values: number[]) => new Set(values).size;

      const middle = await page.evaluate(() => Math.round(innerWidth / 2));
      // Docked: closing shrinks the container into the buttons at the top left, and opening grows it back.
      const closing = sample(700);
      await page.getByTestId('agent-sessions-collapse').click();
      const closeFrames = await closing;
      await writeFile(path.join(artifacts, 'motion-close-docked.json'), JSON.stringify(closeFrames, null, 1));
      expect(closeFrames[0].w).toBe(248);
      expect(closeFrames.at(-1)).toMatchObject({ w: 76, h: 44, surface: 0, panel: 0 });
      expect(continuous(closeFrames.map(frame => frame.w))).toBeGreaterThan(8);
      expect(continuous(closeFrames.map(frame => frame.bx))).toBeGreaterThan(8);
      // The conversation moves with the list, from the middle of the space beside it back to the middle of the window.
      expect(Math.abs(closeFrames[0].cx - (middle + 132))).toBeLessThanOrEqual(1);
      expect(Math.abs(closeFrames.at(-1)!.cx - middle)).toBeLessThanOrEqual(1);
      expect(continuous(closeFrames.map(frame => frame.cx))).toBeGreaterThan(8);
      // The button rides the container's corner the whole way.
      for (const frame of closeFrames) expect(Math.abs(frame.bx + 28 + 8 - (16 + frame.w))).toBeLessThanOrEqual(1);
      // No tooltip comes up by itself on the button that just moved away from the pointer.
      await page.waitForTimeout(1000);
      await uiExpect(page.getByRole('tooltip')).toHaveCount(0);
      await page.screenshot({ path: path.join(artifacts, 'motion-closed.png') });

      const opening = sample(700);
      await page.getByTestId('agent-sessions-expand').click();
      const openFrames = await opening;
      await writeFile(path.join(artifacts, 'motion-open-docked.json'), JSON.stringify(openFrames, null, 1));
      expect(openFrames.at(-1)).toMatchObject({ w: 248, surface: 1, panel: 1 });
      expect(Math.abs(openFrames.at(-1)!.cx - (middle + 132))).toBeLessThanOrEqual(1);
      expect(continuous(openFrames.map(frame => frame.w))).toBeGreaterThan(8);
      await page.waitForTimeout(1000);
      await uiExpect(page.getByRole('tooltip')).toHaveCount(0);

      // Mid-way pictures of both directions.
      for (const [name, testId] of [['close', 'agent-sessions-collapse'], ['open', 'agent-sessions-expand']] as const) {
        await page.getByTestId(testId).click();
        for (const at of [60, 140, 240]) {
          await page.waitForTimeout(at === 60 ? 60 : 80);
          await page.screenshot({ path: path.join(artifacts, `motion-${name}-${at}.png`) });
        }
        await page.waitForTimeout(700);
      }

      // Narrow window: the list opens over the page from the same buttons, and closes with Escape.
      const win = await run.app.browserWindow(page);
      await setPageSize(run.app, page, 960, 700);
      await uiExpect(page.getByTestId('agent-sessions-expand')).toBeVisible();
      // The docked list closes itself when the window gets narrow; let that finish first.
      await page.waitForTimeout(800);
      const overlayOpen = sample(700);
      await page.getByTestId('agent-sessions-expand').click();
      const overlayFrames = await overlayOpen;
      await writeFile(path.join(artifacts, 'motion-open-overlay.json'), JSON.stringify(overlayFrames, null, 1));
      // Over the page, the list does not move the conversation.
      expect(overlayFrames.at(-1)).toMatchObject({ w: 248, surface: 1, panel: 1 });
      expect(new Set(overlayFrames.map(frame => frame.cx)).size).toBe(1);
      expect(Math.abs(overlayFrames[0].cx - await page.evaluate(() => Math.round(innerWidth / 2)))).toBeLessThanOrEqual(1);
      await uiExpect(page.getByTestId('agent-sessions-search')).toBeFocused();
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('agent-sessions-expand')).toBeFocused();
      await page.waitForTimeout(1000);
      await uiExpect(page.getByRole('tooltip')).toHaveCount(0);
    } finally { await run?.close(); }
  }, 240_000);

  it('runs sessions side by side, names them, and keeps them across a restart', async () => {
    const artifacts = path.resolve('test-results/agent-sessions'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts, 'live-');
    let run: Awaited<ReturnType<typeof harness>> | undefined;
    const errors: string[] = [];
    try {
      run = await harness(root);
      const { page, requests, replies } = run;
      page.on('pageerror', error => errors.push(error.message));
      const sidebar = page.getByTestId('agent-sessions-sidebar');
      const input = page.getByTestId('agent-input');

      // Session A: its reply is held back.
      const releaseA = run.hold();
      replies.push('A 的完整回复。');
      await input.fill('第一个会话：慢慢回答');
      await input.press('Enter');
      await uiExpect(sidebar.locator('[data-session-row]')).toHaveText(['第一个会话：慢慢回答']);
      const aId = await sidebar.locator('[data-session-row]').first().getAttribute('data-session-id');
      await uiExpect(page.getByTestId('agent-send')).toHaveAttribute('aria-label', '停止生成');

      // Session B while A is still replying, with an unsent draft kept in A.
      await page.getByTestId('agent-new-session').click();
      await uiExpect(page.locator('[data-message-role]')).toHaveCount(0);
      await uiExpect(sidebar.locator(`[data-session-id="${aId}"]`)).toHaveAttribute('data-session-state', 'running');
      replies.push('B 的回复。');
      await input.fill('第二个会话：马上回答');
      await input.press('Enter');
      await uiExpect(page.locator('[data-message-role=assistant]')).toHaveText(['B 的回复。']);
      await uiExpect(sidebar.locator(`[data-session-id="${aId}"]`)).toHaveAttribute('data-session-state', 'running');
      await settle(page); await page.screenshot({ path: path.join(artifacts, '11-running-in-background.png') });

      // A finishes in the background: an unread mark, and nothing of A in B.
      releaseA();
      await uiExpect(sidebar.locator(`[data-session-id="${aId}"]`)).toHaveAttribute('data-session-state', 'unread');
      await uiExpect(page.locator('[data-message-role=assistant]')).toHaveText(['B 的回复。']);
      await settle(page); await page.screenshot({ path: path.join(artifacts, '12-unread.png') });
      await input.fill('B 的草稿');
      await sidebar.locator(`[data-session-id="${aId}"]`).click();
      await uiExpect(page.locator('[data-message-role=assistant]')).toHaveText(['A 的完整回复。']);
      await uiExpect(sidebar.locator(`[data-session-id="${aId}"]`)).toHaveAttribute('data-session-state', 'idle');
      await uiExpect(input).toHaveValue('');
      const bId = await sidebar.locator('[data-session-row]').filter({ hasNotText: '第一个' }).first().getAttribute('data-session-id');
      await sidebar.locator(`[data-session-id="${bId}"]`).click();
      await uiExpect(input).toHaveValue('B 的草稿');

      // Titles: the excerpt first, then the model's short title; the title request carries no tools.
      await uiExpect(sidebar.locator(`[data-session-id="${aId}"]`)).toHaveText('第一个会话的标题');
      await uiExpect(sidebar.locator(`[data-session-id="${bId}"]`)).toHaveText('第二个会话标题');
      const titleRequests = requests.filter(request => request.instructions.startsWith(TITLE_PREFIX));
      expect(titleRequests).toHaveLength(2);
      expect(titleRequests.every(request => !request.tools?.length)).toBe(true);
      expect(requests.filter(request => !request.instructions.startsWith(TITLE_PREFIX)).every(request => (request.tools?.length ?? 0) > 0)).toBe(true);

      // A title the user typed before naming finishes is kept.
      replies.push('C 的回复。');
      const releaseC = run.hold();
      await page.getByTestId('agent-new-session').click();
      await input.fill('第三个会话');
      await input.press('Enter');
      const cRow = sidebar.locator('[data-session-row]').filter({ hasText: '第三个会话' });
      const cId = await cRow.getAttribute('data-session-id');
      await sidebar.locator(`[data-session-item="${cId}"]`).getByTestId('agent-session-menu').click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await page.getByTestId('agent-session-rename').fill('我的名字');
      await page.getByTestId('agent-session-rename').press('Enter');
      releaseC();
      await uiExpect(page.locator('[data-message-role=assistant]')).toHaveText(['C 的回复。']);
      await page.waitForTimeout(800);
      await uiExpect(sidebar.locator(`[data-session-id="${cId}"]`)).toHaveText('我的名字');

      // Restart: the list and the conversations are back, and the app opens on a blank session.
      await run.app.close();
      const relaunched = await launch(root, run.port, [1440, 900]);
      run.app = relaunched.app; run.page = relaunched.page;
      const page2 = relaunched.page;
      page2.on('pageerror', error => errors.push(error.message));
      const sidebar2 = page2.getByTestId('agent-sessions-sidebar');
      await uiExpect(sidebar2.locator('[data-session-row]')).toHaveText(['我的名字', '第一个会话的标题', '第二个会话标题']);
      await uiExpect(page2.locator('[data-message-role]')).toHaveCount(0);
      await sidebar2.locator(`[data-session-id="${aId}"]`).click();
      await uiExpect(page2.locator('[data-message-role=user]')).toHaveText(['第一个会话：慢慢回答']);
      await uiExpect(page2.locator('[data-message-role=assistant]')).toHaveText(['A 的完整回复。']);
      replies.push('重启后的回复。');
      await page2.getByTestId('agent-input').fill('继续');
      await page2.getByTestId('agent-input').press('Enter');
      await uiExpect(page2.locator('[data-message-role=assistant]')).toHaveText(['A 的完整回复。', '重启后的回复。']);
      expect(errors).toEqual([]);
    } finally { await run?.close(); }
  }, 240_000);

  it('switches sessions from the floating panel and clears them all from settings', async () => {
    const artifacts = path.resolve('test-results/agent-sessions'); await mkdir(artifacts, { recursive: true });
    const root = await createTestRun(artifacts, 'dock-');
    await seed(path.join(root, 'profile'));
    let run: Awaited<ReturnType<typeof harness>> | undefined;
    const errors: string[] = [];
    try {
      run = await harness(root, [1280, 860]);
      const { page } = run;
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await page.getByTestId('agent-dock-launcher').click();
      await uiExpect(page.getByTestId('agent-dock-session-title')).toHaveText('新对话');
      await settle(page); await page.screenshot({ path: path.join(artifacts, '13-dock-new.png') });
      await page.getByTestId('agent-dock-switcher').click();
      const list = page.getByTestId('agent-dock-switcher-panel');
      await uiExpect(list.locator('[data-session-row]')).toHaveCount(20);
      await uiExpect(page.getByTestId('agent-dock-switcher-search')).toBeFocused();
      await settle(page); await page.screenshot({ path: path.join(artifacts, '14-dock-switcher.png') });
      await page.getByTestId('agent-dock-switcher-search').fill('绝区零');
      await uiExpect(list.locator('[data-session-row]')).toHaveText(['《绝区零》译名整理']);
      await list.locator('[data-session-row]').click();
      await uiExpect(list).toHaveCount(0);
      await uiExpect(page.getByTestId('agent-dock-session-title')).toHaveText('《绝区零》译名整理');
      await uiExpect(page.getByTestId('agent-dock-messages')).toContainText('已处理：《绝区零》译名整理。');
      expect(await page.evaluate(() => location.hash)).toBe('#/tools/subtitle/studio');
      await settle(page); await page.screenshot({ path: path.join(artifacts, '15-dock-switched.png') });
      await page.getByTestId('agent-dock-reset').click();
      await uiExpect(page.getByTestId('agent-dock-session-title')).toHaveText('新对话');
      await page.getByTestId('agent-dock-minimize').click();

      // Settings: the saved count, and deleting everything after a confirmation.
      await page.evaluate(() => { location.hash = '/setting'; });
      await page.getByTestId('setting-tab-agent').click();
      await uiExpect(page.getByTestId('setting-agent-sessions-count')).toContainText('20 个会话');
      await page.getByTestId('setting-agent-sessions-clear').scrollIntoViewIfNeeded();
      await settle(page); await page.screenshot({ path: path.join(artifacts, '16-settings.png') });
      await page.getByTestId('setting-agent-sessions-clear').click();
      await uiExpect(page.getByRole('dialog')).toContainText('清空全部会话？');
      await page.getByRole('dialog').getByRole('button', { name: '清空' }).click();
      await uiExpect(page.getByTestId('setting-agent-sessions-count')).toContainText('0 个会话');
      await uiExpect(page.getByTestId('setting-agent-sessions-clear')).toBeDisabled();
      await expect.poll(async () => (await readdir(path.join(root, 'profile/agent-sessions'))).filter(name => name.endsWith('.json')), { timeout: 10_000 }).toEqual([]);
      await page.evaluate(() => { location.hash = '/'; });
      await uiExpect(page.getByTestId('agent-sessions-empty')).toHaveText('还没有会话记录');
      await settle(page); await page.screenshot({ path: path.join(artifacts, '17-empty-list.png') });
      expect(errors).toEqual([]);
    } finally { await run?.close(); }
  }, 240_000);
});
