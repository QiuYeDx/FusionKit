import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';

const srt = (name: string, lines: string[]) => importSubtitleText(lines.map((line, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index},500\n${line}\n`).join('\n'),
  { format: 'srt', displayName: name, encoding: 'utf-8', digest: 'f'.repeat(64) }, randomUUID);

describe.runIf(process.env.FUSIONKIT_STUDIO_E2E === '1')('undo history per document', () => {
  it('keeps each document its undo while others are edited and while the studio is left', async () => {
    const artifacts = path.resolve('test-results/studio-cue-history'); await mkdir(artifacts, { recursive: true });
    const profile = path.join(await mkdtemp(path.join(artifacts, 'run-')), 'profile');
    const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
    await repository.create(srt('Alpha.srt', ['A one', 'A two', 'A three']));
    await repository.create(srt('Beta.srt', ['B one', 'B two']));
    let app: ElectronApplication | undefined;
    const errors: string[] = [];
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
      const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
      const win = await app.browserWindow(page); await win.evaluate(window => window.setSize(1280, 860));
      await page.evaluate(() => {
        localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
        location.hash = '/tools/subtitle/studio';
      });
      await page.reload(); await page.getByTestId('subtitle-studio').waitFor();
      await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
      const rows = page.locator('.studio-cue-table tbody tr');
      const undo = page.getByTestId('studio-cue-undo');
      const open = async (name: string, count: number) => {
        await page.getByTestId('studio-library-row').filter({ hasText: name }).locator('button.studio-document').click();
        await uiExpect(page.locator('.studio-cue-table')).toBeVisible();
        await uiExpect(rows).toHaveCount(count);
      };
      const remove = async (index: number) => {
        await rows.nth(index).locator('.studio-cue-time').click();
        await page.getByTestId('studio-cue-toolbar-delete').click();
      };

      await open('Alpha.srt', 3);
      await remove(1);
      await uiExpect(rows).toHaveCount(2);
      await open('Beta.srt', 2);
      await uiExpect(undo).toBeDisabled();
      await remove(0);
      await uiExpect(rows).toHaveCount(1);
      // Back to the first document: its own deletion can still be undone.
      await open('Alpha.srt', 2);
      await uiExpect(undo).toHaveAccessibleName('撤销：删除 1 条字幕');
      await undo.click();
      await uiExpect(rows).toHaveCount(3);
      await uiExpect(rows.nth(1).locator('[data-field=source]')).toHaveText('A two');
      // Leaving the studio and coming back keeps the other document's history too.
      await page.evaluate(() => { location.hash = '/tools/subtitle/converter'; });
      await page.locator('#cvt-tour-queue').waitFor();
      await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
      await page.getByTestId('subtitle-studio').waitFor();
      await open('Beta.srt', 1);
      await undo.click();
      await uiExpect(rows).toHaveCount(2);
      expect(errors).toEqual([]);
    } finally { await app?.close().catch(() => undefined); }
  }, 120_000);
});
