// Captures the screenshots used by README.md and README.en.md from the real app.
//
//   pnpm run pretest                                  # build the app once
//   node scripts/readme-screenshots/capture.mjs zh    # writes docs/assets/readme/zh/*.png
//   node scripts/readme-screenshots/capture.mjs en    # writes docs/assets/readme/en/*.png
//   node scripts/readme-screenshots/capture.mjs zh studio-dark agent-light   # only these shots
//
// The app runs in the quiet test-window mode (off-screen, never takes focus) with a
// throwaway profile, original sample subtitles and a local stand-in for the model API,
// so no real files, keys or network services are involved.
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interviewEnglish, lighthouseBilingual, lighthouseJapanese } from './samples.mjs';

const [lang = 'zh', ...names] = process.argv.slice(2);
if (!['zh', 'en'].includes(lang)) throw new Error(`Unknown language "${lang}", expected zh or en`);
const out = path.resolve('docs/assets/readme', lang);
const only = new Set(names);
const want = (name) => !only.size || only.has(name);
const SIZE = { width: 1280, height: 800 };

await mkdir(out, { recursive: true });
const prefix = path.join(tmpdir(), 'fusionkit-readme-');
const root = await mkdtemp(prefix);
const media = path.join(root, '灯台');
await mkdir(media, { recursive: true });
const files = {
  bilingual: path.join(media, '灯台守の夜 第01話.srt'),
  japanese: path.join(media, '灯台守の夜 第02話.ja.srt'),
  english: path.join(media, 'keeper-interview.en.srt'),
};
await writeFile(files.bilingual, lighthouseBilingual);
await writeFile(files.japanese, lighthouseJapanese);
await writeFile(files.english, interviewEnglish);

const COPY = {
  zh: {
    openFile: '打开字幕文件',
    request: '把工作台里还没翻译的日语字幕翻成中文',
    target: 'zh',
    goal: '把字幕工作台里还没翻译的日语字幕翻译成中文',
    steps: ['找出还没有译文的日语字幕', '按工作台当前设置准备中文翻译', '等你确认后开始翻译'],
    reply: '工作台里有 2 份还没有译文的字幕，其中日语的是 **灯台守の夜 第02話.ja.srt**（6 条），英文访谈这次先不处理。\n\n已按字幕工作台当前的设置准备好中文翻译，确认上面的卡片后就会开始，完成后我会告诉你结果。',
    replyMarker: '确认上面的卡片后就会开始',
    title: '日语字幕翻译成中文',
  },
  en: {
    openFile: 'Open subtitle file',
    request: 'Translate the Japanese subtitles in the Studio that have no translation yet into English',
    target: 'en',
    goal: 'Translate the untranslated Japanese subtitles in the Studio into English',
    steps: ['Find Japanese subtitles without a translation', 'Prepare an English translation with the Studio settings', 'Start once you confirm'],
    reply: 'Two documents in the Studio have no translation yet. The Japanese one is **灯台守の夜 第02話.ja.srt** (6 cues); I left the English interview alone.\n\nThe English translation is prepared with the Studio\'s current settings. It starts as soon as you confirm the card above, and I\'ll report back when it\'s done.',
    replyMarker: 'It starts as soon as you confirm',
    title: 'Translate Japanese subtitles',
  },
}[lang];

// --- Local stand-in for the model API -------------------------------------------------
const turns = [];
function sse(events) {
  return [...events, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2140, output_tokens: 186, total_tokens: 2326 } } }]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const say = (value) => [...value].reduce((chunks, char, index) => {
  if (index % 6 === 0) chunks.push({ type: 'response.output_text.delta', delta: '' });
  chunks[chunks.length - 1].delta += char;
  return chunks;
}, []);
function call(name, args) {
  const id = `readme-${name}-${turns.length}`;
  const item = { id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
  return [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }];
}
/** The latest tool output the agent sent back, parsed. */
function lastOutput(body) {
  const outputs = body.input.filter((item) => item.type === 'function_call_output');
  const value = outputs.at(-1)?.output;
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; }
}
const plan = (statuses) => ({
  goal: COPY.goal,
  steps: [
    { id: 'find', title: COPY.steps[0], status: statuses[0], dependsOn: [] },
    { id: 'prepare', title: COPY.steps[1], status: statuses[1], dependsOn: ['find'] },
    { id: 'confirm', title: COPY.steps[2], status: statuses[2], dependsOn: ['prepare'] },
  ],
});
const script = [
  () => call('update_agent_plan', plan(['in_progress', 'pending', 'pending'])),
  () => call('list_studio_documents', { query: '', format: 'all', status: 'untranslated', offset: 0, limit: 20 }),
  (body) => {
    const found = [];
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.documentId === 'string' && String(value.name).includes('第02話')) found.push({ documentId: value.documentId, revision: value.revision });
      Object.values(value).forEach(walk);
    };
    walk(lastOutput(body));
    if (!found.length) throw new Error('The Japanese sample is missing from list_studio_documents');
    return call('prepare_studio_translation', { documents: found.slice(0, 1), targetLanguage: COPY.target });
  },
  () => call('update_agent_plan', plan(['completed', 'completed', 'in_progress'])),
  () => say(COPY.reply),
];

