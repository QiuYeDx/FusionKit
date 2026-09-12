import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { _electron as electron, expect as uiExpect, type ElectronApplication } from 'playwright/test';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';

it.runIf(process.env.FUSIONKIT_STUDIO_TRANSCRIPTION_UI === '1')('renders stored media documents and preserves subtitle-only download semantics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-transcript-ui-'));
  const profile = path.join(root, 'profile');
  const artifacts = path.resolve('test-results/studio-transcription-document-ui');
  const repository = new DocumentRepository(path.join(profile, 'subtitle-studio', 'documents'));
  const media = transcriptToDocument({ schemaVersion: 1, source: { displayName: '访谈记录 · Interview with detailed timing.wav', durationMs: 315000 },
    model: { engine: 'whisper_cpp', modelId: 'tiny', modelHash: 'a'.repeat(64), backend: 'cpu' }, detectedLanguage: 'en',
    segments: Array.from({ length: 105 }, (_, index) => ({ id: `segment-${index}`, startMs: index * 3000, endMs: index * 3000 + 2000,
      text: index === 2 ? 'A longer line keeps every word from the original transcript, including details that stay in the document after translation.' : `Interview sentence ${index + 1}.`,
      speaker: 'Speaker A', confidence: 0.92 })),
  });
  const subtitle = importSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nOriginal subtitle\n',
    { format: 'srt', displayName: 'original-subtitle.srt', encoding: 'utf-8', digest: 'b'.repeat(64) }, randomUUID);
  const locale = JSON.parse(await readFile(path.resolve('src/locales/zh/studio.json'), 'utf8'));
  let app: ElectronApplication | undefined;
  try {
    await mkdir(artifacts, { recursive: true });
    await repository.create(media); await repository.create(subtitle);
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(), env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { localStorage.setItem('lang', 'zh'); localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })); location.hash = '/tools/subtitle/studio'; });
    await page.reload();
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    await uiExpect(page.locator('.studio-preview-region')).toHaveAttribute('aria-busy', 'false');
    const window = await app.browserWindow(page);
    await window.evaluate(win => win.setSize(1280, 860));
    await page.getByTestId('studio-library-row').filter({ hasText: media.origin.displayName }).locator('button.studio-document').click();
    await uiExpect(page.getByRole('heading', { name: media.origin.displayName, exact: true })).toBeVisible();
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
    await uiExpect(page.locator('.studio-document-heading')).not.toContainText('UTF-8');
    await page.screenshot({ path: path.join(artifacts, 'media-preview.png'), animations: 'disabled' });
    const paged = await page.evaluate(async id => {
      const listing = await window.subtitleStudio.listDocuments({ offset: 0 });
      if (!listing.ok) throw new Error(listing.error);
      const doc = listing.value.documents.find(doc => doc.id === id)!;
      return window.subtitleStudio.readDocumentPage({ documentId: id, revision: doc.revision, offset: 100 });
    }, media.id);
    expect(paged.ok && paged.value.cues.length).toBe(5);
    expect(paged.ok && paged.value.rawNodes).toEqual([]);
    const preview = page.locator('.studio-preview-panel');
    await preview.getByRole('button', { name: locale.next, exact: true }).click();
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(5);
    await uiExpect(page.locator('.studio-cue-table')).toContainText('Interview sentence 105.');
    await page.screenshot({ path: path.join(artifacts, 'media-next-page.png'), animations: 'disabled' });
    await preview.getByRole('button', { name: locale.previous, exact: true }).click();
    await uiExpect(page.locator('.studio-cue-table tbody tr')).toHaveCount(100);
    await page.getByRole('button', { name: locale.batch.download_single, exact: true }).click();
    await uiExpect(page.getByTestId('studio-download-menu').getByRole('menuitem', { name: locale.export_source, exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: locale.export.action, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await uiExpect(dialog.getByLabel(locale.export.format, { exact: true })).toHaveText('SRT');
    await dialog.getByRole('button', { name: locale.export.prepare, exact: true }).click();
    await uiExpect(dialog.locator('[data-issue="transcription_evidence_omitted"]')).toBeVisible();
    const save = dialog.getByRole('button', { name: locale.export.save, exact: true });
    await uiExpect(save).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, 'media-export-loss.png'), animations: 'disabled' });
    await dialog.getByRole('checkbox', { name: locale.export.accept_losses, exact: true }).check();
    const output = path.join(root, 'interview.srt');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    await save.click();
    await uiExpect(dialog).toHaveCount(0);
    expect(await readFile(output, 'utf8')).toContain('Interview sentence 105.');
    await page.getByTestId('studio-library-row').filter({ hasText: subtitle.origin.displayName }).locator('button.studio-document').click();
    await uiExpect(page.getByRole('heading', { name: subtitle.origin.displayName, exact: true })).toBeVisible();
    await page.getByRole('button', { name: locale.batch.download_single, exact: true }).click();
    await uiExpect(page.getByTestId('studio-download-menu').getByRole('menuitem', { name: locale.export_source, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'subtitle-download.png'), animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally { try { await app?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 120000);
