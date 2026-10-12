import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import home from '../src/locales/zh/home.json';

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
const format = (value: string, values: Record<string, string | number>) => value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key]));

const SOURCE = 'テイムフィールド家のお嬢様';
const TARGET = '泰姆菲尔德家的大小姐';
const RULE = '称谓“お嬢様”统一译为“大小姐”，不译作“小姐”。';
const COMMON = 'A · 通用称谓';
const pair = { source: 'ja', target: 'zh-Hans' };
/** The proposal for "记到绝区零资料": a new collection named after the work, the user's wording and what the agent inferred. */
const zzzProposal = (commonId: string) => ({
  collections: [{ ref: 'zzz', name: '绝区零', description: '角色、家族与称谓的中文译名', languagePair: pair }],
  entries: [
    { action: 'create', collection: { ref: 'zzz' }, kind: 'term', source: SOURCE, target: TARGET, basis: 'user_stated', evidence: '应该是泰姆菲尔德家的大小姐' },
    { action: 'create', collection: { ref: 'zzz' }, kind: 'term', source: 'ホロウ', target: '空洞', basis: 'agent_inferred' },
    { action: 'create', collection: { id: commonId }, kind: 'rule', text: RULE, basis: 'agent_inferred' },
  ],
});

describe.runIf(process.env.FUSIONKIT_AGENT_KNOWLEDGE_E2E === '1')('agent keeps translation materials', () => {
  it('records the wording in a new 绝区零 collection through a confirmed card, enabled at once, and opens it in the library', async () => {
    const artifacts = path.resolve('test-results/agent-knowledge'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fusionkit-agent-knowledge-'));
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
        // The session title is a side request of its own; it does not take a scripted reply.
        if (String(JSON.parse(body).instructions ?? '').startsWith('You name conversations.')) { response.setHeader('Content-Type', 'text/event-stream'); response.end(stream(text('会话标题'))); return; }
        requests.push(JSON.parse(body));
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(stream(queue.shift() ?? text('好的。')));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page);
      await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); });
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
      const library = () => page.evaluate(async () => { const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(result.error); return result.value; });

      await configure('zh', 'light', '/tools/subtitle/studio');
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor(); await ready();
      // The library holds a general collection, sorted first, but nothing about 绝区零.
      const commonId = await page.evaluate(async name => {
        const current = await window.translationKnowledge.read(); if (!current.ok) throw new Error(current.error);
        const id = crypto.randomUUID();
        const saved = await window.translationKnowledge.saveRecords({ generation: current.value.generation, items: [
          { group: 'collections', record: { id, revision: 1, name, description: '', languagePair: { source: 'ja', target: 'zh-Hans' }, archived: false } }] });
        if (!saved.ok) throw new Error(saved.error);
        return id;
      }, COMMON);
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, input);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(4);

      // The user asks to keep the wording; the agent looks at the catalog, then prepares the change.
      queue.push(call('list_translation_knowledge_catalog', {}));
      queue.push(call('prepare_knowledge_changes', zzzProposal(commonId)));
      queue.push(text('资料库里还没有「绝区零」的资料集，我准备新建一个并记入这条译法，请在卡片上确认保存。'));
      await openDock();
      const panel = page.getByTestId('agent-dock-panel');
      await page.getByTestId('agent-dock-input').fill('把泰姆菲尔德家的大小姐记到绝区零的资料里');
      await page.getByTestId('agent-dock-input').press('Enter');
      const card = panel.getByTestId('agent-prepared-action');
      await uiExpect(card).toBeVisible();
      await uiExpect(card).toHaveAttribute('data-action-status', 'ready');
      await uiExpect(card).toContainText(home.prepared_knowledge_title);
      expect(requests[0].tools.map(item => item.name)).toEqual(expect.arrayContaining(['list_translation_knowledge_catalog', 'prepare_knowledge_changes', 'search_translation_knowledge']));
      const catalog = JSON.parse(requests[1].input.filter(item => item.type === 'function_call_output').at(-1)!.output!);
      expect(catalog).toMatchObject({ success: true, data: { collections: [expect.objectContaining({ id: commonId, name: COMMON, languagePair: pair, entryCount: 0 })] } });
      const prepared = JSON.parse(requests[2].input.filter(item => item.type === 'function_call_output').at(-1)!.output!);
      expect(prepared).toMatchObject({ success: true, data: { executionStatus: 'prepared' } });
      // Confirming is the review: there is no adopt or enable switch on the card.
      await uiExpect(card.getByRole('switch')).toHaveCount(0);
      // The new collection first, then each entry with its kind and collection.
      const rows = card.getByTestId('knowledge-change-row');
      await uiExpect(rows).toHaveCount(4);
      await uiExpect(rows.nth(0)).toContainText('绝区零');
      await uiExpect(rows.nth(0)).toContainText(home.knowledge_kind_collection);
      await uiExpect(rows.nth(1)).toContainText(`${SOURCE}→${home.knowledge_arrow}${TARGET}`);
      await uiExpect(rows.nth(1)).toContainText(home.knowledge_kind_term);
      await uiExpect(rows.nth(1)).toContainText('绝区零');
      await uiExpect(rows.nth(2)).toContainText(`ホロウ→${home.knowledge_arrow}空洞`);
      await uiExpect(rows.nth(2)).toContainText(home.knowledge_kind_term);
      await uiExpect(rows.nth(3)).toContainText(RULE);
      await uiExpect(rows.nth(3)).toContainText(home.knowledge_kind_rule);
      await uiExpect(rows.nth(3)).toContainText(COMMON);
      // What the user said carries no origin tag; what the agent inferred asks to be checked.
      await uiExpect(rows.nth(1).getByTestId('knowledge-change-origin')).toHaveCount(0);
      await uiExpect(rows.nth(2).getByTestId('knowledge-change-origin')).toHaveText(home.knowledge_ai_inferred);
      await uiExpect(rows.nth(3).getByTestId('knowledge-change-origin')).toHaveText(home.knowledge_ai_inferred);
      // Nothing is saved before the user confirms.
      expect((await library()).data.collections.map(item => item.name)).toEqual([COMMON]);
      await shot('01-card-ready-dock-1280-light');

      // Confirming saves everything at once, enabled; the agent hears about it and follows up.
      queue.push(text('已保存到「绝区零」。翻译时在字幕工作台的翻译资料里选用这个资料集即可生效。'));
      await card.getByRole('button', { name: home.knowledge_confirm, exact: true }).click();
      await uiExpect(card).toHaveAttribute('data-action-status', 'completed');
      const changes = [format(home.knowledge_count_collections, { count: 1 }), format(home.knowledge_count_created, { count: 3 })].join(home.knowledge_count_separator);
      await uiExpect(card).toContainText(format(home.knowledge_saved, { changes }));
      const saved = await library();
      const zzz = saved.data.collections.find(item => item.name === '绝区零')!;
      expect(zzz).toMatchObject({ languagePair: pair, archived: false, description: '角色、家族与称谓的中文译名' });
      expect(saved.data.entries).toHaveLength(3);
      expect(saved.data.entries.find(entry => entry.kind === 'term' && entry.payload.source === SOURCE)).toMatchObject({ collectionId: zzz.id, enabled: true, origin: { kind: 'manual' }, payload: { target: TARGET } });
      expect(saved.data.entries.find(entry => entry.kind === 'term' && entry.payload.source === 'ホロウ')).toMatchObject({ collectionId: zzz.id, enabled: true, origin: { kind: 'agent' } });
      expect(saved.data.entries.find(entry => entry.kind === 'rule')).toMatchObject({ collectionId: commonId, enabled: true, origin: { kind: 'agent' }, payload: { text: RULE } });
      await uiExpect(panel.getByText('已保存到「绝区零」')).toBeVisible();
      // The follow-up turn carries the interface event and the saved result.
      const followUp = requests.at(-1)!;
      expect(JSON.stringify(followUp.input.filter(item => item.role === 'user').at(-1)!.content)).toContain('[FusionKit UI event]');
      expect(followUp.instructions).toContain('"executionStatus":"saved"');
      expect(followUp.instructions).toContain(zzz.id);
      await shot('02-card-saved-dock-1280-light');

      // The receipt opens the library with that collection selected, not the first one.
      await card.getByTestId('knowledge-open-collection').click();
      await page.getByTestId('translation-knowledge').waitFor();
      await uiExpect(page).toHaveURL(/#\/tools\/translation-knowledge/);
      await uiExpect(page.getByTestId('knowledge-collection-header').locator('h2')).toHaveText('绝区零');
      await uiExpect(page.locator(`[data-collection-id="${zzz.id}"]`)).toHaveAttribute('aria-current', 'true');
      await uiExpect(page.locator(`[data-collection-id="${commonId}"]`)).not.toHaveAttribute('aria-current', 'true');
      await uiExpect(page.getByTestId('knowledge-term-table')).toContainText(TARGET);
      // The panel stays open across the navigation it started.
      await uiExpect(page.getByTestId('agent-dock-launcher')).toHaveAttribute('aria-expanded', 'true');
      await shot('03-library-focused-1280-light');
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      await rm(root, { recursive: true, force: true });
    }
  }, 240000);
});
