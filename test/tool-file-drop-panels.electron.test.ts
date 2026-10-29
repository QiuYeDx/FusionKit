import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { createTestRun } from './support/testRun';

// FK-PIT-0198: the title bar's connection panel stays mounted while closed. As a hidden
// role="dialog" it made every tool page refuse file drops (and Escape) whenever an external
// agent was connected. Unlike tool-file-drop.electron.test.ts this runs in every `pnpm test`.
const artifacts = path.resolve('test-results/tool-file-drop-panels');
const scope = '[data-slot=tool-file-drop-scope]';
const fixtureInput = '[data-tool-drop-fixture]';
const converter = '#cvt-tour-upload';
// The media converter runs on Windows with the staged runtime (build/subtitle-studio-resources, git-ignored).
const stagedMedia = path.resolve('build/subtitle-studio-resources/transcription/win-x64/media');
const mediaReady = process.platform === 'win32' && ['ffmpeg.exe', 'ffprobe.exe'].every(file => existsSync(path.join(stagedMedia, file)));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Waits for a marker only the new route renders: the old page's scope lingers through its exit. */
async function open(page: Page, route: string, marker: string) {
  await page.evaluate(route => { location.hash = route; }, route);
  await page.locator(marker).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await page.locator(scope).waitFor();
}

async function nativeFiles(page: Page, files: string[]) {
  await page.evaluate(() => {
    document.querySelector('[data-tool-drop-fixture]')?.remove();
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    input.dataset.toolDropFixture = '';
    document.body.append(input);
  });
  // OS-backed Files: the production preload captures their paths without a mock.
  await page.locator(fixtureInput).setInputFiles(files);
}

