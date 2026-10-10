import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';

type ResponsesBody = { instructions: string; tools: { name: string }[]; input: { type?: string; role?: string; content?: unknown; output?: string }[] };

function stream(events: Record<string, unknown>[]) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const text = (value: string) => [{ type: 'response.output_text.delta', delta: value }];
let calls = 0;
function call(name: string, args: unknown) {
  const id = `web-${name}-${++calls}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}

const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const PAGE_URL = 'https://wiki.biligame.com/zzz/%E6%B3%B0%E5%A7%86%E8%8F%B2%E5%B0%94%E5%BE%B7';
/** What the main process answers instead of the network: the renderer, settings, agent and card are real. */
const fixtures = {
  search: { ok: true, value: { source: 'biligame', query: '泰姆菲尔德', results: [
    { title: '泰姆菲尔德', url: PAGE_URL, snippet: '泰姆菲尔德家族是新艾利都的名门。' },
    { title: '泰姆菲尔德家的大小姐', url: `${PAGE_URL}%E5%AE%B6`, snippet: '剧情人物' }] } },
  read: { ok: true, value: { url: PAGE_URL, title: '泰姆菲尔德', site: 'wiki.biligame.com/zzz', truncated: false, accessedAt: '2026-10-10T08:00:00.000Z',
    text: `泰姆菲尔德家族\n日文：${SOURCE}\n中文译名：${TARGET}` } },
};

describe.runIf(process.env.FUSIONKIT_AGENT_WEB_E2E === '1')('agent looks translations up online', () => {
  it('stays offline until allowed, then saves a wording read on a page with that page as its source', async () => {
    const artifacts = path.resolve('test-results/agent-web'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
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
      // Replace the real lookups with fixtures and count what reaches the main process.
      await app.evaluate(({ ipcMain }, fixtures) => {
        const seen: { channel: string; request: unknown }[] = [];
        (globalThis as { webLookupSeen?: typeof seen }).webLookupSeen = seen;
        for (const [channel, reply] of [['web-lookup:search', fixtures.search], ['web-lookup:read', fixtures.read]] as const) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, (_event, request) => { seen.push({ channel, request }); return reply; });
        }
      }, fixtures);
      const seen = () => app!.evaluate(() => (globalThis as unknown as { webLookupSeen: { channel: string; request: unknown }[] }).webLookupSeen);
      const configure = (lang: string, theme: 'light' | 'dark', hash: string) => page.evaluate(({ port, lang, theme, hash }) => {
        const profile = { id: 'web-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'web-task', name: 'Controlled task', apiFormat: 'chat_completions' }], assignment: { agent: 'web-agent', taskExecution: 'web-task' }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = hash;
      }, { port, lang, theme, hash });
      const ready = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string, target: Page | ReturnType<Page['locator']> = page) => { await page.waitForTimeout(450); await target.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const toBottom = async () => {
        const button = page.getByRole('button', { name: /回到最下方|Scroll to bottom/ }).first();
        // The button fades out once the view reaches the end on its own; a missed click is fine.
        if (await button.isVisible().catch(() => false)) { await button.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(600); }
      };
      const library = () => page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });
      const ask = async (message: string) => { await page.getByTestId('agent-input').fill(message); await page.getByTestId('agent-input').press('Enter'); };
      const home = page.getByTestId('home-agent');

      // Off by default: the tool refuses without reaching the main process, and the agent is told so.
      await configure('zh', 'light', '/');
      await page.reload(); await home.waitFor(); await ready();
      queue.push(call('web_search', { query: '泰姆菲尔德', source: 'wikipedia' }));
      queue.push(text('联网查询还没有开启，可以在 设置 → Agent 中开启后我再帮你查。'));
      await ask('帮我上网查一下泰姆菲尔德的官方译名');
      const refused = home.locator('[data-tool-call-status=failed]').last();
      await uiExpect(refused).toContainText('联网查询未开启，可在 设置 → Agent 中开启。');
      await uiExpect(home.getByText('联网查询还没有开启')).toBeVisible();
      expect(requests[0].instructions).toContain('Web lookups are off');
      expect(requests[0].tools.map(item => item.name)).toEqual(expect.arrayContaining(['web_search', 'web_read']));
      expect(JSON.parse(requests[1].input.filter(item => item.type === 'function_call_output').at(-1)!.output!)).toMatchObject({ success: false, error: 'web_lookup_disabled' });
      expect(await seen()).toEqual([]);
      await toBottom();
      await shot('01-refused-off-home-1280-light');

      // Settings → Agent: everything starts off; turning it on and naming a wiki persists.
      await page.evaluate(() => { location.hash = '/setting?tab=agent'; });
      const webSwitch = page.locator('#setting-agent-web');
      await webSwitch.waitFor();
      // The conversation follows into the panel; put it away to look at the page.
      const minimize = page.getByTestId('agent-dock-minimize');
      if (await minimize.isVisible().catch(() => false)) await minimize.click();
      await uiExpect(webSwitch).toHaveAttribute('aria-checked', 'false');
      await uiExpect(page.locator('#setting-agent-source-wikipedia')).toBeDisabled();
      await shot('02-settings-off-1280-light');
      await webSwitch.click();
      await uiExpect(page.locator('#setting-agent-source-wikipedia')).toBeEnabled();
      const codes = page.getByTestId('setting-agent-biligame');
      await codes.fill('zzz, Wiki.biligame.com/sr');
      await codes.press('Enter');
      await uiExpect(page.getByRole('alert')).toContainText('wiki.biligame.com/sr');
      await shot('03-settings-invalid-code-1280-light');
      await codes.fill('zzz');
      await codes.press('Enter');
      await uiExpect(page.getByRole('alert')).toHaveCount(0);
      await page.locator('#setting-agent-source-moegirl').click();
      await uiExpect(page.locator('#setting-agent-source-moegirl')).toHaveAttribute('aria-checked', 'false');
      await page.reload(); await webSwitch.waitFor(); await ready();
      await uiExpect(webSwitch).toHaveAttribute('aria-checked', 'true');
      await uiExpect(codes).toHaveValue('zzz');
      await uiExpect(page.locator('#setting-agent-source-moegirl')).toHaveAttribute('aria-checked', 'false');
      await shot('04-settings-on-1280-light');

      // Allowed: search the configured game wiki, read the page, propose the wording with the page as source.
      await page.evaluate(() => { location.hash = '/'; }); await home.waitFor();
      const before = requests.length;
      queue.push(call('web_search', { query: '泰姆菲尔德', source: 'moegirl' }));
      queue.push(call('web_search', { query: '泰姆菲尔德', source: 'biligame' }));
      queue.push(call('web_read', { url: PAGE_URL }));
      queue.push(call('prepare_knowledge_changes', { languagePair: { source: 'ja', target: 'zh-Hans' },
        subjects: [{ ref: 'zzz', name: '绝区零', kind: 'work' }], collections: [{ ref: 'names', name: '绝区零 · 人物与称谓', subjects: [{ ref: 'zzz' }] }],
        entries: [{ action: 'create', collection: { ref: 'names' }, kind: 'term', source: SOURCE, target: TARGET, basis: 'web', url: PAGE_URL, evidence: `中文译名：${TARGET}` }] }));
      queue.push(text('B 站绝区零 Wiki 的「泰姆菲尔德」页面写的是「泰姆菲尔德家的大小姐」。我准备把它记入资料，来自网页的条目默认待审核，请在卡片上确认。'));
      await ask('那现在帮我查一下，并记到绝区零的资料里');
      const card = home.getByTestId('agent-prepared-action').last();
      await uiExpect(card).toHaveAttribute('data-action-status', 'ready');
      const rows = home.getByTestId('agent-tool-group').last().locator('[data-tool-call-status]');
      // The proposal shows as its card, not as a row.
      await uiExpect(rows).toHaveCount(3);
      await uiExpect(rows.nth(0)).toHaveAttribute('data-tool-call-status', 'failed');
      await uiExpect(rows.nth(0)).toContainText('这个来源已在 设置 → Agent 中关闭。');
      await uiExpect(rows.nth(1)).toContainText('联网搜索B 站游戏 Wiki：找到 2 条结果');
      await uiExpect(rows.nth(2)).toContainText('读取网页泰姆菲尔德 · wiki.biligame.com/zzz');
      await uiExpect(card.getByTestId('knowledge-change-row').last()).toContainText('来自 wiki.biligame.com');
      await uiExpect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      const enabled = requests.slice(before);
      expect(enabled[0].instructions).toContain('web_search then web_read');
      expect(enabled[0].instructions).not.toContain('Web lookups are off');
      expect(await seen()).toEqual([
        { channel: 'web-lookup:search', request: { source: 'biligame', query: '泰姆菲尔德', language: 'zh', limit: 5, game: 'zzz' } },
        { channel: 'web-lookup:read', request: { url: PAGE_URL } }]);
      expect((await library()).data.entries).toEqual([]);
      await toBottom();
      await shot('05-web-card-ready-home-1280-light');
      // The search row's details list what was found.
      await rows.nth(1).getByRole('button').first().click();
      await uiExpect(rows.nth(1)).toContainText('泰姆菲尔德家的大小姐 · wiki.biligame.com');
      await shot('06-search-row-expanded-1280-light', home.getByTestId('agent-tool-group').last());

      queue.push(text('已保存，条目待你在翻译资料中审核后启用。'));
      await card.getByRole('button', { name: '确认保存' }).click();
      await uiExpect(card).toHaveAttribute('data-action-status', 'completed');
      const saved = await library();
      const entry = saved.data.entries[0];
      expect(entry).toMatchObject({ kind: 'term', state: 'candidate', payload: { source: SOURCE, target: TARGET } });
      expect(saved.approvals[entry.id]).toBeUndefined();
      expect(saved.data.sources).toEqual([expect.objectContaining({ kind: 'web', url: PAGE_URL, title: '泰姆菲尔德', accessedAt: '2026-10-10T08:00:00.000Z', excerpt: `中文译名：${TARGET}` })]);
      await toBottom();
      await shot('07-web-card-saved-home-1280-light');

      // Narrow, dark and English: the settings page and the card's source line.
      await win.evaluate(window => window.setSize(786, 660));
      await configure('en', 'dark', '/setting?tab=agent');
      await page.reload(); await webSwitch.waitFor(); await ready();
      await uiExpect(page.getByText('Let the Agent look things up online')).toBeVisible();
      await shot('08-settings-786-dark-en');
      const overflow = await page.locator('main, body').first().evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 240000);
});
