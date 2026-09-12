import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedResourceCopyTransport, createResourceCleanupGate, fingerprintResourceFile, prepareRealDefaultResources, realDefaultResourceLayout, removeEmptyResourceRoot } from './real-default-resource-fixture';
import type { DownloadLocalSubtitleResourceOptions } from '../../electron/main/subtitle-studio/transcription/native/resource-download';

const roots: string[] = [];
async function fixture(bytes = Buffer.from('pinned real resource bytes')) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-default-resource-unit-'))); roots.push(root);
  const source = path.join(root, 'source.bin'), managed = path.join(root, 'managed'), staging = path.join(managed, 'staging');
  await mkdir(staging, { recursive: true }); await writeFile(source, bytes);
  const file = await fingerprintResourceFile(source), url = 'https://fixed.example/resource.bin';
  const transport = createPinnedResourceCopyTransport(managed, [{ sourceUrl: url, file }]);
  const options: DownloadLocalSubtitleResourceOptions = { sourceUrl: url, expectedBytes: bytes.length,
    allowedHosts: ['fixed.example'], downloadDirectory: staging, partFileName: 'resource.part', metadataFileName: 'resource.part.json',
    destinationPath: path.join(staging, 'resource.bin'), signal: new AbortController().signal, ensureCapacity: vi.fn(async () => {}) };
  return { root, source, managed, staging, file, transport, options, bytes };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const canonical = await realpath(root);
    expect(path.dirname(canonical).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(canonical)).toMatch(/^studio-default-resource-unit-/);
    await rm(canonical, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('real default resource fixture transport and ownership', () => {
  it('copies complete pinned bytes into a distinct file and honors capacity and progress', async () => {
    const f = await fixture(); const progress = vi.fn();
    const result = await f.transport({ ...f.options, onProgress: progress });
    expect(result).toMatchObject({ byteSize: f.bytes.length, resumedBytes: 0 });
    const copied = await fingerprintResourceFile(f.options.destinationPath);
    expect(copied.sha256).toBe(f.file.sha256); expect(copied.ino).not.toBe(f.file.ino);
    expect(await fingerprintResourceFile(f.source)).toEqual(f.file);
    expect(f.options.ensureCapacity).toHaveBeenCalledWith(f.bytes.length);
    expect(progress).toHaveBeenLastCalledWith(f.bytes.length, f.bytes.length);
  });

  it('rejects unknown URLs, wrong expected sizes and unapproved hosts before writing', async () => {
    const f = await fixture();
    for (const change of [{ sourceUrl: 'https://unknown.example/resource.bin' }, { expectedBytes: f.bytes.length + 1 }, { allowedHosts: ['other.example'] }]) {
      await expect(f.transport({ ...f.options, ...change })).rejects.toThrow();
      await expect(lstat(f.options.destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses source drift even when replacement bytes keep the same length', async () => {
    const f = await fixture(); await writeFile(f.source, Buffer.alloc(f.bytes.length, 42));
    await expect(f.transport(f.options)).rejects.toThrow('Pinned resource source changed');
    await expect(lstat(f.options.destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a destination or write outside the private managed root', async () => {
    const f = await fixture(); await writeFile(f.options.destinationPath, 'owned-by-other-work');
    await expect(f.transport(f.options)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(f.options.destinationPath, 'utf8')).toBe('owned-by-other-work');
    await expect(f.transport({ ...f.options, destinationPath: path.join(f.root, 'outside.bin') })).rejects.toThrow('escaped');
    await expect(lstat(path.join(f.root, 'outside.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('joins cancellation after a chunk without altering the source or hiding owned partial output', async () => {
    const f = await fixture(Buffer.alloc(2 * 1024 * 1024, 17)), controller = new AbortController();
    await expect(f.transport({ ...f.options, signal: controller.signal, onProgress: () => controller.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    const partial = await lstat(f.options.destinationPath); expect(partial.size).toBe(1024 * 1024);
    expect(await fingerprintResourceFile(f.source)).toEqual(f.file);
    // The real manager owns this partial file and must remove its staging receipt.
    await expect(removeEmptyResourceRoot(f.root, f.managed)).rejects.toThrow('left a file');
  });

  it('rejects linked destination ancestors and preserves their external files', async () => {
    const f = await fixture(), external = path.join(f.root, 'external'); await mkdir(external);
    await symlink(external, path.join(f.managed, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.transport({ ...f.options, destinationPath: path.join(f.managed, 'junction', 'resource.bin') })).rejects.toThrow('traverses a link');
    await expect(lstat(path.join(external, 'resource.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeEmptyResourceRoot(f.root, f.managed)).rejects.toThrow('file or link');
  });

  it('preflights the whole tree before removing only empty owned resource directories', async () => {
    const f = await fixture(); const empty = path.join(f.managed, 'a-empty'); await mkdir(empty);
    const leftover = path.join(f.staging, 'manifest.json'); await writeFile(leftover, '{}');
    await expect(removeEmptyResourceRoot(f.root, f.managed)).rejects.toThrow('left a file');
    expect((await lstat(empty)).isDirectory()).toBe(true);
    await rm(leftover); await removeEmptyResourceRoot(f.root, f.managed);
    await expect(lstat(f.managed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(createHash('sha256').update(await readFile(f.source)).digest('hex')).toBe(f.file.sha256);
    await expect(removeEmptyResourceRoot(f.managed, f.root)).rejects.toThrow();
  });

  it('ordinary unit runs cannot start actual model or VAD preparation', async () => {
    vi.stubEnv('FUSIONKIT_REAL_ASR', '');
    await expect(prepareRealDefaultResources({ projectRoot: process.cwd(), runRoot: path.resolve('test-results/never-created'), modelSourcePath: 'ignored' })).rejects.toThrow('explicit FUSIONKIT_REAL_ASR=1');
  });

  it('a cleanup deadline retains the pending operation lock until real work settles', async () => {
    vi.useFakeTimers(); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const operation = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const deadline = vi.fn(), joined = vi.fn(), cleanup = createResourceCleanupGate(operation, 50, deadline, joined);
    const first = cleanup(), rejected = expect(first).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(51); await rejected;
    expect(deadline).toHaveBeenCalledTimes(1); expect(joined).not.toHaveBeenCalled();
    expect(cleanup()).toBe(first); expect(operation).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); await Promise.resolve();
    await cleanup(); expect(operation).toHaveBeenCalledTimes(2); expect(joined).toHaveBeenCalledTimes(2);
  });

  it('budgets production CUDA receipt, archive, artifacts and manifest before resource preparation', () => {
    const short = realDefaultResourceLayout(path.join(os.tmpdir(), 't8-XXXXXX'));
    expect(short.legacy.userDataRoot).toBe(path.join(os.tmpdir(), 't8-XXXXXX', 'l'));
    expect(short.studio.managedResourceRoot).toBe(path.join(os.tmpdir(), 't8-XXXXXX', 's', 'subtitle-studio', 'transcription'));
    for (const budget of short.pathBudgets) {
      expect(budget.longestArtifact).toContain('00000000-0000-0000-0000-000000000000-XXXXXX');
      expect(budget.longestArtifactLength).toBe(budget.longestArtifact.length);
      expect(budget.archiveLength).toBeGreaterThan(budget.receiptLength);
      expect(budget.manifestLength).toBeGreaterThan(budget.manifestParentLength);
    }
    const long = realDefaultResourceLayout(path.join(os.tmpdir(), 'x'.repeat(160)));
    expect(long.pathBudgets.every(budget => !budget.accepted)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('rejects the observed long mkdtemp prefix while a short owned control works', async () => {
    const f = await fixture();
    const suffix = '.install-local-subtitle-windows-x64-cuda-12.4-v1-00000000-0000-0000-0000-000000000000-';
    const originalRoot = path.join(f.root, 'x'.repeat(140 - f.root.length - 1));
    const originalStaging = path.join(originalRoot, 'accelerator-staging'); await mkdir(originalStaging, { recursive: true });
    expect(path.join(originalStaging, suffix).length).toBe(247);
    await expect(mkdtemp(path.join(originalStaging, suffix))).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
    const control = path.join(f.root, 'short'); await mkdir(control);
    const receipt = await mkdtemp(path.join(control, suffix));
    expect(receipt.length).toBeLessThanOrEqual(245); expect((await lstat(receipt)).isDirectory()).toBe(true);
  });
});
