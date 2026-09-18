import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scope = '[data-slot=tool-file-drop-scope]';
const target = '[data-tool-file-drop-target]';
const fixtureInput = '[data-tool-drop-fixture]';
const nativeSelection = 'native-file-selection:internal:resolve-input-files';
const studioSubtitles = 'subtitle-studio:internal:import-dropped-subtitles';
const studioMedia = 'subtitle-studio:internal:drop-transcription-media';

type DropObservation = { counts: Record<string, number>; restore: () => void };
type ObservedMain = typeof globalThis & { __toolDropObservation?: DropObservation };

async function ready(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  await uiExpect(page.locator('h1')).toHaveCount(1);
  await page.locator(scope).waitFor();
  // Allow the route's existing spring to finish before measuring or photographing it.
  await page.waitForTimeout(400);
}

async function navigate(page: Page, route: string) {
  await page.evaluate(route => { location.hash = `/tools/${route}`; }, route);
  await ready(page);
  await uiExpect(page.locator(`${target}:visible`)).toHaveCount(1);
}

async function nativeFiles(page: Page, files: string[]) {
  await page.evaluate(() => {
    document.querySelector('[data-tool-drop-fixture]')?.remove();
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    input.dataset.toolDropFixture = '';
    document.body.append(input);
  });
  // These are OS-backed File objects, so the production preload's native-path
  // capture and main-process admission both execute without a security mock.
  await page.locator(fixtureInput).setInputFiles(files);
}

async function drag(page: Page, selector: string, types: string[], removeInput = false) {
  return page.evaluate(({ selector, types, removeInput }) => {
    const input = document.querySelector('[data-tool-drop-fixture]') as HTMLInputElement;
    const element = document.querySelector(selector);
    if (!element || !input?.files?.length) throw new Error(`Missing drag fixture or target: ${selector}`);
    const transfer = new DataTransfer();
    Array.from(input.files).forEach(file => transfer.items.add(file));
    const prevented = types.map(type => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    // Path authority must already have been captured synchronously by preload.
    if (removeInput) input.remove();
    return prevented;
  }, { selector, types, removeInput });
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => ({ ...(globalThis as ObservedMain).__toolDropObservation!.counts }));
}

