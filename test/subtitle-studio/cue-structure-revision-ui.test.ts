import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';

/** The user's file around the reported repetition, and a second repetition further on. */
const PAIRS: [string, string, string][] = [
  ['00:02.420', '先輩、おはようございます。', '前辈，早上好。'],
  ['00:08.020', 'って、もう眠そうじゃないですか。', '话说，你看起来已经很困了嘛。'],
  ['00:11.020', 'まだ朝なのに。', '明明还是早上。'],
  ['00:13.020', 'ん?なんですか?', '嗯？怎么了？'],
  ['00:15.970', '君は白鸽だから?', '因为你是白鸽吗？'],
  ['00:18.770', '朝元気なだけ?', '只是早上比较有精神？'],
  ['00:20.770', 'そんなことないです。', '才不是那样。'],
  ['00:22.770', '私の知り合いで同じ種族の住人の白鸽とかスズメさんにも、', '我认识的人里，同族的居民白鸽和麻雀当中，'],
  ['00:26.780', '先輩みたいに朝から眠そうにしてる方、', '像前辈这样一大早就犯困的，'],
  ['00:27.500', '先輩みたいに朝から眠そうにしてる方', '像前辈这样一大早就犯困的'],
  ['00:29.860', 'いますもん', '也是有的。'],
  ['00:31.760', '別に人間だからとか', '并不是因为是人类还是别的什么，'],
  ['00:33.220', '別に人間だからとか', '并不是因为是人类'],
  ['00:35.460', 'ご視聴ありがとうございました', '感谢观看'],
];

