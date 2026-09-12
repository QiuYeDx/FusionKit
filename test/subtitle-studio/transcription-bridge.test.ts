import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright/test';

it.runIf(process.env.FUSIONKIT_STUDIO_TRANSCRIPTION_BRIDGE === '1')('uses the built isolated Studio bridge without requiring installed ASR resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-transcription-bridge-'));
  const profile = path.join(root, 'profile');
  const selectedFile = path.join(root, 'selected-media.wav');
  // A harmless picker fixture; this test checks missing-runtime handling, not speech recognition.
  const bytes = Buffer.alloc(44); bytes.write('RIFF'); bytes.writeUInt32LE(36, 4); bytes.write('WAVE', 8);
  await writeFile(selectedFile, bytes);
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => { location.hash = '/tools/subtitle/studio'; });
    await page.getByTestId('subtitle-studio').waitFor();
    await page.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));
    const before = await page.evaluate(async () => ({
      list: await window.subtitleStudio.listTranscriptionTasks({}),
      documents: await window.subtitleStudio.listDocuments({ offset: 0 }),
      resources: await window.subtitleStudio.listTranscriptionResources({}),
      invalid: await window.subtitleStudio.selectTranscriptionMedia({ filePath: 'forged' } as never),
    }));
    expect(before.list).toEqual({ ok: true, value: [] });
    expect(before.documents.ok && before.documents.value.documents).toEqual([]);
    expect(before.resources.ok).toBe(true);
    expect(before.invalid).toEqual({ ok: false, error: 'invalid_input' });
    expect(JSON.stringify(before)).not.toContain(profile);
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, selectedFile);
    const picked = await page.evaluate(() => window.subtitleStudio.selectTranscriptionMedia({}));
    expect(picked.ok && picked.value?.items.length).toBe(1);
    if (!picked.ok || !picked.value) throw new Error('Picker failed.');
    const selected = picked.value.items[0]!;
    expect(selected.displayName).toBe('selected-media.wav');
    expect(selected.media?.fileToken).toBeTruthy();
    expect(JSON.stringify(picked)).not.toContain(root);
    const token = selected.media!.fileToken;
    expect(await page.evaluate(fileToken => window.subtitleStudio.revokeTranscriptionMedia({ fileToken }), token))
      .toEqual({ ok: true, value: { revoked: true } });
    expect(await page.evaluate(fileToken => window.subtitleStudio.revokeTranscriptionMedia({ fileToken }), token))
      .toEqual({ ok: true, value: { revoked: false } });
    // Re-registration uses a new capability after reload; the old media token stays revoked.
    await page.reload();
    await page.getByTestId('subtitle-studio').waitFor();
    expect(await page.evaluate(() => window.subtitleStudio.listTranscriptionTasks({}))).toEqual({ ok: true, value: [] });
    expect(await readFile(selectedFile)).toEqual(bytes);
    expect(errors).toEqual([]);
    const artifactRoot = path.resolve('test-results/studio-transcription-bridge');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({
      platform: process.platform, taskList: 'empty', existingDocuments: 'available',
      invalidPath: 'rejected', pickerAuthorization: 'owner-bound', sourcePreserved: true,
      runtimeProbe: selected.ok ? 'verified by existing resources' : selected.error,
      reload: 'new owner ready', pageErrors: errors,
    }, null, 2) + '\n');
  } finally {
    try { await app?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}, 120000);