async function observeImports(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }, channels) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const originals = new Map<string, Handler>();
    const observed: DropObservation = { counts: {}, restore: () => {
      for (const [channel, original] of originals) handlers.set(channel, original);
    } };
    for (const channel of channels) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing production file-import handler: ${channel}`);
      originals.set(channel, original);
      observed.counts[channel] = 0;
      handlers.set(channel, (event, ...args) => {
        observed.counts[channel]++;
        // Observe only; preserve every original permission check and response.
        return original(event, ...args);
      });
    }
    (globalThis as ObservedMain).__toolDropObservation = observed;
  }, [nativeSelection, studioSubtitles, studioMedia]);
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

describe.runIf(process.env.FUSIONKIT_TOOL_UI_E2E === '1')('Tool file drop surfaces in Electron', () => {
  let app: ElectronApplication | undefined;
  let root: string | undefined;
  afterAll(async () => {
    try {
      if (app) {
        try { await app.evaluate(() => (globalThis as ObservedMain).__toolDropObservation?.restore()); }
        finally { await app.close(); }
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it('routes native Files across the tool page once, clears feedback, and follows the active Studio importer', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tool-file-drop-ui-'));
    const artifacts = path.resolve('test-results/tool-file-drop');
    await mkdir(artifacts, { recursive: true });
    const subtitle = (name: string) => path.join(root!, name);
    const files = ['01-page-heading.srt', '02-config-sidebar.srt', '03-original-picker.srt', '04-modal-blocked.srt', '05-studio-document.srt'].map(subtitle);
    const textFile = path.join(root, 'drop-preview.txt');
    const mediaFile = path.join(root, 'drop-preview.wav');
    await Promise.all([
      ...files.map(file => writeFile(file, '1\n00:00:01,000 --> 00:00:02,500\nNative file drop regression.\n')),
      writeFile(textFile, 'Native file drop preview.'),
      writeFile(mediaFile, silentWav()),
    ]);
    const env: NodeJS.ProcessEnv = { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      localStorage.setItem('lang', 'zh');
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
      for (const tool of ['subtitle-translator', 'subtitle-converter', 'subtitle-extractor', 'local-subtitle-transcriber', 'name-translator']) {
        localStorage.setItem(`${tool}-tour-done`, '1');
      }
      localStorage.setItem('fusionkit-subtitle-converter', JSON.stringify({ version: 1, state: { outputMode: 'source' } }));
      localStorage.setItem('fusionkit-audio-settings', JSON.stringify({ version: 1, state: {
        profiles: [{ id: 'drop-qa', name: 'Audio workspace', providerPreset: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'drop-qa', routes: {
          transcription: { transport: 'openai_audio', model: 'gpt-4o-transcribe', enabled: true },
        } }], assignment: { transcription: 'drop-qa' }, migration: { legacyModelStore: { status: 'not_needed' } },
      } }));
      location.hash = '/tools/subtitle/converter';
    });
    await page.reload(); await ready(page);
    const nativeWindow = await app.browserWindow(page);
    await nativeWindow.evaluate(win => win.setSize(1280, 860));
    await observeImports(app);
    const overlay = page.getByTestId('tool-page-drop-overlay');

    // Header, configuration column and original picker all reach the same
    // importer exactly once, with real source paths and actual queued files.
    for (const [index, selector] of ['h1', `${scope} aside`, '#cvt-tour-upload'].entries()) {
      await nativeFiles(page, [files[index]]);
      expect(await drag(page, selector, ['dragenter', 'dragover'])).toEqual([true, true]);
      await uiExpect(overlay).toContainText('松开即可导入文件');
      await drag(page, selector, ['drop'], true);
      await uiExpect(overlay).toHaveCount(0);
      await uiExpect(page.getByText(path.basename(files[index]), { exact: true })).toHaveCount(1);
      expect((await counts(app))[nativeSelection]).toBe(index + 1);
    }

    // Ordinary text dragging must retain normal browser selection behavior.
    const beforeText = await counts(app);
    const prevented = await page.locator('h1').evaluate(element => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'ordinary selected text');
      return ['dragenter', 'dragover', 'drop'].map(type => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        element.dispatchEvent(event); return event.defaultPrevented;
      });
    });
    expect(prevented).toEqual([false, false, false]);
    await uiExpect(overlay).toHaveCount(0);
    expect(await counts(app)).toEqual(beforeText);

    await nativeFiles(page, [files[3]]);
    await drag(page, 'h1', ['dragenter', 'dragover']);
    await uiExpect(overlay).toBeVisible();
    await drag(page, 'h1', ['dragleave']);
    await uiExpect(overlay).toHaveCount(0);
    await drag(page, scope, ['dragenter', 'dragover']);
    await uiExpect(overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(overlay).toHaveCount(0);

    // A real edit dialog blocks imports behind it, including synthetic delivery
    // to the page header rather than relying only on the dialog's pointer shield.
    await page.locator('button').filter({ has: page.locator('svg.lucide-pencil') }).first().click();
    await uiExpect(page.getByRole('dialog')).toBeVisible();
    const beforeModal = await counts(app);
    await drag(page, 'h1', ['dragenter', 'dragover', 'drop'], true);
    await uiExpect(overlay).toHaveCount(0);
    await uiExpect(page.getByText(path.basename(files[3]), { exact: true })).toHaveCount(0);
    expect(await counts(app)).toEqual(beforeModal);
    await page.keyboard.press('Escape');
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);

    // Keep the document view mounted while switching to transcription: only
    // the active importer may own drops on the settings column or title.
    await navigate(page, 'subtitle/studio');
    await page.getByRole('tab', { name: '转写', exact: true }).click();
    await uiExpect(page.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', 'transcription');
    await uiExpect(page.getByTestId('studio-transcription-picker')).toBeVisible();
    await nativeFiles(page, [mediaFile]);
    await drag(page, '[data-testid=studio-transcription-config]', ['dragenter', 'dragover']);
    await uiExpect(overlay).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'studio-transcription-sidebar-light.png'), animations: 'disabled' });
    const beforeMedia = await counts(app);
    await drag(page, '[data-testid=studio-transcription-config]', ['drop'], true);
    await uiExpect(page.getByTestId('studio-transcription-media-row')).toHaveCount(1);
    await uiExpect(page.getByTestId('studio-transcription-media-row')).toContainText(path.basename(mediaFile));
    await uiExpect(overlay).toHaveCount(0);
    const afterMedia = await counts(app);
    expect(afterMedia[studioMedia]).toBe(beforeMedia[studioMedia] + 1);
    expect(afterMedia[studioSubtitles]).toBe(beforeMedia[studioSubtitles]);

    await page.getByRole('tab', { name: '文档', exact: true }).click();
    await uiExpect(page.getByTestId('subtitle-studio')).toHaveAttribute('data-workspace-view', 'documents');
    await nativeFiles(page, [files[4]]);
    await drag(page, 'h1', ['dragenter', 'dragover']);
    await uiExpect(overlay).toBeVisible();
    await drag(page, 'h1', ['drop'], true);
    await uiExpect(page.locator('.studio-cue-table')).toContainText('Native file drop regression.');
    await uiExpect(overlay).toHaveCount(0);
    const afterDocument = await counts(app);
    expect(afterDocument[studioSubtitles]).toBe(afterMedia[studioSubtitles] + 1);
    expect(afterDocument[studioMedia]).toBe(afterMedia[studioMedia]);

    // Shared and custom consumers must all expose full-page feedback across
    // themes and actual Electron window sizes, even when the picker is offscreen.
    const samples = [
      ['subtitle/converter', files[0]], ['text/translator', textFile],
      ['rename/name-translator', textFile], ['audio/transcriber', mediaFile],
    ];
    for (const [theme, width, height] of [['light', 1280, 860], ['dark', 1280, 860], ['dark', 786, 660]] as const) {
      await page.evaluate(theme => localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 })), theme);
      await page.reload(); await ready(page);
      expect(await page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark');
      await nativeWindow.evaluate((win, size) => win.setSize(...size), [width, height] as [number, number]);
      for (const [route, file] of samples) {
        await navigate(page, route);
        await page.locator('h1').evaluate(element => element.scrollIntoView({ block: 'center' }));
        await nativeFiles(page, [file]);
        // Dispatch on the outer scope itself to cover page margins and blank space.
        await drag(page, scope, ['dragenter', 'dragover']);
        await uiExpect(overlay).toBeVisible();
        const geometry = await overlay.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, viewportWidth: innerWidth, viewportHeight: innerHeight, pointerEvents: style.pointerEvents,
            radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.width).toBeGreaterThan(geometry.viewportWidth * 0.8);
        expect(geometry.pointerEvents).toBe('none');
        expect(geometry.radii.every(radius => Number.parseFloat(radius) >= 24)).toBe(true);
        await page.screenshot({ path: path.join(artifacts, `${route.replaceAll('/', '-')}-${theme}-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await uiExpect(overlay).toHaveCount(0);
        await page.locator(fixtureInput).evaluate(element => element.remove());
      }
    }
    expect(errors).toEqual([]);
  }, 180000);
});
