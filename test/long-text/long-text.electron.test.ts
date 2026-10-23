import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import {
  createChatCompletionBody,
  startFakeModelApiServer,
  type CapturedModelApiRequest,
  type FakeModelApiServer,
} from '../ai/fakeModelApiServer';
import { createTestRun } from '../support/testRun';

// ---------------------------------------------------------------------------------------------
// Fixtures (design §9.2). The fake model answers in real Chinese: a translation that still holds
// kana or English words would be flagged `untranslated` (design §7) and every row would need attention.

type Pair = readonly [source: string, translation: string];

const TIMES: Pair[] = [
  ['その夜', '那天夜里'], ['翌朝', '第二天早上'], ['昼過ぎ', '午后'], ['夕方', '傍晚'], ['真夜中', '半夜'], ['雨の日', '下雨的那天'],
  ['風の強い日', '刮大风的那天'], ['静かな午後', '安静的下午'], ['日が暮れる頃', '天快黑的时候'], ['月の明るい晩', '月色明亮的晚上'],
  ['霧の朝', '起雾的早晨'], ['寒い朝', '寒冷的早晨'], ['春の初め', '初春时节'],
];
const PLACES: Pair[] = [
  ['森の奥', '森林深处'], ['川のほとり', '河边'], ['古い図書館', '旧图书馆里'], ['丘の上', '山丘上'], ['静かな駅', '安静的车站'],
  ['小さな橋', '小桥上'], ['市場の角', '集市的拐角'], ['祖母の家', '祖母家里'], ['港の近く', '港口附近'], ['学校の裏庭', '学校后院'],
  ['湖の岸', '湖岸边'], ['時計台の下', '钟楼下面'], ['村はずれ', '村子外头'],
];
const ACTIONS: Pair[] = [
  ['小さな灯りを見つけた', '发现了一盏小灯'], ['古い地図を広げた', '摊开了一张旧地图'], ['誰かの足音を聞いた', '听见了谁的脚步声'],
  ['手紙を読み返した', '把信又读了一遍'], ['空を長いあいだ見上げていた', '久久地仰望着天空'], ['友だちの名前を呼んだ', '喊了朋友的名字'],
  ['冷たい水で顔を洗った', '用冷水洗了脸'], ['鍵をそっと拾い上げた', '轻轻捡起了钥匙'], ['温かいお茶を飲んだ', '喝了一杯热茶'],
  ['青い鳥の羽を見つけた', '找到了一根蓝色的鸟羽'], ['扉の向こうをのぞいた', '朝门那边看了一眼'], ['静かに歌を口ずさんだ', '轻声哼起了歌'],
  ['帳面に何かを書き留めた', '在本子上记下了什么'],
];
const CHAPTERS: Pair[] = [['第一章　夜の森', '第一章　夜之森'], ['第二章　川の声', '第二章　河之声'], ['第三章　朝の鐘', '第三章　晨钟']];
/** Answered with one character: `length_short`, below the 40 characters that would reject it instead. */
const SHORT_ME: Pair = ['SHORT_ME　アリスは小さな声で歌を口ずさんだ。', '短'];
/** Left out of every batch it is in, so the runner halves the batch down to this one segment. */
const SPLIT_ME: Pair = ['SPLIT_ME　川のほとりで、アリスは古い舟を見つけた。', 'SPLIT_ME　在河边，爱丽丝发现了一条旧船。'];
/** Answered empty until the test lets it through: it fails, then "重试" translates it. */
const FAIL_ME: Pair = ['FAIL_ME　遠くから鐘の音が聞こえてくる朝だった。', 'FAIL_ME　那是一个远处传来钟声的早晨。'];
const PARAGRAPHS_PER_CHAPTER = 13;
const SPECIAL: Record<string, Pair> = { '0:2': SHORT_ME, '1:4': SPLIT_ME, '2:3': FAIL_ME };
/** The row retranslated with "更口语". */
const COLLOQUIAL = { chapter: 0, paragraph: 5 };

function paragraph(chapter: number, index: number): Pair {
  const special = SPECIAL[`${chapter}:${index}`];
  if (special) return special;
  const [time, place, action] = [TIMES[(index + chapter * 5) % 13], PLACES[(index * 2 + chapter) % 13], ACTIONS[(index * 3 + chapter * 2) % 13]];
  return [`${time[0]}、アリスは${place[0]}で${action[0]}。`, `${time[1]}，爱丽丝在${place[1]}${action[1]}。`];
}

