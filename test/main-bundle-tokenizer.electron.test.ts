import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { encode } from 'gpt-tokenizer';
import { buildSubtitleTokenEstimate } from '../src/utils/subtitleTokenEstimateCore';
import { DEFAULT_SLICE_LENGTH_MAP } from '../electron/main/translation/constants';
import { SubtitleSliceType } from '../electron/main/translation/typing';
import { createTestRun } from './support/testRun';

const artifacts = path.resolve('test-results/main-bundle-tokenizer');
const skip = process.platform === 'linux' || process.env.CODEX_SANDBOX === 'seatbelt' || process.env.FUSIONKIT_SKIP_E2E === '1';
/** Optional: a packaged FusionKit.exe (such as test-results/easy-setup-pack/win-unpacked/FusionKit.exe) to check instead of the test build. */
const packaged = process.env.FUSIONKIT_PACKAGED_EXECUTABLE;

const SRT = [
  '1', '00:00:01,000 --> 00:00:02,500', 'Hello from the bundled tokenizer check.', '',
  '2', '00:00:03,000 --> 00:00:04,000', '第二行字幕，带一些中文。', '',
  '3', '00:00:04,500 --> 00:00:06,000', 'こんにちは、トークンを数えます。', '',
].join('\n');

/**
 * gpt-tokenizer is not a production dependency since B4: Vite bundles it into the main process
 * (dist-electron), the same way for the test build and the installed app. The main process's
 * token estimate must match the package itself, and must not be the rough fallback it uses when
 * encoding throws (characters × 0.75). A packaged app checks GitHub at launch, so its profile
 * gets a proxy that refuses every connection: nothing reaches the internet.
 */
describe.skipIf(skip)('main-process bundle', () => {
  it('counts tokens with the bundled gpt-tokenizer exactly like the package', async () => {
    const root = await createTestRun(artifacts);
    let app: ElectronApplication | undefined;
    try {
      const profile = path.join(root, 'profile');
      if (packaged) {
        await mkdir(profile, { recursive: true });
        await writeFile(path.join(profile, 'network-settings.json'), JSON.stringify({
          schemaVersion: 1, proxy: { mode: 'custom', host: '127.0.0.1', port: '9' }, downloadSource: 'official',
        }));
      }
      app = await electron.launch(packaged
        ? { executablePath: packaged, args: [`--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: undefined } }
        : {
          args: ['.', `--user-data-dir=${profile}`],
          cwd: process.cwd(),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' },
        });
      const page = await app.firstWindow();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const request = {
        content: SRT, sliceType: SubtitleSliceType.NORMAL, fileName: 'tiny.srt', sourceLang: 'EN', targetLang: 'ZH', translationOutputMode: 'bilingual',
      } as const;
      const bundled = await page.evaluate(
        data => (window as unknown as { ipcRenderer: { invoke(channel: string, payload: unknown): Promise<unknown> } }).ipcRenderer.invoke('estimate-subtitle-tokens', data),
        request,
      );
      const estimate = (countTokens: (text: string) => number) => buildSubtitleTokenEstimate({
        content: SRT, maxTokens: DEFAULT_SLICE_LENGTH_MAP[SubtitleSliceType.NORMAL], countTokens,
        tokenPricing: { inputTokensPerMillion: undefined, outputTokensPerMillion: undefined },
        fileName: request.fileName, sourceLang: request.sourceLang, targetLang: request.targetLang, translationOutputMode: request.translationOutputMode,
      });
      const expected = estimate(text => encode(text).length);
      expect(bundled).toEqual(expected);
      expect(estimate(text => Math.ceil(text.length * 0.75)).inputTokens).not.toBe(expected.inputTokens);
      if (packaged) {
        // electron-updater, which the installed build loads at runtime, is there too.
        const update = await page.evaluate(() => (window as unknown as { appUpdate: { getState(): Promise<{ installMode: string }> } }).appUpdate.getState());
        expect(update.installMode).toBe('in_app');
      }
    } finally {
      await app?.close();
    }
  }, 60_000);
});