async function drag(page: Page, selector: string, types: string[]) {
  return page.evaluate(({ selector, types }) => {
    const input = document.querySelector('[data-tool-drop-fixture]') as HTMLInputElement;
    const element = document.querySelector(selector);
    if (!element || !input?.files?.length) throw new Error(`Missing drag fixture or target: ${selector}`);
    const transfer = new DataTransfer();
    Array.from(input.files).forEach(file => transfer.items.add(file));
    return types.map(type => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }, { selector, types });
}

function silentWav() {
  const sampleRate = 16000, pcmBytes = sampleRate * 2;
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + pcmBytes, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

describe('tool file drops beside always-mounted panels', () => {
  it('accepts drops and Escape on tool pages while an external agent is connected', async () => {
    // Not os.tmpdir(): Windows refuses drops from %TEMP% (windows-explorer-drop-resolver.ts).
    const root = await createTestRun(artifacts);
    const files = path.join(root, 'files');
    await mkdir(files);
    const [first, second, blocked, knowledge] = ['01-indicator.srt', '02-panel-open.srt', '03-modal.srt', '04-popover.srt'].map(name => path.join(files, name));
    const media = path.join(files, 'drop-beside-indicator.wav');
    await Promise.all([
      ...[first, second, blocked, knowledge].map(file => writeFile(file, '1\n00:00:01,000 --> 00:00:02,500\nDrop beside the title bar panel.\n')),
      writeFile(media, silentWav()),
    ]);
    // cpu_only: no encoder detection on the real GPU, and no encodes either.
    const env: NodeJS.ProcessEnv = { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test', FUSIONKIT_TEST_MEDIA_CAPS: 'cpu_only' };
    delete env.ELECTRON_RUN_AS_NODE;
    let app: ElectronApplication | undefined;
    let client: Client | undefined;
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh');
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        localStorage.setItem('subtitle-converter-tour-done', '1');
        localStorage.setItem('translation-knowledge-tour-done', '1');
        localStorage.setItem('fusionkit-subtitle-converter', JSON.stringify({ version: 1, state: { outputMode: 'source' } }));
        location.hash = '/tools/subtitle/converter';
      });
      await page.reload();
      await open(page, '/tools/subtitle/converter', converter);
      await (await app.browserWindow(page)).evaluate(win => win.setSize(1280, 860));

      // A connected agent shows the title bar capsule; its panel stays mounted, closed.
      const port = await freePort();
      const enabled = await page.evaluate(port => window.externalAgent!.updateSettings({ enabled: true, port }), port);
      expect(enabled.ok).toBe(true);
      client = new Client({ name: 'claude-code', version: '2.1.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${enabled.ok ? enabled.value.token : ''}` } } }));
      await client.callTool({ name: 'get_fusionkit_status', arguments: {} });
      const indicator = page.getByTestId('titlebar-external-agent');
      const panel = page.getByTestId('titlebar-external-panel');
      await uiExpect(indicator).toBeVisible();
      await uiExpect(panel).toHaveAttribute('aria-hidden', 'true');
      await uiExpect(panel).not.toHaveAttribute('role', 'dialog');
      await uiExpect(page.locator('[role=dialog], [role=alertdialog]')).toHaveCount(0);

      const overlay = page.getByTestId('tool-page-drop-overlay');
      await nativeFiles(page, [first]);
      expect(await drag(page, 'h1', ['dragenter', 'dragover'])).toEqual([true, true]);
      await uiExpect(overlay).toContainText('松开即可导入文件');
      await drag(page, 'h1', ['drop']);
      await uiExpect(overlay).toHaveCount(0);
      await uiExpect(page.getByText(path.basename(first), { exact: true })).toHaveCount(1);

      // A real modal dialog still keeps drops off the page behind it.
      await page.locator('button').filter({ has: page.locator('svg.lucide-pencil') }).first().click();
      await uiExpect(page.getByRole('dialog')).toBeVisible();
      await nativeFiles(page, [blocked]);
      await drag(page, 'h1', ['dragenter', 'dragover']);
      await uiExpect(overlay).toHaveCount(0);
      await drag(page, 'h1', ['drop']);
      await uiExpect(page.getByText(path.basename(blocked), { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await uiExpect(page.getByRole('dialog')).toHaveCount(0);

      // The media converter takes the page-wide drop too, once its engine is ready.
      if (mediaReady) {
        await open(page, '/tools/media/converter', '[data-testid=media-converter][data-platform=supported]');
        await uiExpect(page.getByTestId('media-upload-filter')).toBeEnabled();
        await nativeFiles(page, [media]);
        await drag(page, scope, ['dragenter', 'dragover']);
        await uiExpect(overlay).toBeVisible();
        await page.screenshot({ path: path.join(root, 'media-converter-drop-with-indicator.png'), animations: 'disabled' });
        await drag(page, scope, ['drop']);
        await uiExpect(overlay).toHaveCount(0);
        await uiExpect(page.getByText(path.basename(media), { exact: true })).toHaveCount(1);
      }

      // An open popover (non-modal, role="dialog") does not cover the page either.
      await open(page, '/tools/translation-knowledge', '[data-testid=knowledge-global-search]');
      await page.getByTestId('knowledge-global-search').fill('x');
      await uiExpect(page.getByTestId('knowledge-search-results')).toBeVisible();
      await nativeFiles(page, [knowledge]);
      // The page's import target is enabled once the library has loaded.
      await uiExpect(async () => {
        await drag(page, scope, ['dragenter', 'dragover']);
        await uiExpect(overlay).toBeVisible({ timeout: 500 });
      }).toPass();
      await uiExpect(page.getByTestId('knowledge-search-results')).toBeVisible();
      // Cancel the drag (however many dragenters the retries sent) instead of dropping a non-JSON file here.
      await drag(page, scope, ['dragend']);
      await uiExpect(overlay).toHaveCount(0);

      // The open panel is a non-modal dialog: it does not cover the page, and Escape folds it first.
      await open(page, '/tools/subtitle/converter', converter);
      await indicator.click();
      await uiExpect(page.getByRole('dialog')).toContainText('claude-code');
      await uiExpect(panel).toHaveAttribute('aria-modal', 'false');
      await nativeFiles(page, [second]);
      await drag(page, 'h1', ['dragenter', 'dragover']);
      await uiExpect(overlay).toBeVisible();
      await drag(page, 'h1', ['drop']);
      await uiExpect(page.getByText(path.basename(second), { exact: true })).toHaveCount(1);
      await page.keyboard.press('Escape');
      await uiExpect(page.getByTestId('titlebar-external-agent-root')).not.toHaveAttribute('data-open', 'true');
      await uiExpect(panel).not.toHaveAttribute('role', 'dialog');
      expect(await page.evaluate(() => location.hash)).toBe('#/tools/subtitle/converter');

      // With the panel closed again, Escape leaves the tool page.
      await page.locator('h1').click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => location.hash === '#/tools');
      expect(errors).toEqual([]);
    } finally {
      try { await client?.close(); }
      finally { await app?.close(); }
    }
  }, 120_000);
});