const NOVEL_CHAPTERS = CHAPTERS.map((heading, chapter) =>
  [heading, ...Array.from({ length: PARAGRAPHS_PER_CHAPTER }, (_, index) => paragraph(chapter, index))]);
const NOVEL_TEXT = NOVEL_CHAPTERS.map(chapter => chapter.map(([source]) => source).join('\n\n')).join('\n\n') + '\n';
const NOVEL_TRANSLATIONS = new Map(NOVEL_CHAPTERS.flat());

const STEPS = Array.from({ length: 30 }, (_, index) => `${index + 1}. Step ${index + 1} checks the value in the panel and saves it.`);
const GUIDE_CODE = '```js\nconst answer = 42; // keep me\nconsole.log(`answer: ${answer}`);\n```';
const GUIDE_TEXT = [
  '# Quick guide',
  'This guide explains how to translate a long document with **your own model** while the `layout` stays intact.  \nA hard break keeps this line under the first one.',
  '## Before you start',
  '- Open the settings and choose a model.\n- Import a text file or paste some text.\n  - Nested items keep their indent.\n- Run a sample first and check the style.',
  '| Option | Meaning |\n| --- | --- |\n| Pace | How many requests run at once |\n| Batch size | How much text one request carries |',
  GUIDE_CODE,
  'Read [the full guide](https://example.com/guide?lang=en#start) for more details.',
  '## Steps',
  STEPS.join('\n'),
].join('\n\n') + '\n';

const WORDS: Record<string, string> = {
  quick: '快速', guide: '指南', this: '本', explains: '说明', how: '如何', to: '', translate: '翻译', a: '一篇', long: '长',
  document: '文档', with: '用', your: '你的', own: '自己的', model: '模型', while: '同时', the: '', stays: '保持', intact: '完整',
  hard: '硬', break: '换行', keeps: '让', line: '这一行', under: '位于', first: '第一', one: '一个', before: '开始之前', you: '你',
  start: '开始', open: '打开', settings: '设置', and: '并', choose: '选择', import: '导入', text: '文本', file: '文件', or: '或',
  paste: '粘贴', some: '一些', nested: '嵌套', items: '条目', keep: '保留', their: '它们的', indent: '缩进', run: '运行',
  sample: '试译', check: '检查', style: '风格', option: '选项', meaning: '含义', pace: '节奏', many: '多少', requests: '请求',
  at: '', once: '同时', batch: '批量', size: '大小', much: '多少', request: '请求', carries: '携带', read: '阅读', full: '完整的',
  for: '了解', more: '更多', details: '细节', steps: '步骤', step: '步骤', checks: '检查', value: '数值', in: '在', panel: '面板',
  saves: '保存', it: '它', pasted: '粘贴的', note: '笔记', paragraph: '段落', is: '是', short: '简短',
};
/** Inline tokens of the batch protocol, which the model copies unchanged (design §6.4.3). */
const TOKEN = /(<\/?m\d+>|<x\d+\/>)/;

/** English words to Chinese ones, outside the tokens; the spaces around Chinese words go away. */
function hanOf(text: string): string {
  return text.split(TOKEN).map((part, index) => index % 2 ? part : part
    .replace(/[A-Za-z]+/g, word => WORDS[word.toLowerCase()] ?? '词')
    .replace(/\s*(\p{Script=Han}+)\s*/gu, '$1')).join('');
}

interface BatchPayload { items: Array<{ id: string; text: string }>; revision?: { request?: string; currentTranslation?: string } }

function payloadOf(request: CapturedModelApiRequest): BatchPayload {
  const messages = request.body.messages as Array<{ role: string; content: string }>;
  return JSON.parse(messages[messages.length - 1]!.content) as BatchPayload;
}

const hasKana = (text: string) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// The app

