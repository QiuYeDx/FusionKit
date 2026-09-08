import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Opt-in: this suite launches the real built application with disposable userData.
const enabled = process.env.FUSIONKIT_STUDIO_E2E === '1';
const nativeDialogs = process.env.FUSIONKIT_STUDIO_NATIVE_DIALOGS === '1';
describe.runIf(enabled)(`Subtitle Studio production Electron integration (${nativeDialogs ? 'native dialogs' : 'dialog responses controlled'})`, () => {
  let application: ElectronApplication | undefined;
  let page: Page;
  let root: string;
  const artifacts = path.resolve('test-results/subtitle-studio');
  const errors: string[] = [];
  const fixtures = {
    'sample.srt': '\ufeff7\r\n00:00:01,000 --> 00:00:03,000\r\nHello <b>world</b>\r\nSecond line\r\n\r\n42\r\n00:00:02,000 --> 00:00:04,000\r\n<script>window.studioInjected=true</script>\r\n',
    'sample.lrc': '[ar:synthetic]\n[offset:-1500]\n[00:01.00][00:02.50]Hello\n[00:01.00]Different\n',
  };
  async function launch() {
    application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }, timeout: 30000 });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
  }
  afterAll(async () => {
    try { await application?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  it('imports SRT/LRC through production IPC, previews, persists and exports after restart', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-electron-'));
    await mkdir(artifacts, { recursive: true });
    for (const [name, content] of Object.entries(fixtures)) await writeFile(path.join(root, name), content);
    await launch();
    for (const [name, content] of Object.entries(fixtures)) {
      if (nativeDialogs) console.log(`Native import selection: ${path.join(root, name)}`);
      else await application!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.join(root, name));
      const imported = await page.evaluate(() => window.subtitleStudio.importSubtitle({ encoding: 'utf-8' }));
      expect(imported.ok).toBe(true);
      if (!imported.ok || !imported.value) throw new Error('No imported document');
      const summary = imported.value;
      const preview = await page.evaluate(doc => window.subtitleStudio.readDocumentPage({ documentId: doc.id, revision: doc.revision, offset: 0 }), summary);
      expect(preview.ok).toBe(true);
      expect(await readFile(path.join(root, name), 'utf8')).toBe(content);
      await rename(path.join(root, name), path.join(root, `${name}.moved`));
    }
    await application!.close(); application = undefined;
    await launch();
    const restored = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Restore failed');
    expect(restored.value.total).toBe(2);
    for (const doc of restored.value.documents) {
      const output = path.join(root, `export-${doc.origin.displayName}`);
      if (nativeDialogs) console.log(`Native export destination: ${output}`);
      else await application!.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, output);
      const result = await page.evaluate(summary => window.subtitleStudio.exportSource({ documentId: summary.id, revision: summary.revision }), doc);
      expect(result.ok).toBe(true);
      expect(await readFile(output, 'utf8')).toBe(fixtures[doc.origin.displayName as keyof typeof fixtures]);
      await page.getByRole('button', { name: new RegExp(doc.origin.displayName) }).click();
      await page.getByRole('heading', { name: doc.origin.displayName }).waitFor();
      await page.screenshot({ path: path.join(artifacts, `${doc.origin.format}-desktop.png`), fullPage: true });
    }
    expect(await page.evaluate(() => (window as unknown as { studioInjected?: boolean }).studioInjected)).toBeUndefined();
    const window = await application!.browserWindow(page);
    await window.evaluate(win => win.setSize(786, 540));
    await page.screenshot({ path: path.join(artifacts, 'narrow.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  }, nativeDialogs ? 300000 : 90000);
});
