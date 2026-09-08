import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from 'playwright/test';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('Subtitle Studio recovery and deletion in Electron', () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let root: string;
  const artifacts = path.resolve('test-results/subtitle-studio-lifecycle');
  const name = 'Long-subtitle-document-字幕工作台-永続化の検証-恢复与删除-September-2026.lrc';
  const source = '[ar:Recovery QA]\n[00:01.00]<script>window.studioInjected=true</script>\n[00:02.00]Hello\n';
  const errors: string[] = [];
  async function launch() {
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }, timeout: 30000 });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); location.hash = '/tools/subtitle/studio'; });
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
  }
  afterAll(async () => {
    try { await app?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  it('recovers one complete generation, exports without its source, confirms deletion and stays deleted after restart', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-lifecycle-'));
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(root, name), source);
    await launch();
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.join(root, name));
    await page.getByRole('button', { name: '打开字幕文件', exact: true }).click();
    await uiExpect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const list = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
    if (!list.ok) throw new Error('No imported document');
    const id = list.value.documents[0].id;
    await app!.close(); app = undefined;
    const directory = path.join(root, 'profile/subtitle-studio/documents');
    const repo = new DocumentRepository(directory);
    await repo.transact(id, 1, snapshot => {
      const trackId = randomUUID();
      snapshot.document.translationTracks.push({ id: trackId, language: 'zh', revision: 1, entries: {} });
      snapshot.tasks.push({ id: randomUUID(), trackId, generation: 1, status: 'completed', completedBatchIds: ['b1'], uncertainBatchIds: [], attempts: 1 });
    });
    await repo.transact(id, 2, snapshot => { snapshot.tasks[0].completedBatchIds.push('b2'); });
    const pointer = JSON.parse(await readFile(path.join(directory, id, 'current.json'), 'utf8'));
    await writeFile(path.join(directory, id, `${pointer.generation}.json`), 'interrupted snapshot');
    await writeFile(path.join(directory, 'index.json'), 'broken index');
    await rename(path.join(root, name), path.join(root, 'source.moved'));
    await launch();
    await uiExpect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const recovered = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
    expect(recovered).toMatchObject({ ok: true, value: { total: 1, documents: [{ id, revision: 2 }] } });
    expect((await repo.readSnapshot(id)).tasks[0].completedBatchIds).toEqual(['b1']);
    expect(await page.evaluate(() => (window as unknown as { studioInjected?: boolean }).studioInjected)).toBeUndefined();
    await uiExpect(page.locator('.studio-cue-text').first()).toContainText('<script>');
    const exported = path.join(root, 'export.lrc');
    await app!.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, exported);
    await page.getByRole('button', { name: '下载原文', exact: true }).click();
    await uiExpect(page.getByRole('status').filter({ hasText: '已下载' })).toBeVisible();
    expect(await readFile(exported, 'utf8')).toBe(source);
    const window = await app!.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 860));
    await page.getByRole('button', { name: '删除文档', exact: true }).hover();
    await uiExpect(page.getByRole('tooltip', { name: '删除文档', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'delete-action.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '删除文档', exact: true }).click();
    await uiExpect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await uiExpect(page.getByRole('dialog')).toContainText(name);
    await uiExpect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: path.join(artifacts, 'delete-confirmation-desktop.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    await uiExpect(page.getByRole('button', { name: '删除文档', exact: true })).toBeFocused();
    await uiExpect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await window.evaluate(win => win.setSize(786, 540));
    await page.getByRole('button', { name: '删除文档', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toBeVisible();
    await uiExpect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: path.join(artifacts, 'delete-confirmation-narrow.png'), animations: 'disabled' });
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole('dialog').getByRole('button', { name: '删除文档', exact: true }).click();
    await uiExpect(page.getByRole('dialog')).toHaveCount(0);
    await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    await uiExpect(page.locator('.studio-document')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'deleted.png') });
    await app!.close(); app = undefined;
    await launch();
    expect(await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }))).toMatchObject({ ok: true, value: { total: 0 } });
    expect(await readFile(exported, 'utf8')).toBe(source);
    expect(await readFile(path.join(root, 'source.moved'), 'utf8')).toBe(source);
    expect(errors).toEqual([]);
  }, 90000);
});