const server = createServer(async (request, response) => {
  let raw = '';
  for await (const part of request) raw += part.toString();
  if (request.url?.endsWith('/models')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'readme-model' }] }));
    return;
  }
  const body = JSON.parse(raw || '{}');
  if (request.url?.endsWith('/responses')) {
    // The session title is a side request of its own; it does not take a scripted turn.
    if (String(body.instructions ?? '').startsWith('You name conversations.')) { response.setHeader('Content-Type', 'text/event-stream'); response.end(sse(say(COPY.title))); return; }
    const next = script[turns.length] ?? (() => say('OK.'));
    turns.push(body);
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(sse(next(body)));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// --- App ------------------------------------------------------------------------------
let app;
const errors = [];
try {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(root, 'profile')}`],
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_WINDOW: process.env.FUSIONKIT_TEST_WINDOW || 'quiet' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const win = await app.browserWindow(page);
  await win.evaluate((window, size) => { window.setContentSize(size.width, size.height); window.webContents.setBackgroundThrottling(false); }, SIZE);
  await app.evaluate(({ dialog }, list) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list }); }, [files.bilingual, files.japanese, files.english]);

  const settle = () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  /** Reloads at a route with the given theme and the stand-in model profiles. */
  const open = async (hash, theme) => {
    await page.evaluate(({ hash, theme, port, lang }) => {
      const profile = { id: 'readme-agent', name: 'DeepSeek', provider: 'Other', apiKey: 'readme-placeholder-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelKey: 'deepseek-chat', apiFormat: 'responses', outputTokenParameter: 'max_tokens', tokenPricing: { inputTokensPerMillion: 2, outputTokensPerMillion: 8 } };
      localStorage.setItem('lang', lang);
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
      localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [profile, { ...profile, id: 'readme-task', apiFormat: 'chat_completions' }], assignment: { agent: 'readme-agent', taskExecution: 'readme-task' }, audioProfiles: [], audioAssignment: {} } }));
      location.hash = hash;
    }, { hash, theme, port, lang });
    await page.reload();
    await settle();
    await page.waitForTimeout(600);
  };
  const shot = async (name) => {
    await page.mouse.move(SIZE.width - 2, SIZE.height / 2);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
    console.log(`wrote ${name}.png`);
  };

  // Subtitle Studio with the three sample documents, the bilingual episode open.
  await open('/tools/subtitle/studio', 'light');
  await page.getByTestId('subtitle-studio').waitFor();
  await page.getByRole('button', { name: COPY.openFile, exact: true }).click();
  await page.waitForTimeout(1500);
  if (await page.getByTestId('studio-library-result').isVisible().catch(() => false)) await page.locator('#studio-result-close').click();
  const openStudioDocument = async () => {
    await page.getByText('灯台守の夜 第01話.srt').first().click();
    await expect(page.locator('.studio-cue-table tbody tr')).toHaveCount(14);
  };
  await openStudioDocument();
  for (const theme of ['light', 'dark']) {
    if (!want(`studio-${theme}`)) continue;
    await open('/tools/subtitle/studio', theme);
    await openStudioDocument();
    await shot(`studio-${theme}`);
  }

  // Tool overview and the floating Agent panel.
  for (const theme of ['light', 'dark']) {
    if (want(`tools-${theme}`)) { await open('/tools', theme); await shot(`tools-${theme}`); }
    if (want(`dock-${theme}`)) {
      // The floating Agent panel on a tool page knows which document is open.
      await open('/tools/subtitle/studio', theme);
      await openStudioDocument();
      await page.getByTestId('agent-dock-launcher').click();
      await expect(page.getByTestId('agent-dock-page')).toContainText('灯台守の夜');
      await page.waitForTimeout(700);
      await shot(`dock-${theme}`);
    }
  }

  // HomeAgent: a plan, a studio lookup and a translation waiting for confirmation.
  if (want('agent-light') || want('agent-dark')) {
    await open('/', 'light');
    await page.getByTestId('agent-input').fill(COPY.request);
    await page.getByTestId('agent-send').first().click();
    await expect(page.getByText(COPY.replyMarker)).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(800);
    await win.evaluate((window) => window.setContentSize(1280, 680));
    for (const theme of ['light', 'dark']) {
      if (!want(`agent-${theme}`)) continue;
      await page.evaluate((theme) => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      await shot(`agent-${theme}`);
    }
    await win.evaluate((window, size) => window.setContentSize(size.width, size.height), SIZE);
  }

  if (errors.length) console.warn(`Renderer errors:\n${errors.join('\n')}`);
} finally {
  await app?.close();
  server.close();
  if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error('Unexpected cleanup root');
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
