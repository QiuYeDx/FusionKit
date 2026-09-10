import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Locator, type Page } from 'playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio I1 coexistence and locales', () => {
  let app: ElectronApplication | undefined;
  let server: Server | undefined;
  let root: string;
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      server?.closeAllConnections();
      await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('keeps legacy preferences and entry points while localizing the workspace, export, and recovery', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-coexistence-ui-'));
    const artifacts = path.resolve('test-results/subtitle-studio-coexistence');
    await mkdir(artifacts, { recursive: true });
    const languages = ['zh', 'en', 'ja', 'zh-Hant'] as const;
    const locale = Object.fromEntries(await Promise.all(languages.map(async language => [language, JSON.parse(await readFile(path.resolve(`src/locales/${language}/studio.json`), 'utf8'))]))) as Record<typeof languages[number], Record<string, any>>;
    const requests: string[] = [];
    server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume the request before returning a controlled failure. */ }
      requests.push(request.url ?? '');
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'invalid_request', message: 'Synthetic coexistence failure' } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(port => {
      localStorage.setItem('lang', 'zh');
      localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
      localStorage.setItem('subtitle-translator-tour-done', '1');
      localStorage.setItem('local-subtitle-transcriber-tour-done', '1');
      localStorage.setItem('fusionkit-subtitle-translator-config', JSON.stringify({ version: 1, state: { preferences: {
        sourceLang: 'EN', targetLang: 'JA', translationOutputMode: 'target_only', sliceType: 'CUSTOM', customSliceLength: 200,
        outputMode: 'source', outputDirectoryDisplayLabel: null, conflictPolicy: 'index', concurrentSlices: false, thinkingEnabled: false,
      } } }));
      localStorage.setItem('fusionkit-local-subtitle-transcriber', JSON.stringify({ version: 4, state: { preferences: {
        modelId: 'coexistence-no-model-installed', devicePreference: 'auto', language: 'ja', vadEnabled: true,
        windowStrategy: 'acoustic_quiet_v1', beamSize: 5, temperature: 0, vadMinSilenceMs: 600,
        maxCueDurationMs: 7000, maxCueChars: 84, maxLineChars: 42, outputFormats: ['SRT', 'LRC'], outputMode: 'source', outputDirectoryDisplayLabel: null,
      }, draftPreferences: { initialPrompt: 'Synthetic local preference — preserve me.', taskMode: 'transcribe', conflictPolicy: 'index', postActionMode: 'export_only', preferredHandoffFormat: 'LRC' } } }));
      localStorage.setItem('fusionkit-model', JSON.stringify({ version: 5, state: { profiles: [{
        id: 'studio-coexistence-model', name: 'Synthetic failure model', provider: 'Other', apiKey: 'synthetic-key',
        baseUrl: `http://127.0.0.1:${port}`, modelKey: 'coexistence-fixture', apiFormat: 'chat_completions',
        tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
      }], assignment: { taskExecution: 'studio-coexistence-model', agent: null }, audioProfiles: [], audioAssignment: {} } }));
      location.hash = '/tools/subtitle/translator';
    }, port);
    await page.reload();
    const ready = async () => page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await ready();
    const window = await app.browserWindow(page); await window.evaluate(win => win.setSize(1280, 860));
    const route = async (target: string) => { await page.evaluate(target => { location.hash = target; }, target); await ready(); };
    const legacyPreferences = async () => page.evaluate(() => ({
      translator: JSON.parse(localStorage.getItem('fusionkit-subtitle-translator-config') ?? 'null'),
      transcriber: JSON.parse(localStorage.getItem('fusionkit-local-subtitle-transcriber') ?? 'null'),
    }));
    const assertLocalized = async (surface: Locator) => {
      const visibleText = await surface.innerText();
      expect(visibleText).not.toMatch(/\bstudio:|\b(?:translation|export|bilingual|diagnostics|errors)\.[a-z][a-z_]+/);
    };
    await uiExpect(page.locator('#tour-config-panel')).toBeVisible();
    await uiExpect(page.locator('#tour-lang-pair').getByRole('combobox').first()).toHaveText('英语');
    await uiExpect(page.locator('#tour-lang-pair').getByRole('combobox').last()).toHaveText('日语');
    await uiExpect(page.locator('#tour-slice-mode').getByRole('spinbutton')).toHaveValue('200');
    const oldFile = path.join(root, 'legacy-coexistence.lrc');
    await writeFile(oldFile, '[00:01.000]A synthetic legacy subtitle.\n');
    await page.locator('#tour-upload-zone input[type="file"]').setInputFiles(oldFile);
    const oldQueue = page.locator('#tour-task-queue');
    await uiExpect(oldQueue.getByText('legacy-coexistence.lrc', { exact: true })).toBeVisible();
    await uiExpect(page.locator('#tour-start-all-btn')).toBeEnabled();
    await page.locator('#tour-start-all-btn').click();
    await uiExpect.poll(() => requests.length).toBeGreaterThan(0);
    await uiExpect(oldQueue.getByText('翻译失败', { exact: true })).toBeVisible({ timeout: 20000 });
    const firstFailureRequests = requests.length;
    // The legacy retry icon has no accessible name; scope to the one failed task.
    await oldQueue.locator('button').filter({ has: page.locator('svg.lucide-rotate-cw') }).click();
    await uiExpect(oldQueue.getByText('待启动', { exact: true })).toBeVisible();
    await page.locator('#tour-start-all-btn').click();
    await uiExpect.poll(() => requests.length).toBeGreaterThan(firstFailureRequests);
    await uiExpect(oldQueue.getByText('翻译失败', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: path.join(artifacts, 'legacy-translation-failed-retry.png'), animations: 'disabled' });
    await oldQueue.getByRole('button', { name: '恢复历史任务', exact: true }).click();
    const oldRecovery = page.getByRole('dialog', { name: '恢复历史任务', exact: true });
    const recoveryDirectory = path.join(root, 'empty-legacy-history'); await mkdir(recoveryDirectory);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, recoveryDirectory);
    await oldRecovery.getByRole('button', { name: '选择目录扫描', exact: true }).click();
    await uiExpect(oldRecovery.getByText('未找到可恢复的历史任务', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await uiExpect(oldRecovery).toHaveCount(0);

    await route('/tools/subtitle/local-transcriber');
    await uiExpect(page.getByTestId('local-subtitle-transcriber')).toBeVisible();
    await uiExpect(page.getByTestId('local-subtitle-language-select')).toHaveText('日语');
    await uiExpect(page.locator('#local-subtitle-tour-start')).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, 'legacy-transcriber-no-model.png'), animations: 'disabled' });
    const beforeStudio = await legacyPreferences();
    expect(beforeStudio.translator.state.preferences).toMatchObject({ sourceLang: 'EN', targetLang: 'JA', customSliceLength: 200, translationOutputMode: 'target_only' });
    expect(beforeStudio.transcriber.state.preferences.language).toBe('ja');
    expect(beforeStudio.transcriber.state.draftPreferences.initialPrompt).toBe('Synthetic local preference — preserve me.');
    const legacyRequestCount = requests.length;

    await route('/tools/subtitle/studio');
    await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
    await uiExpect(page.locator('.studio-preview-region .studio-content-empty')).toHaveText(locale.zh.empty);
    await uiExpect(page.locator('.studio-document')).toHaveCount(0);
    const openSubtitle = async (file: string) => {
      await app!.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, file);
      await page.getByRole('button', { name: locale.zh.open_file, exact: true }).click();
      await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    };
    const emptyName = 'empty-metadata-only.lrc';
    const emptyFile = path.join(root, emptyName); await writeFile(emptyFile, '[ti:No timed content]\n');
    await openSubtitle(emptyFile);
    await uiExpect(page.locator('.studio-reader .studio-content-empty')).toHaveText(locale.zh.diagnostics.empty_document);
    await uiExpect(page.getByRole('button', { name: locale.zh.translation.action, exact: true })).toBeDisabled();
    const longName = '四语共存测试-长名称-September-2026-101-cues.lrc';
    const longFile = path.join(root, longName);
    const longText = Array.from({ length: 101 }, (_, index) => `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000]${index === 0 ? 'A long synthetic subtitle with enough words to wrap naturally across a narrow preview. '.repeat(8) : `Synthetic cue ${index + 1}.`}`).join('\n');
    await writeFile(longFile, longText);
    await openSubtitle(longFile);
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
    await page.getByRole('button', { name: locale.zh.translation.action, exact: true }).click();
    await page.getByRole('button', { name: locale.zh.translation.prepare, exact: true }).click();
    await uiExpect(page.locator('.studio-translation-plan')).toBeVisible();
    await page.getByRole('button', { name: locale.zh.translation.start, exact: true }).click();
    await uiExpect(page.locator('.studio-translation-status')).toHaveAttribute('data-state', 'needs_configuration', { timeout: 20000 });
    expect(requests.length).toBeGreaterThan(legacyRequestCount);
    const totalRequests = requests.length;

    for (const language of languages) {
      const labels = locale[language];
      await page.evaluate(({ language, dark }) => {
        localStorage.setItem('lang', language);
        localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: dark ? 'dark' : 'light' }, version: 0 }));
      }, { language, dark: language === 'ja' || language === 'zh-Hant' });
      await page.reload(); await ready();
      await uiExpect(page.getByTestId('subtitle-studio')).toBeVisible();
      await window.evaluate(win => win.setSize(1280, 860));
      await page.locator('.studio-document').filter({ hasText: emptyName }).click();
      await uiExpect(page.locator('.studio-reader .studio-content-empty')).toHaveText(labels.diagnostics.empty_document);
      await uiExpect(page.getByRole('button', { name: labels.translation.action, exact: true })).toBeDisabled();
      await assertLocalized(page.getByTestId('subtitle-studio'));
      await page.getByRole('button', { name: labels.export.action, exact: true }).click();
      const emptyExport = page.getByRole('dialog', { name: labels.export.action, exact: true });
      await emptyExport.getByRole('button', { name: labels.export.prepare, exact: true }).click();
      await uiExpect(emptyExport.getByText(labels.export.issues.empty_output, { exact: true })).toBeVisible();
      await assertLocalized(emptyExport);
      await page.keyboard.press('Escape');
      await uiExpect(emptyExport).toHaveCount(0);
      await page.locator('.studio-document').filter({ hasText: longName }).click();
      await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
      const jump = page.getByRole('spinbutton', { name: labels.page_number, exact: true });
      await jump.fill('2'); await jump.press('Enter');
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('101');
      await uiExpect(page.getByRole('button', { name: labels.next, exact: true })).toBeDisabled();
      await jump.fill('1'); await jump.press('Enter');
      await uiExpect(page.locator('.studio-cue-number').first()).toHaveText('1');
      await page.getByRole('tab', { name: labels.preview, exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await uiExpect(page.getByRole('tab', { name: labels.original_nodes, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowLeft');
      await uiExpect(page.getByRole('tab', { name: labels.preview, exact: true })).toHaveAttribute('aria-selected', 'true');
      if (language === 'ja' || language === 'zh-Hant') await window.evaluate(win => win.setSize(786, 540));
      await assertLocalized(page.getByTestId('subtitle-studio'));
      await page.getByRole('button', { name: labels.translation.resume, exact: true }).click();
      const resume = page.getByRole('dialog', { name: labels.translation.resume, exact: true });
      await uiExpect(resume.getByText(labels.translation.original_model, { exact: true })).toBeVisible();
      await uiExpect(resume.getByRole('button', { name: labels.cancel, exact: true })).toBeFocused();
      await assertLocalized(resume);
      expect(await resume.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `recovery-${language}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await uiExpect(page.getByRole('button', { name: labels.translation.resume, exact: true })).toBeFocused();
      await page.getByRole('button', { name: labels.export.action, exact: true }).click();
      const exporting = page.getByRole('dialog', { name: labels.export.action, exact: true });
      await exporting.getByRole('combobox', { name: labels.export.format, exact: true }).click();
      await page.getByRole('option', { name: 'SRT', exact: true }).click();
      await exporting.getByRole('button', { name: labels.export.prepare, exact: true }).click();
      await uiExpect(exporting.locator('[data-issue="missing_end"]')).toBeVisible();
      await exporting.getByRole('checkbox', { name: labels.export.estimate_end, exact: true }).check();
      await exporting.getByRole('button', { name: labels.export.prepare, exact: true }).click();
      await uiExpect(exporting.getByRole('button', { name: labels.export.save, exact: true })).toBeEnabled();
      await assertLocalized(exporting);
      expect(await exporting.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `export-${language}.png`), animations: 'disabled' });
      await app!.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
      await exporting.getByRole('button', { name: labels.export.save, exact: true }).click();
      await uiExpect(exporting.getByRole('button', { name: labels.export.save, exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      await uiExpect(page.getByRole('button', { name: labels.export.action, exact: true })).toBeFocused();
      expect(await legacyPreferences()).toEqual(beforeStudio);
      expect(requests).toHaveLength(totalRequests);
    }
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); });
    await page.reload(); await ready(); await window.evaluate(win => win.setSize(1280, 860));
    await route('/tools/subtitle/translator');
    await uiExpect(page.locator('#tour-lang-pair').getByRole('combobox').first()).toHaveText('英语');
    await uiExpect(page.locator('#tour-lang-pair').getByRole('combobox').last()).toHaveText('日语');
    await uiExpect(page.locator('#tour-slice-mode').getByRole('spinbutton')).toHaveValue('200');
    await route('/tools/subtitle/local-transcriber');
    await uiExpect(page.getByTestId('local-subtitle-language-select')).toHaveText('日语');
    await uiExpect(page.locator('#local-subtitle-tour-start')).toBeDisabled();
    expect(await legacyPreferences()).toEqual(beforeStudio);
    expect(requests).toHaveLength(totalRequests);
    expect(errors).toEqual([]);
    // No ASR model or media was supplied: this verifies availability and preferences, not transcription.
  }, 240000);
});
