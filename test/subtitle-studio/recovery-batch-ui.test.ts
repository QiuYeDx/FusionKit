import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';

it.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('selects, confirms once and clears unreadable documents with isolated failures through real Electron IPC', async () => {
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'studio-recovery-batch-')));
  const profile = path.join(root, 'profile'), repositoryRoot = path.join(profile, 'subtitle-studio', 'documents');
  const artifacts = path.resolve('test-results/studio-recovery-batch'); await mkdir(artifacts, { recursive: true });
  const content = '[00:01.00]Keep this original subtitle.\n';
  const source = path.join(root, 'original.lrc'), exported = path.join(root, 'exported.lrc');
  await writeFile(source, content); await writeFile(exported, content);
  const healthy = importSubtitleText(content, { format: 'lrc', displayName: 'healthy.lrc', encoding: 'utf-8',
    digest: createHash('sha256').update(content).digest('hex') }, randomUUID);
  await new DocumentRepository(repositoryRoot).create(healthy);
  const makeBroken = async () => {
    const id = randomUUID(), directory = path.join(repositoryRoot, id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'current.json'), '{"unreadable":true}'); return { id, directory };
  };
  const broken = await Promise.all(Array.from({ length: 6 }, makeBroken));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' }, timeout: 60000 });
    const page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
    await page.reload();
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
    await page.locator('aside').getByTestId('studio-recovery-manage').click();
    const dialog = page.getByRole('dialog'); const rows = dialog.locator('.studio-document-row');
    await uiExpect(rows).toHaveCount(6);
    await uiExpect(dialog.getByRole('button', { name: '清理所选（0）', exact: true })).toBeDisabled();
    for (const doc of broken.slice(0, 2)) await dialog.getByRole('checkbox', { name: `选择文档 ${doc.id}`, exact: true }).check();
    await uiExpect(dialog.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute('data-state', 'indeterminate');
    await dialog.getByRole('button', { name: '清理所选（2）', exact: true }).click();
    await uiExpect(page.getByTestId('studio-recovery-confirm')).toContainText('所选 2 份');
    await uiExpect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    for (const doc of broken) expect(await readdir(doc.directory)).toEqual(['current.json']);
    await dialog.getByRole('checkbox', { name: '全选', exact: true }).check();
    await uiExpect(dialog.getByText('已选 6 / 6 份', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'selection-light.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '清理所选（6）', exact: true }).click();
    // A stale token must fail only its own item. Newly discovered files were not confirmed.
    await writeFile(path.join(broken[0].directory, 'current.json'), '{"unreadable":"changed after confirmation"}');
    const later = await makeBroken();
    await dialog.getByRole('button', { name: '确认清除', exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
    });
    await uiExpect(dialog.getByRole('alert')).toHaveText('已清理 5 份文档，1 份未能清理。');
    await uiExpect(rows).toHaveCount(2);
    await uiExpect(dialog.getByTestId(`studio-recovery-item-${broken[0].id}`)).toContainText('清理失败');
    await uiExpect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    expect(await readdir(later.directory)).toEqual(['current.json']);
    expect(await readdir(broken[0].directory)).toEqual(['current.json']);
    for (const doc of broken.slice(1)) await expect(readdir(doc.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await page.screenshot({ path: path.join(artifacts, 'partial-failure-light.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => { localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'dark' }, version: 0 })); });
    await win.evaluate(window => window.setSize(786, 540)); await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark') && !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await page.getByTestId('studio-recovery-warning').getByRole('button', { name: '查看', exact: true }).click();
    await dialog.getByRole('checkbox', { name: '全选', exact: true }).check();
    await dialog.getByRole('button', { name: '清理所选（2）', exact: true }).click();
    await uiExpect(page.getByTestId('studio-recovery-confirm')).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'confirmation-narrow-dark.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.getByTestId(`studio-recovery-item-${broken[0].id}`).getByRole('button', { name: '清除残留文档', exact: true }).click();
    await uiExpect(page.getByTestId('studio-recovery-confirm')).toContainText('这份文档');
    await dialog.getByRole('button', { name: '确认清除', exact: true }).click();
    await uiExpect(rows).toHaveCount(1);
    await dialog.getByRole('checkbox', { name: '全选', exact: true }).check();
    await dialog.getByRole('button', { name: '清理所选（1）', exact: true }).click();
    await dialog.getByRole('button', { name: '确认清除', exact: true }).click();
    await uiExpect(rows).toHaveCount(0);
    await uiExpect(dialog.getByText('没有待处理的残留文档。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const snapshot = await page.evaluate(() => window.subtitleStudio.listDocuments({ offset: 0 }));
    expect(snapshot).toMatchObject({ ok: true, value: { total: 1, unavailableDocuments: 0 } });
    expect(await readFile(source, 'utf8')).toBe(content); expect(await readFile(exported, 'utf8')).toBe(content);
    expect(await new DocumentRepository(repositoryRoot).read(healthy.id)).toMatchObject({ id: healthy.id });
    expect(errors).toEqual([]);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}, 120000);
