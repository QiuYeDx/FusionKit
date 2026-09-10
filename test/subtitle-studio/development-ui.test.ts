import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Start the actual dev server first, e.g. VSCODE_DEBUG=1 pnpm dev --port 7777.
// VSCODE_DEBUG suppresses the plugin's own Electron; this test owns isolated instances.
const devUrl = process.env.FUSIONKIT_STUDIO_DEV_URL;
it.runIf(Boolean(devUrl))('uses the dev renderer to import, preview and export after restart beside an unreadable historical document', async () => {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'studio-dev-ui-')));
  const profile = path.join(root, 'profile');
  const artifacts = path.resolve('test-results/subtitle-studio-development');
  await mkdir(artifacts, { recursive: true });
  const broken = path.join(profile, 'subtitle-studio', 'documents', randomUUID());
  await mkdir(broken, { recursive: true });
  const generation = randomUUID();
  const pointer = JSON.stringify({ schemaVersion: 1, generation });
  const oldSnapshot = JSON.stringify({ schemaVersion: 1, document: { legacy: true }, tasks: [] });
  await writeFile(path.join(broken, 'current.json'), pointer);
  await writeFile(path.join(broken, `${generation}.json`), oldSnapshot);
  const source = path.join(root, '开发模式字幕.srt');
  const content = '1\r\n00:00:01,000 --> 00:00:02,000\r\nDevelopment import works.\r\n';
  await writeFile(source, content);
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  const launch = async () => {
    application = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: devUrl!, NODE_ENV: 'development' }, timeout: 60000 });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); location.hash = '/tools/subtitle/studio'; });
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    expect(new URL(page.url()).origin).toBe(new URL(devUrl!).origin);
    await uiExpect(page.getByTestId('studio-recovery-warning')).toContainText('1 份文档');
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    return page;
  };
  try {
    let page = await launch();
    // Control only the OS dialog response; invoke the real button, preload and main handlers.
    await application!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.getByRole('button', { name: '打开字幕文件', exact: true })).toBeEnabled();
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    await application!.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.getByText('Development import works.', { exact: true })).toBeVisible();
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'import-desktop.png'), animations: 'disabled' });
    await application!.close(); application = undefined;
    page = await launch();
    await uiExpect(page.getByText('Development import works.', { exact: true })).toBeVisible();
    const list = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
    expect(list).toMatchObject({ ok: true, value: { total: 1, unavailableDocuments: 1 } });
    const output = path.join(root, 'exported.srt');
    await application!.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.getByRole('button', { name: '下载原文件', exact: true }).click();
    await uiExpect(page.getByText('已下载：exported.srt', { exact: true })).toBeVisible();
    expect(await readFile(output, 'utf8')).toBe(content);
    await application!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(786, 540); });
    await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark') && !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await uiExpect(page.getByTestId('studio-recovery-warning')).toBeVisible();
    await uiExpect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: path.join(artifacts, 'restored-narrow-dark.png'), animations: 'disabled' });
    expect(await readFile(path.join(broken, 'current.json'), 'utf8')).toBe(pointer);
    expect(await readFile(path.join(broken, `${generation}.json`), 'utf8')).toBe(oldSnapshot);
    expect(await readFile(source, 'utf8')).toBe(content);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120000);
