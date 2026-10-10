import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  const id = `knowledge-${name}-${++calls}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}

const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const pair = { source: 'ja', target: 'zh-Hans' };
/** The background conversation's proposal: the work, a collection about it and the term. */
const zzzProposal = {
  languagePair: pair,
  subjects: [{ ref: 'zzz', name: '绝区零', kind: 'work', aliases: ['ZZZ', 'ゼンレスゾーンゼロ'] }],
  collections: [{ ref: 'names', name: '绝区零 · 人物与称谓', description: '角色、家族与称谓的中文译名', subjects: [{ ref: 'zzz' }] }],
  entries: [{ action: 'create', collection: { ref: 'names' }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated', evidence: '有些翻译不太合适 应该是泰姆菲尔德家的大小姐' }],
};
/** A larger proposal that exercises every row shape the card has. */
function sampleProposal(collectionId: string) {
  const long = 'エリー都の新エリー都防衛軍特別作戦課に所属する対ホロウ六課の課長代理による公式声明と、その後に続く長い記者会見の冒頭部分';
  return {
    languagePair: pair,
    collections: [{ ref: 'places', name: '绝区零 · 地名与组织', description: '城市、空洞与组织', subjects: [] }],
    entries: [
      { action: 'create', collection: { id: collectionId }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: SOURCE, target: '时间菲尔德家的大小姐', basis: 'document', evidence: '第 12 句' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: 'ホロウ', target: '空洞', basis: 'agent_inferred', strength: 'required' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: '新エリー都', target: '新艾利都', basis: 'agent_inferred', note: '城市名' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: '対ホロウ六課', target: '对空洞特别行动部第六课', basis: 'agent_inferred' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: 'ヴィクトリア家政', target: '维多利亚家政', basis: 'agent_inferred' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: '邪兎屋', target: '狡兔屋', basis: 'agent_inferred' },
      { action: 'create', collection: { ref: 'places' }, kind: 'term', source: long, target: '新艾利都防卫军特别作战课所属对空洞六课代理课长的官方声明及随后的长篇记者会开场', basis: 'document' },
      { action: 'create', collection: { ref: 'places' }, kind: 'rule', text: '组织名称保留“课”“部”等日式编制称呼，不改为“科”“处”。', basis: 'agent_inferred' },
      { action: 'create', collection: { ref: 'places' }, kind: 'context', text: '空洞（ホロウ）是城市中突然出现的灾害区域。', basis: 'agent_inferred' },
    ],
  };
}

describe.runIf(process.env.FUSIONKIT_AGENT_KNOWLEDGE_E2E === '1')('agent keeps translation materials', () => {
  it('records the background conversation’s wording through a confirmed card and opens it in the library', async () => {
    const artifacts = path.resolve('test-results/agent-knowledge'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const input = path.join(root, '绝区零-第一章.srt');
    const lines = ['こんにちは。', `${SOURCE}がお見えです。`, 'ホロウの調査に向かいます。', `${SOURCE}、こちらへどうぞ。`];
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
    await writeFile(input, lines.map((line, index) => `${index + 1}\n${time(index * 2000)} --> ${time(index * 2000 + 1500)}\n${line}\n`).join('\n'));

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
      const configure = (lang: string, theme: 'light' | 'dark', hash: string) => page.evaluate(({ port, lang, theme, hash }) => {
        const profile = { id: 'knowledge-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', lang); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'knowledge-task', name: 'Controlled task', apiFormat: 'chat_completions' }], assignment: { agent: 'knowledge-agent', taskExecution: 'knowledge-task' }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = hash;
      }, { port, lang, theme, hash });
      const ready = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string, target: Page | ReturnType<Page['locator']> = page) => { await page.waitForTimeout(450); await target.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      /** Leaving the home page or following a card link keeps the panel open; open it only when closed. */
      const openDock = async () => {
        const launcher = page.getByTestId('agent-dock-launcher');
        await launcher.waitFor();
        await page.waitForTimeout(500);
        if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click();
        await uiExpect(page.getByTestId('agent-dock-panel')).toBeVisible();
      };
      /** Scroll a conversation to its end the way a user would, rather than centering one card. */
      const toBottom = async (scope: ReturnType<Page['locator']> | Page = page) => {
        const button = scope.getByRole('button', { name: /回到最下方|Scroll to bottom/ }).first();
        if (await button.isVisible().catch(() => false)) { await button.click(); await page.waitForTimeout(600); }
      };
      const library = () => page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });

      await configure('zh', 'light', '/tools/subtitle/studio');
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await ready();
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);
      expect((await library()).data.collections).toEqual([]);

      // The user asks to keep the wording; the agent looks at the catalog and the cue, then prepares the change.
      queue.push(call('list_translation_knowledge_catalog', {}));
      queue.push(call('studio_find_cues', { terms: ['テイムフィールド'] }));
      queue.push(call('prepare_knowledge_changes', zzzProposal));
      queue.push(text('资料库里还没有《绝区零》的资料集，我准备新建一个并记入这条译法，请在卡片上确认保存。'));
      await openDock();
      const panel = page.getByTestId('agent-dock-panel');
      await page.getByTestId('agent-dock-input').fill('能否把这个词汇记录到一个属于绝区零的翻译资料中');
      await page.getByTestId('agent-dock-input').press('Enter');
      const card = panel.getByTestId('agent-prepared-action');
      await uiExpect(card).toBeVisible();
      await uiExpect(card).toHaveAttribute('data-action-status', 'ready');
      await uiExpect(card.getByTestId('knowledge-change-row')).toHaveCount(3);
      await uiExpect(card).toContainText('存入「绝区零 · 人物与称谓」');
      await uiExpect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      expect(requests[0].tools.map(item => item.name)).toEqual(expect.arrayContaining(['list_translation_knowledge_catalog', 'prepare_knowledge_changes', 'search_translation_knowledge']));
      expect(requests[0].instructions).toContain('Keeping translation materials');
      const prepared = JSON.parse(requests[3].input.filter(item => item.type === 'function_call_output').at(-1)!.output!);
      expect(prepared).toMatchObject({ success: true, data: { executionStatus: 'prepared', enabledByDefault: true } });
      // Nothing is saved before the user confirms.
      expect((await library()).data.collections).toEqual([]);
      await shot('01-card-ready-dock-1280-light');

      // Confirming saves everything at once; the agent hears about it and follows up.
      queue.push(text('已保存到「绝区零 · 人物与称谓」。翻译时在字幕工作台的翻译资料里选用这个资料集即可生效。'));
      await card.getByRole('button', { name: '确认保存' }).click();
      await uiExpect(card).toHaveAttribute('data-action-status', 'completed');
      await uiExpect(card).toContainText('已保存：新建 1 个对象，新建 1 个资料集，新增 1 条；已启用 1 条。');
      const saved = await library();
      expect(saved.data.subjects.map(item => item.name)).toEqual(['绝区零']);
      expect(saved.data.collections.map(item => item.name)).toEqual(['绝区零 · 人物与称谓']);
      const entry = saved.data.entries[0];
      expect(entry).toMatchObject({ kind: 'term', state: 'ready', payload: { source: SOURCE, target: TARGET } });
      expect(saved.approvals[entry.id]).toMatchObject({ method: 'human', revision: entry.revision });
      await uiExpect(panel.getByText('已保存到「绝区零 · 人物与称谓」')).toBeVisible();
      const event = requests.at(-1)!.input.filter(item => item.role === 'user').at(-1)!;
      expect(JSON.stringify(event.content)).toContain('[FusionKit UI event]');
      await shot('02-card-saved-dock-1280-light');

      // The receipt opens the library on that collection; the panel there knows the page.
      await card.getByTestId('knowledge-open-collection').click();
      await page.getByTestId('knowledge-all').waitFor();
      await uiExpect(page.locator('#knowledge-content-heading h2')).toHaveText('绝区零 · 人物与称谓');
      await uiExpect(page.getByText(TARGET).first()).toBeVisible();
      // The panel stays open across the navigation it started.
      await uiExpect(page.getByTestId('agent-dock-launcher')).toHaveAttribute('aria-expanded', 'true');
      await uiExpect(page.getByTestId('agent-dock-page')).toHaveText('翻译资料 · 绝区零 · 人物与称谓');
      await shot('03-library-focused-1280-light');
      // The page context reaches the agent with the visible entry.
      queue.push(text('当前资料集里有 1 条术语。'));
      await page.getByTestId('agent-dock-input').fill('这里现在有什么？');
      await page.getByTestId('agent-dock-input').press('Enter');
      await expect.poll(() => requests.at(-1)?.instructions.includes('"route":"/tools/translation-knowledge"')).toBe(true);
      expect(requests.at(-1)!.instructions).toContain(`${SOURCE} → ${TARGET}`);
      expect(requests.at(-1)!.instructions).toContain(entry.id);
      // An unknown collection id does not move the page.
      await page.getByTestId('agent-dock-minimize').click();

      // Every row shape, on the home page: existing, conflict, required, long text, rule and background.
      await page.evaluate(() => { location.hash = '/'; }); await page.getByTestId('home-agent').waitFor();
      queue.push(call('prepare_knowledge_changes', sampleProposal(saved.data.collections[0].id)));
      queue.push(text('我整理了地名与组织，部分是根据我的了解推断的，请核对后保存。'));
      await page.getByTestId('agent-input').fill('再帮我整理一批地名和组织');
      await page.getByTestId('agent-input').press('Enter');
      const home = page.getByTestId('home-agent');
      const sample = home.getByTestId('agent-prepared-action').last();
      await uiExpect(sample).toHaveAttribute('data-action-status', 'ready');
      await uiExpect(sample.getByTestId('knowledge-change-row')).toHaveCount(6);
      // The new collection is listed first, then the entries; the first entry is already saved.
      await uiExpect(sample.getByTestId('knowledge-change-row').nth(0)).toContainText('绝区零 · 地名与组织');
      await uiExpect(sample.getByTestId('knowledge-change-row').nth(1)).toHaveAttribute('data-status', 'exists');
      await uiExpect(sample.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      await uiExpect(sample.getByTestId('knowledge-change-warning').first()).toContainText('「绝区零 · 人物与称谓」中译为「泰姆菲尔德家的大小姐」');
      await toBottom();
      await shot('04-sample-ready-home-1280-light');
      await sample.getByTestId('knowledge-changes-more').click();
      await uiExpect(sample.getByTestId('knowledge-change-row')).toHaveCount(11);
      await shot('05-sample-expanded-home-1280-light', sample);
      // Keyboard: the switch toggles with Space and the buttons are reachable.
      await sample.getByRole('switch').focus();
      await page.keyboard.press('Space');
      await uiExpect(sample.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Space');
      await uiExpect(sample.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

      // Narrow dark panel over a tool page shows the same card.
      await win.evaluate(window => window.setSize(786, 660));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.evaluate(() => { location.hash = '/tools/translation-knowledge'; }); await page.getByTestId('knowledge-all').waitFor();
      await openDock();
      const narrow = page.getByTestId('agent-dock-panel').getByTestId('agent-prepared-action').last();
      await toBottom(page.getByTestId('agent-dock-panel'));
      await uiExpect(narrow).toBeVisible();
      await shot('06-sample-ready-dock-786-dark');
      const overflow = await narrow.evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      // A change underneath an edit fails the whole save; nothing is written.
      queue.push(call('prepare_knowledge_changes', { entries: [{ action: 'update', entryId: entry.id, revision: entry.revision, target: '泰姆菲尔德大小姐', basis: 'user_stated' }] }));
      queue.push(text('已准备修改，请确认。'));
      await page.getByTestId('agent-dock-input').fill('把那条改成泰姆菲尔德大小姐');
      await page.getByTestId('agent-dock-input').press('Enter');
      const edit = page.getByTestId('agent-dock-panel').getByTestId('agent-prepared-action').last();
      await uiExpect(edit).toHaveAttribute('data-action-status', 'ready');
      await uiExpect(edit).toContainText('「绝区零 · 人物与称谓」中：修改 1 条');
      // The older sample card was replaced by this one.
      await uiExpect(page.getByTestId('agent-dock-panel').locator('[data-testid=agent-prepared-action][data-action-status=ready]')).toHaveCount(1);
      await page.evaluate(async id => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const target = current.value.data.entries.find(item => item.id === id)!;
        const result = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [{ group: 'entries', record: { ...target, title: 'changed elsewhere' } }] });
        if (!result.ok) throw new Error(result.error);
      }, entry.id);
      const before = await library();
      queue.push(text('资料在准备后被修改了，没有保存。需要我重新准备吗？'));
      await edit.getByRole('button', { name: '确认保存' }).click();
      await uiExpect(edit).toHaveAttribute('data-action-status', 'failed');
      await uiExpect(edit).toContainText('资料在准备后被修改');
      expect((await library()).generation).toBe(before.generation);
      await shot('07-edit-failed-dock-786-dark');

      // English interface: a fresh conversation shows the card in English.
      await win.evaluate(window => window.setSize(1280, 860));
      await configure('en', 'light', '/');
      await page.reload(); await page.getByTestId('home-agent').waitFor(); await ready();
      queue.push(call('prepare_knowledge_changes', sampleProposal(saved.data.collections[0].id)));
      queue.push(text('Prepared the places and organizations; please review before saving.'));
      await page.getByTestId('agent-input').fill('Organize the places and organizations');
      await page.getByTestId('agent-input').press('Enter');
      const english = page.getByTestId('home-agent').getByTestId('agent-prepared-action').last();
      await uiExpect(english).toHaveAttribute('data-action-status', 'ready');
      await uiExpect(english).toContainText('Save to translation knowledge');
      await uiExpect(english.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await toBottom();
      await shot('08-sample-ready-home-1280-en');
      await english.getByRole('button', { name: 'Don’t save' }).click();
      await uiExpect(english).toHaveAttribute('data-action-status', 'dismissed');
      expect((await library()).data.collections).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 240000);
});
