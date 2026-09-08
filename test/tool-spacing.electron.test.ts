import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const routes = [
  'subtitle/studio', 'subtitle/translator', 'subtitle/converter', 'subtitle/extractor',
  'subtitle/local-transcriber', 'text/translator', 'rename/name-translator',
  'audio/transcriber', 'audio/speech-synthesis', 'audio/realtime-captions', 'audio/realtime-voice',
];

describe.runIf(process.env.FUSIONKIT_TOOL_UI_E2E === '1')('Tool page spacing in Electron', () => {
  let app: ElectronApplication | undefined;
  let root: string;
  afterAll(async () => {
    try { await app?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });

  it('keeps shared insets aligned across tools, themes, window sizes and expanded settings', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tool-spacing-ui-'));
    const artifacts = path.resolve('test-results/tool-spacing');
    await mkdir(artifacts, { recursive: true });
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      for (const tool of ['subtitle-translator', 'subtitle-converter', 'subtitle-extractor', 'local-subtitle-transcriber', 'name-translator']) {
        localStorage.setItem(`${tool}-tour-done`, '1');
      }
      localStorage.setItem('fusionkit-audio-settings', JSON.stringify({ version: 1, state: {
        profiles: [{ id: 'spacing-qa', name: 'Audio workspace', providerPreset: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'spacing-qa', routes: {
          transcription: { transport: 'openai_audio', model: 'gpt-4o-transcribe', enabled: true },
          speechSynthesis: { preset_voice: { transport: 'openai_audio', model: 'gpt-4o-mini-tts', enabled: true } },
          realtimeCaptions: { transport: 'openai_realtime', model: 'gpt-realtime-whisper', enabled: true },
          realtimeVoice: { transport: 'openai_realtime', model: 'gpt-realtime', enabled: true },
        } }],
        assignment: { transcription: 'spacing-qa', speechSynthesis: 'spacing-qa', realtimeCaptions: 'spacing-qa', realtimeVoice: 'spacing-qa' },
        migration: { legacyModelStore: { status: 'not_needed' } },
      } }));
    });
    const window = await app.browserWindow(page);
    for (const [theme, language] of [['light', 'zh'], ['dark', 'en']]) {
      await page.evaluate(({ theme, language }) => {
        localStorage.setItem('lang', language);
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
      }, { theme, language });
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      for (const [width, height] of [[1280, 860], [786, 660]]) {
        await window.evaluate((win, size) => win.setSize(...size), [width, height] as [number, number]);
        for (const route of routes) {
          await page.evaluate(route => { location.hash = `/tools/${route}`; }, route);
          await page.locator('[data-slot=tool-detail-layout]').waitFor();
          await uiExpect(page.locator('h1')).toHaveCount(1);
          await page.waitForTimeout(400);
          const label = `${route.replaceAll('/', '-')}-${theme}-${width}`;
          await page.locator('h1').evaluate(element => element.scrollIntoView({ block: 'center' }));
          await page.screenshot({ path: path.join(artifacts, `${label}.png`) });
          const insets = await page.locator('[data-slot=tool-panel-header], [data-slot=tool-config-header], [data-slot=tool-config-body], [data-slot=tool-file-picker]').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
            const style = getComputedStyle(element);
            return { slot: element.getAttribute('data-slot'), padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] };
          }));
          expect(insets.length, label).toBeGreaterThan(0);
          for (const inset of insets) expect(inset.padding, `${label} ${inset.slot}`).toEqual(['12px', '12px', '12px', '12px']);
          expect(await page.locator('[data-slot=tool-detail-layout], [data-slot=tool-detail-layout] main, [data-slot=tool-file-picker], [data-slot=tool-panel-header]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)), label).toBe(true);
          if (route.startsWith('audio/')) {
            const workspace = { 'audio/transcriber': 'transcriber-workspace', 'audio/speech-synthesis': 'speech-generate', 'audio/realtime-captions': 'captions-workspace', 'audio/realtime-voice': 'voice-workspace' }[route]!;
            await uiExpect(page.getByTestId(workspace)).toBeVisible();
          }
          if (width < 1024) {
            await page.locator('[data-slot=tool-detail-layout] main').evaluate(element => {
              const workspace = element.querySelector('[data-slot=tool-panel]') ?? element;
              workspace.scrollIntoView({ block: 'start' });
              const viewport = element.closest('[data-radix-scroll-area-viewport]');
              if (viewport) viewport.scrollTop = Math.max(0, viewport.scrollTop - 52);
            });
            await page.waitForTimeout(100);
            await page.screenshot({ path: path.join(artifacts, `${label}-workspace.png`) });
          }
          const disclosure = page.locator('[data-slot=tool-config-disclosure] > button').first();
          if (await disclosure.count() && await disclosure.isVisible()) {
            await disclosure.evaluate(element => element.scrollIntoView({ block: 'center' }));
            if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
            await page.waitForTimeout(300);
            expect(await disclosure.evaluate(element => {
              const panel = element.closest('[data-slot=tool-config-panel]')!.getBoundingClientRect();
              const bounds = element.getBoundingClientRect();
              return bounds.left >= panel.left && bounds.right <= panel.right;
            }), `${label} disclosure bounds`).toBe(true);
            await page.screenshot({ path: path.join(artifacts, `${label}-settings.png`) });
            await disclosure.click();
          }
        }
      }
    }
    expect(errors).toEqual([]);
  }, 180000);
});