function stream(events: Record<string, unknown>[]) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const say = (value: string) => [{ type: 'response.output_text.delta', delta: value }];
let calls = 0;
function call(name: string, args: unknown) {
  const id = `structure-${name}-${++calls}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('structure fixes from AI revision and the assistant', () => {
  it('finds repeated lines, applies chosen merges and deletions from the model, and the assistant prepares a merge', async () => {
    const artifacts = path.resolve('test-results/studio-cue-structure-revision'); await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, 'run-'));
    const file = path.join(root, '01某邮局的工作 - ある郵便局のお仕事.lrc');
    await writeFile(file, PAIRS.map(([time, ja, zh]) => `[${time}]${ja}\n[${time}]${zh}\n`).join(''));
    let app: ElectronApplication | undefined; let server: Server | undefined;
    const agentQueue: Record<string, unknown>[][] = [];
    const agentRequests: { input: { type?: string; role?: string; content?: unknown; output?: string }[] }[] = [];
    const revisionRequests: { items: { id: string; source: string }[] }[] = [];
    const errors: string[] = [];
    try {
      server = createServer(async (request, response) => {
        let body = ''; for await (const part of request) body += part.toString();
        const parsed = JSON.parse(body);
        if (parsed.input) {
          agentRequests.push(parsed);
          response.setHeader('Content-Type', 'text/event-stream');
          response.end(stream(agentQueue.shift() ?? say('好的。')));
          return;
        }
        // The revision model: merge the two "別に人間だからとか" lines and delete the closing line.
        const payload = JSON.parse(parsed.messages[1].content);
        const answer = (content: unknown) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
        };
        // A whole-document request first asks how to find the lines: every line.
        if (!payload.items) { answer({ strategy: 'all' }); return; }
        revisionRequests.push(payload);
        const id = (source: string) => payload.items.find((item: { source: string }) => item.source === source)?.id;
        const twice = payload.items.filter((item: { source: string }) => item.source === '別に人間だからとか').map((item: { id: string }) => item.id);
        const content = { items: [], merge: twice.length === 2 ? [{ ids: twice, source: '別に人間だからとか', target: '并不是因为是人类还是别的什么，' }] : [],
          delete: [id('ご視聴ありがとうございました')].filter(Boolean), note: '合并了重复的一句，删除了片尾语。' };
        answer(content);
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => { window.setSize(1280, 860); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
      await page.evaluate(port => {
        const profile = { id: 'structure-agent', name: 'Controlled agent', provider: 'Other', apiKey: 'synthetic-agent-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'agent-model', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } };
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'structure-task', name: 'Controlled task', apiFormat: 'chat_completions' }], assignment: { agent: 'structure-agent', taskExecution: 'structure-task' }, audioProfiles: [], audioAssignment: {} } }));
        location.hash = '/tools/subtitle/studio';
      }, port);
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const shot = async (name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
      const rows = page.locator('.studio-cue-table tbody tr');
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, file);
      await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
      await uiExpect(rows).toHaveCount(PAIRS.length);

      // No model: the repeated lines of the whole document, one merge each.
      await page.getByTestId('studio-cue-toolbar-revise').click();
      const dialog = page.getByRole('dialog', { name: 'AI 修订' });
      await dialog.getByTestId('studio-cue-revision-duplicates').click();
      const items = dialog.getByTestId('studio-cue-structure-item');
      await uiExpect(items).toHaveCount(2);
      await uiExpect(dialog.getByTestId('studio-cue-revision-summary')).toHaveText('建议修改：合并 2 处（共检查 14 条）');
      await uiExpect(dialog.locator('.studio-cue-revision-footnote')).not.toContainText('tokens');
      await uiExpect(items.nth(0)).toContainText('9–10');
      await uiExpect(items.nth(0)).toContainText('先輩みたいに朝から眠そうにしてる方、');
      await uiExpect(items.nth(0)).toContainText('像前辈这样一大早就犯困的，');
      await uiExpect(items.nth(0)).toContainText('00:00:26.780 → 结束时间未知');
      // The second pair: one translation holds the other, so the fuller one is kept and stays current.
      await uiExpect(items.nth(1).locator('[data-field=target]')).toHaveText('并不是因为是人类还是别的什么，');
      expect(revisionRequests).toHaveLength(0);
      await shot('01-duplicates-1280-light');
      await items.nth(1).getByRole('checkbox').click();
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(rows).toHaveCount(PAIRS.length - 1);
      await uiExpect(rows.nth(8).locator('[data-field=source]')).toHaveText('先輩みたいに朝から眠そうにしてる方、');
      await uiExpect(page.getByTestId('studio-cue-undo')).toHaveAccessibleName('撤销：AI 修订 2 条字幕');
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows).toHaveCount(PAIRS.length);

      // The model: a merge and a deletion it proposes, each a row that can be left out.
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await dialog.getByTestId('studio-cue-revision-scope-document').click();
      await dialog.getByTestId('studio-cue-revision-instructions').fill('合并重复识别的句子，删掉片尾语');
      await dialog.getByTestId('studio-cue-revision-generate').click();
      await uiExpect(items).toHaveCount(2);
      await uiExpect(items.nth(0)).toHaveAttribute('data-kind', 'merge');
      await uiExpect(items.nth(1)).toHaveAttribute('data-kind', 'delete');
      await uiExpect(dialog.getByTestId('studio-cue-revision-summary')).toContainText('合并 1 处、删除 1 条');
      await uiExpect(dialog.getByTestId('studio-cue-revision-note')).toContainText('合并了重复的一句');
      await shot('02-model-structure-1280-light');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(dialog).toBeHidden();
      await uiExpect(rows).toHaveCount(PAIRS.length - 2);
      await uiExpect(rows.nth(11).locator('[data-field=target]')).toContainText('并不是因为是人类还是别的什么，');
      await uiExpect(page.getByText('ご視聴ありがとうございました')).toHaveCount(0);
      await page.getByTestId('studio-cue-list').focus();
      await page.keyboard.press('Control+z');
      await uiExpect(rows).toHaveCount(PAIRS.length);

      // The assistant: "合并第 9、10 条" becomes a prepared merge in the preview, without a revision request.
      const before = revisionRequests.length;
      agentQueue.push(call('studio_prepare_cue_edits', { edits: [{ kind: 'merge', from: 9, to: 10 }] }));
      agentQueue.push(say('已在 AI 修订预览中准备好合并第 9–10 条，请确认后应用。'));
      const launcher = page.getByTestId('agent-dock-launcher');
      if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click();
      await page.getByTestId('agent-dock-input').fill('把第 9、10 条合并，它们重复了');
      await page.getByTestId('agent-dock-input').press('Enter');
      await uiExpect(dialog.getByTestId('studio-cue-revision-prepared')).toBeVisible();
      await uiExpect(items).toHaveCount(1);
      await uiExpect(dialog.getByTestId('studio-cue-revision-summary')).toHaveText('已准备：合并 1 处');
      expect(revisionRequests.length).toBe(before);
      await page.getByTestId('agent-dock-minimize').click({ timeout: 2000 }).catch(() => {});
      await shot('03-agent-prepared-1280-light');
      await dialog.getByTestId('studio-cue-revision-apply').click();
      await uiExpect(rows).toHaveCount(PAIRS.length - 1);
      // Nothing to follow up on by itself; the assistant learns what was applied with the next message.
      const launcherAgain = page.getByTestId('agent-dock-launcher');
      if (await launcherAgain.getAttribute('aria-expanded') !== 'true') await launcherAgain.click();
      agentQueue.push(say('第 9–10 条已合并为一条。'));
      await page.getByTestId('agent-dock-input').fill('好了吗？');
      await page.getByTestId('agent-dock-input').press('Enter');
      await expect.poll(() => JSON.stringify(agentRequests.at(-1)?.input ?? [])).toContain('1 merge(s)');
      await page.getByTestId('agent-dock-minimize').click({ timeout: 2000 }).catch(() => {});

      // Narrow and dark: the structure rows wrap inside the preview.
      await win.evaluate(window => window.setSize(786, 660));
      await uiExpect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(900);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.getByTestId('studio-cue-toolbar-revise').click();
      await dialog.getByTestId('studio-cue-revision-duplicates').click();
      await uiExpect(items).toHaveCount(1);
      await shot('04-duplicates-786-dark');
      const overflow = await items.first().evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await app?.close();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    }
  }, 240000);
});