/** The app's environment: the built renderer, the test window mode kept, no forced onboarding. */
function env(): Record<string, string> {
  const value: Record<string, string> = { VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' };
  for (const [key, entry] of Object.entries(process.env)) {
    if (entry !== undefined && !(key in value) && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'FUSIONKIT_TEST_ONBOARDING') value[key] = entry;
  }
  return value;
}

async function waitForApp(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.locator('[data-testid=long-text]').waitFor();
  await page.waitForTimeout(400);
}

type Observed = typeof globalThis & { __longTextRows?: number };

/** Mocks the native dialogs and the file manager, and records the most rows one read returned. */
async function instrument(app: ElectronApplication, files: string[], folder: string) {
  await app.evaluate(({ dialog, ipcMain, shell }, { files, folder }) => {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as Electron.OpenDialogOptions;
      return { canceled: false, filePaths: options.properties?.includes('openDirectory') ? [folder] : files };
    }) as typeof dialog.showOpenDialog;
    shell.showItemInFolder = () => undefined;
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const observed = globalThis as Observed;
    observed.__longTextRows = 0;
    for (const channel of ['long-text:read-page', 'long-text:query']) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing handler ${channel}`);
      handlers.set(channel, async (event, ...args) => {
        const result = await original(event, ...args) as { ok: boolean; value?: { rows: unknown[] } };
        if (result.ok && result.value) observed.__longTextRows = Math.max(observed.__longTextRows ?? 0, result.value.rows.length);
        return result;
      });
    }
  }, { files, folder });
}

async function seed(page: Page, baseUrl: string, theme: 'light' | 'dark') {
  await page.evaluate(({ baseUrl, theme }) => {
    localStorage.clear();
    localStorage.setItem('lang', 'zh');
    localStorage.setItem('fusionkit-onboarding', JSON.stringify({ state: { status: 'dismissed' }, version: 0 }));
    localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    localStorage.setItem('fusionkit-model', JSON.stringify({
      version: 6,
      state: {
        profiles: [{
          id: 'long-text-e2e', name: 'DeepSeek V4', provider: 'DeepSeek', apiKey: 'long-text-e2e-placeholder', baseUrl,
          modelKey: 'deepseek-chat', apiFormat: 'chat_completions', outputTokenParameter: 'max_tokens',
          tokenPricing: { inputTokensPerMillion: 0.27, outputTokensPerMillion: 1.1 },
        }],
        assignment: { agent: null, taskExecution: 'long-text-e2e' },
      },
    }));
    location.hash = '/tools/text/translator';
  }, { baseUrl, theme });
  await page.reload();
  await waitForApp(page);
}

/** OS-backed Files dropped on the page, as Explorer would (the preload captures their paths). */
async function dropFiles(page: Page, files: string[]) {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.dataset.longTextDrop = '';
    document.body.append(input);
  });
  await page.locator('[data-long-text-drop]').setInputFiles(files);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-long-text-drop]')!;
    const target = document.querySelector('[data-testid=long-text]')!;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    input.remove();
  });
}

async function attentionCount(page: Page): Promise<number> {
  const label = await page.getByRole('tab', { name: /^需关注/ }).getAttribute('aria-label');
  return Number(label?.match(/\d+/)?.[0] ?? NaN);
}

async function noHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
    && [...document.querySelectorAll('[data-slot=tool-detail-layout] main, [data-slot=tool-panel-header], [data-slot=tool-file-picker], [data-testid=long-text-toolbar]')]
      .every(element => element.scrollWidth <= element.clientWidth + 1));
}

// ---------------------------------------------------------------------------------------------

describe.runIf(process.env.FUSIONKIT_LONG_TEXT_E2E === '1')('Long text translator in Electron', () => {
  let app: ElectronApplication | undefined;
  let server: FakeModelApiServer | undefined;

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await server?.close().catch(() => undefined);
    }
  });

  it('imports, samples, translates, reviews, exports, resumes after a restart and deletes', async () => {
    const run = await createTestRun(path.resolve('test-results/long-text'));
    const input = path.join(run, 'input');
    const out = path.join(run, 'out');
    await mkdir(input, { recursive: true });
    await mkdir(out, { recursive: true });
    const novelPath = path.join(input, 'novel.txt');
    const legacyPath = path.join(input, 'legacy.txt');
    const guidePath = path.join(input, 'guide.md');
    const memoPath = path.join(input, 'memo.txt');
    const zhSample = await readFile(path.resolve('test/long-text/fixtures/encoding/zh-hans.txt'), 'utf8');
    await writeFile(novelPath, NOVEL_TEXT);
    await writeFile(legacyPath, iconv.encode(zhSample, 'gb18030'));
    await writeFile(guidePath, GUIDE_TEXT);
    // Too few characters to be sure of the encoding: the encoding check stops its runs.
    await writeFile(memoPath, iconv.encode('备忘：明天上午十点开会。\n', 'gb18030'));
    const picked = [novelPath, legacyPath, guidePath];
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(run, `${name}.png`) });

    // The fake model: a gate holds requests (pause, interruption); FAIL_ME stays empty until allowed.
    const model = { gate: null as Promise<void> | null, open: () => {}, passes: 0, failing: true };
    const hold = (passes = 0) => {
      model.gate = new Promise<void>(resolve => { model.open = resolve; });
      model.passes = passes;
    };
    const release = () => {
      model.open();
      model.gate = null;
    };
    const translate = (text: string, payload: BatchPayload) => {
      if (text.includes('FAIL_ME') && model.failing) return '';
      const translation = NOVEL_TRANSLATIONS.get(text) ?? hanOf(text);
      return payload.revision?.request ? `【口语】${translation}` : translation;
    };
    server = await startFakeModelApiServer();
    const answer = async (request: CapturedModelApiRequest) => {
      const payload = payloadOf(request);
      const gate = model.gate;
      if (gate) {
        if (model.passes > 0) model.passes--;
        else await gate;
      }
      const items = payload.items
        .filter(item => payload.items.length === 1 || !item.text.includes('SPLIT_ME'))
        .map(item => ({ id: item.id, text: translate(item.text, payload) }));
      const terms = payload.items.some(item => item.text.includes('アリス')) ? [{ source: 'アリス', target: '爱丽丝' }] : [];
      const size = payload.items.reduce((sum, item) => sum + item.text.length, 0);
      return {
        body: createChatCompletionBody({
          content: JSON.stringify({ items, terms }),
          usage: { prompt_tokens: 400 + size * 2, completion_tokens: size * 2, total_tokens: 400 + size * 4 },
        }),
      };
    };
    for (let index = 0; index < 400; index++) server.enqueueRoute('chat_completions', answer);
    const requests = () => server!.requests.filter(request => request.route === 'chat_completions').map(payloadOf);

    const errors: string[] = [];
    const launch = async () => {
      app = await electron.launch({
        args: ['.', `--user-data-dir=${path.join(run, 'profile')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
        cwd: process.cwd(),
        env: env(),
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', error => errors.push(error.message));
      await instrument(app, picked, out);
      const window = await app.browserWindow(page);
      await window.evaluate(win => win.setSize(1280, 860));
      return page;
    };
    let page = await launch();
    const reader = () => page.getByTestId('long-text-reader');
    const rows = () => reader().locator('[data-row-index]');
    const row = (text: string) => rows().filter({ hasText: text }).first();
    const primary = () => page.getByTestId('long-text-primary');
    const libraryRow = (name: string) => page.getByTestId('long-text-library-row').filter({ hasText: name });
    const maxRows = () => app!.evaluate(() => (globalThis as Observed).__longTextRows ?? 0);
    /** Jumps to a page (1-based) with the footer's page picker. */
    const showPage = async (number: number) => {
      await page.getByTestId('long-text-page-picker').click();
      await page.getByTestId('long-text-page-picker-content').locator('input').fill(String(number));
      await page.keyboard.press('Enter');
      await uiExpect(page.getByTestId('long-text-page-picker')).toHaveAttribute('aria-label', new RegExp(`: ${number} `));
    };

    // 1. Empty state: one heading, one drop target, 12px insets, nothing overflows.
    await seed(page, server.baseUrl, 'light');
    await uiExpect(page.locator('h1')).toHaveCount(1);
    await uiExpect(page.getByTestId('long-text-start')).toBeVisible();
    await uiExpect(page.locator('[data-tool-file-drop-target]:visible')).toHaveCount(1);
    const insets = await page.locator('[data-slot=tool-panel-header], [data-slot=tool-file-picker]').evaluateAll(elements => elements
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => { const style = getComputedStyle(element); return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]; }));
    expect(insets.length).toBeGreaterThan(0);
    for (const inset of insets) expect(inset).toEqual(['12px', '12px', '12px', '12px']);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shot(page, '01-empty');

    // 2. The picker imports the three files; the novel opens on its first page.
    await page.getByTestId('long-text-picker').getByRole('button', { name: '选择文件' }).click();
    await uiExpect(page.getByTestId('long-text-library-row')).toHaveCount(3);
    await uiExpect(libraryRow('novel.txt')).toHaveAttribute('aria-current', 'true');
    let title = page.getByTestId('long-text-reader-title');
    await uiExpect(title).toContainText('novel.txt');
    await uiExpect(title).toContainText('TXT');
    await uiExpect(title).toContainText('UTF-8');
    await uiExpect(rows()).toHaveCount(PARAGRAPHS_PER_CHAPTER + 1);
    await uiExpect(row(SHORT_ME[0])).toBeVisible();
    await shot(page, '02-imported');

    // 3. GB18030 is recognised; a dropped short file is not sure of its encoding, which blocks runs.
    await libraryRow('legacy.txt').click();
    await uiExpect(title).toContainText('legacy.txt');
    await uiExpect(title).toContainText('GB18030');
    await uiExpect(page.getByTestId('long-text-notice-encoding')).toHaveCount(0);
    await dropFiles(page, [memoPath]);
    await uiExpect(page.getByTestId('long-text-library-row')).toHaveCount(4);
    await uiExpect(title).toContainText('memo.txt');
    const encodingNotice = page.getByTestId('long-text-notice-encoding');
    await uiExpect(encodingNotice).toBeVisible();
    await shot(page, '03-encoding-notice');
    const sent = requests().length;
    await page.getByTestId('long-text-sample').click();
    await uiExpect(encodingNotice).toHaveAttribute('data-flash', 'true');
    await sleep(500);
    expect(requests().length).toBe(sent);
    await encodingNotice.getByRole('button', { name: '编码正确' }).click();
    await uiExpect(encodingNotice).toHaveCount(0);

    // 4. Pasted text becomes a document of its own.
    await page.getByTestId('long-text-paste').click();
    await page.getByTestId('long-text-paste-text').fill('This pasted note is short.\n\nOpen the panel and check the value.');
    await shot(page, '04-paste-dialog');
    await page.getByTestId('long-text-paste-submit').click();
    await uiExpect(page.getByTestId('long-text-library-row')).toHaveCount(5);
    await uiExpect(title).toContainText('粘贴');
    await uiExpect(rows()).toHaveCount(2);

    // 5. The settings show one source language: the materials picker's own row is hidden.
    await libraryRow('novel.txt').click();
    await uiExpect(title).toContainText('novel.txt');
    await page.getByTestId('long-text-settings-summary').click();
    const settings = page.getByTestId('long-text-settings');
    await uiExpect(settings).toBeVisible();
    await uiExpect(page.getByTestId('long-text-settings-source')).toBeVisible();
    await uiExpect(page.locator('[role=dialog] [data-testid=studio-materials-source]')).toBeHidden();
    await uiExpect(page.locator('[role=dialog]').getByText('原文语言', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await page.waitForTimeout(300);
    await shot(page, '05-settings');
    await page.keyboard.press('Escape');
    await uiExpect(settings).toHaveCount(0);

    // 6. The estimate, then a sample of the first rows.
    let status = page.getByTestId('long-text-status');
    await uiExpect(status).toContainText('待翻译');
    await uiExpect(status).toContainText('Token');
    await uiExpect(status).toContainText('将使用');
    await page.getByTestId('long-text-sample').click();
    const sampleNotice = page.getByTestId('long-text-notice-sample');
    await uiExpect(sampleNotice).toBeVisible();
    for (const index of [0, 1, 2]) await uiExpect(rows().nth(index)).toHaveAttribute('data-status', 'done');
    await uiExpect(row(SHORT_ME[0])).toHaveAttribute('data-status', 'done');
    await shot(page, '06-sampled');

    // 7. The full run with progress; pausing waits for the requests in flight, then it continues.
    hold();
    await sampleNotice.getByRole('button', { name: '翻译全文' }).click();
    await uiExpect(page.getByTestId('long-text-run-state')).toBeVisible();
    await uiExpect(reader().locator('[data-status=translating]').first()).toBeVisible();
    await uiExpect(status).toContainText('正在翻译');
    await shot(page, '07-translating');
    await primary().click();
    await uiExpect(primary()).toHaveText('正在暂停…');
    await uiExpect(page.getByTestId('long-text-stop-now')).toBeVisible();
    // One request per lane: the first page's rest and the second page.
    await uiExpect(status).toContainText('等待 2 个请求完成');
    release();
    await uiExpect(primary()).toHaveText(/继续翻译/);
    await uiExpect(status).toContainText('已暂停');
    await shot(page, '08-paused');
    await primary().click();
    await uiExpect(primary()).toHaveText(/重试失败的 1 段/, { timeout: 60_000 });
    await uiExpect(page.getByTestId('long-text-notice-run-end')).toContainText('1 段未能翻译');

    // SPLIT_ME went out alone in the end; the rest of its batch was translated without a retry.
    expect(requests().some(payload => payload.items.length === 1 && payload.items[0]!.text === SPLIT_ME[0])).toBe(true);
    await showPage(2);
    await uiExpect(row(SPLIT_ME[0])).toHaveAttribute('data-status', 'done');
    expect(await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-status')))).toEqual(Array(PARAGRAPHS_PER_CHAPTER + 1).fill('done'));
    expect(await attentionCount(page)).toBe(2);
    expect(await maxRows()).toBeLessThanOrEqual(60);

    // The model's term is in the glossary.
    await page.getByTestId('long-text-ledger').click();
    const ledgerRow = page.getByTestId('long-text-ledger-row').first();
    await uiExpect(ledgerRow.locator('input').first()).toHaveValue('アリス');
    await uiExpect(ledgerRow.locator('input').nth(1)).toHaveValue('爱丽丝');
    await shot(page, '09-ledger');
    await page.keyboard.press('Escape');
    await uiExpect(page.getByTestId('long-text-ledger-dialog')).toHaveCount(0);

    // 8. The attention view: the failed segment is retried and stays listed as handled.
    await page.getByRole('tab', { name: /^需关注/ }).click();
    await uiExpect(rows()).toHaveCount(2);
    const failed = row(FAIL_ME[0]);
    await uiExpect(failed).toHaveAttribute('data-status', 'failed');
    await failed.hover();
    await shot(page, '10-attention');
    model.failing = false;
    await failed.getByTestId('long-text-row-retranslate').click();
    await uiExpect(failed).toHaveAttribute('data-status', 'done');
    await uiExpect(failed).toContainText(FAIL_ME[1]);
    await uiExpect(failed.getByTestId('long-text-row-handled')).toBeVisible();
    await uiExpect.poll(() => attentionCount(page)).toBe(1);
    await uiExpect(primary()).toHaveText(/导出/);

    // 9. N finds SHORT_ME; an edit saves, locks it and clears the attention.
    await page.getByRole('tab', { name: /^全部/ }).click();
    await uiExpect(page.getByRole('tab', { name: /^全部/ })).toHaveAttribute('data-state', 'active');
    await reader().focus();
    await page.keyboard.press('n');
    const short = row(SHORT_ME[0]);
    await uiExpect(short).toBeFocused();
    await page.keyboard.press('Enter');
    const editor = short.getByTestId('long-text-editor').locator('textarea');
    await uiExpect(editor).toBeFocused();
    await shot(page, '11-editor');
    await editor.fill('SHORT_ME　爱丽丝小声地哼起了歌。');
    await page.keyboard.press('Control+Enter');
    await uiExpect(short).toHaveAttribute('data-locked', 'true');
    await uiExpect(short).toContainText('爱丽丝小声地哼起了歌');
    await uiExpect(short).toBeFocused();
    await uiExpect.poll(() => attentionCount(page)).toBe(0);
    await uiExpect(page.getByTestId('long-text-live')).toContainText('已保存');

    // 10. R retranslates one row with "更口语"; undo brings the earlier translation back.
    const [colloquialSource, colloquialTarget] = NOVEL_CHAPTERS[COLLOQUIAL.chapter]![COLLOQUIAL.paragraph + 1]!;
    const colloquial = row(colloquialSource);
    await colloquial.focus();
    await page.keyboard.press('r');
    const popover = page.getByTestId('long-text-retranslate');
    await uiExpect(popover).toBeVisible();
    await popover.getByRole('button', { name: '更口语' }).click();
    await shot(page, '12-retranslate');
    await page.keyboard.press('Enter');
    await uiExpect(colloquial).toContainText(`【口语】${colloquialTarget}`);
    expect(requests().some(payload => payload.revision?.request?.includes('语气更口语化') && payload.items[0]!.text === colloquialSource)).toBe(true);
    await uiExpect(colloquial).toBeFocused();
    await colloquial.hover();
    await colloquial.getByTestId('long-text-row-menu').click();
    const menu = page.getByTestId('long-text-row-menu-content');
    await uiExpect(menu).toBeVisible();
    await shot(page, '13-row-menu');
    await menu.getByTestId('long-text-menu-undo').click();
    await uiExpect(colloquial).not.toContainText('【口语】');
    await uiExpect(colloquial).toContainText(colloquialTarget);

    // 11. A context menu closes with Esc; the next Esc leaves the page.
    await row(NOVEL_CHAPTERS[0]![1]![0]).click({ button: 'right' });
    await uiExpect(menu).toBeVisible();
    await uiExpect(menu.getByRole('menuitem', { name: '复制译文' })).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(menu).toHaveCount(0);
    expect(await page.evaluate(() => location.hash)).toBe('#/tools/text/translator');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#/tools');
    await page.evaluate(() => { location.hash = '/tools/text/translator'; });
    await waitForApp(page);
    await uiExpect(title).toContainText('novel.txt');

    // 12. Target-only export next to the source, twice: the second file is numbered.
    await page.getByTestId('long-text-export').click();
    const exportDialog = page.getByTestId('long-text-export-dialog');
    await uiExpect(exportDialog).toBeVisible();
    await uiExpect(page.getByTestId('long-text-export-name')).toHaveText('novel.zh-Hans.txt');
    await page.waitForTimeout(300);
    await shot(page, '14-export');
    await page.getByTestId('long-text-export-submit').click();
    await uiExpect(page.getByTestId('long-text-notice-exported')).toContainText('novel.zh-Hans.txt');
    const exported = await readFile(path.join(input, 'novel.zh-Hans.txt'), 'utf8');
    const expected = NOVEL_CHAPTERS.map(chapter => chapter.map(([source, translation]) => {
      if (source === SHORT_ME[0]) return 'SHORT_ME　爱丽丝小声地哼起了歌。';
      return translation;
    }).join('\n\n')).join('\n\n') + '\n';
    expect(exported).toBe(expected);
    expect(hasKana(exported)).toBe(false);
    await page.getByTestId('long-text-export').click();
    await page.getByTestId('long-text-export-submit').click();
    await uiExpect(page.getByTestId('long-text-notice-exported')).toContainText('novel.zh-Hans (2).txt');
    expect(await readFile(path.join(input, 'novel.zh-Hans (2).txt'), 'utf8')).toBe(expected);
    expect(await readFile(novelPath, 'utf8')).toBe(NOVEL_TEXT);

    // Bilingual Markdown into another folder: code verbatim, URL kept, "原 / 译" headings, <br> cells.
    await libraryRow('guide.md').click();
    await uiExpect(title).toContainText('guide.md');
    await primary().click();
    await uiExpect(primary()).toHaveText(/导出/, { timeout: 60_000 });
    await primary().click();
    await uiExpect(exportDialog).toBeVisible();
    await exportDialog.getByRole('radio', { name: '双语对照' }).click();
    await exportDialog.getByRole('radio', { name: '其他文件夹' }).click();
    await page.getByTestId('long-text-export-choose').click();
    await uiExpect(page.getByTestId('long-text-export-path')).toContainText(out);
    await uiExpect(page.getByTestId('long-text-export-name')).toHaveText('guide.zh-Hans.bilingual.md');
    await page.getByTestId('long-text-export-submit').click();
    await uiExpect(page.getByTestId('long-text-notice-exported')).toContainText('guide.zh-Hans.bilingual.md');
    const bilingual = await readFile(path.join(out, 'guide.zh-Hans.bilingual.md'), 'utf8');
    expect(bilingual).toContain(GUIDE_CODE);
    expect(bilingual).toContain('# Quick guide / 快速指南\n');
    expect(bilingual).toContain('## Before you start / 开始之前你开始\n');
    expect(bilingual).toContain('(https://example.com/guide?lang=en#start)');
    expect(bilingual).toMatch(/\[完整的指南\]\(https:\/\/example\.com\/guide\?lang=en#start\)/);
    expect(bilingual).toContain('| Pace<br>节奏 | How many requests run at once<br>');
    expect(bilingual).toContain('**your own model**');
    expect(bilingual).toContain('`layout`');

    // 13. Interrupted by quitting mid-run, resumed after the restart.
    await page.getByTestId('long-text-more').click();
    await page.getByRole('menuitem', { name: '清除译文…' }).click();
    await page.getByTestId('long-text-confirm-submit').click();
    await uiExpect(primary()).toHaveText(/翻译全文/);
    // Each of the two pages has its lane: the first request is answered, the other one hangs.
    hold(1);
    const before = requests().length;
    await primary().click();
    await uiExpect(status).toContainText(/正在翻译 · [1-9]\d* \/ 42 段/);
    await uiExpect.poll(() => requests().length).toBeGreaterThan(before + 1);
    await app!.close();
    app = undefined;
    page = await launch();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap'));
    await page.evaluate(() => { location.hash = '/tools/text/translator'; });
    await waitForApp(page);
    title = page.getByTestId('long-text-reader-title');
    status = page.getByTestId('long-text-status');
    await uiExpect(title).toContainText('guide.md');
    const interrupted = page.getByTestId('long-text-notice-interrupted');
    await uiExpect(interrupted).toBeVisible();
    await uiExpect(status).toContainText('已中断');
    await shot(page, '15-interrupted');
    release();
    await interrupted.getByRole('button', { name: '继续翻译' }).click();
    await uiExpect(primary()).toHaveText(/导出/, { timeout: 60_000 });
    await uiExpect(interrupted).toHaveCount(0);

    // 14. Deleting the novel removes its folder, never the file it came from.
    await libraryRow('novel.txt').click();
    await uiExpect(title).toContainText('novel.txt');
    const novelId = await libraryRow('novel.txt').getAttribute('data-document-id');
    expect(novelId).toBeTruthy();
    await access(path.join(run, 'profile', 'long-text', 'documents', novelId!));
    await page.getByTestId('long-text-more').click();
    await page.getByTestId('long-text-delete').click();
    await shot(page, '16-delete');
    await page.getByTestId('long-text-confirm-submit').click();
    await uiExpect(libraryRow('novel.txt')).toHaveCount(0);
    await uiExpect(page.getByTestId('long-text-library-row')).toHaveCount(4);
    await uiExpect.poll(() => access(path.join(run, 'profile', 'long-text', 'documents', novelId!)).then(() => true, () => false)).toBe(false);
    expect(await readFile(novelPath, 'utf8')).toBe(NOVEL_TEXT);

    // 15. Narrow and dark: the control row replaces the library; a 650px reader stacks source over target.
    await libraryRow('guide.md').click();
    await uiExpect(title).toContainText('guide.md');
    await page.evaluate(() => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })));
    const window = await app!.browserWindow(page);
    await window.evaluate(win => win.setSize(786, 660));
    await page.reload();
    await waitForApp(page);
    await uiExpect(page.getByTestId('long-text-library-trigger')).toBeVisible();
    await uiExpect(page.getByTestId('long-text-library')).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await shot(page, '17-narrow-dark');
    await page.addStyleTag({ content: '.lt-reader-panel { max-width: 650px; }' });
    await page.waitForTimeout(300);
    const stacked = await rows().filter({ has: page.locator('.lt-source') }).first().evaluate(element => {
      const source = element.querySelector('.lt-source')!.getBoundingClientRect();
      const target = element.querySelector('.lt-target')!.getBoundingClientRect();
      return target.top >= source.bottom - 1;
    });
    expect(stacked).toBe(true);
    await shot(page, '18-narrow-650');

    expect(errors).toEqual([]);
    // Closed here, before the passed run's folders are removed.
    await app!.close();
    app = undefined;
    await server.close();
    server = undefined;
  }, 240_000);
});
