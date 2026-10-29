import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { appendFile, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localSubtitleFilesystemObjectIdentityForPath } from '../../electron/main/subtitle-studio/transcription/native/filesystem-object-identity';
import { verifyLocalSubtitleRuntimeBundle, type LocalSubtitleResourceEnvironment } from '../../electron/main/subtitle-studio/transcription/native/resource-path';
import type { NativeInputSelection } from '../../electron/main/subtitle-studio/drop-input-service';
import { MediaOutputs, OUTPUT_POLICY, OutputError, numberedName, outputIsInput, outputLimitArgs, retryWhileBusy, windowsVolumeFileSystem,
  type MediaOutputsOptions, type OutputTarget, type PartialFile } from '../../electron/main/media-converter/engine/output';
import { InputRegistry, resolveDroppedMediaPaths } from '../../electron/main/media-converter/engine/inputs';
import { MediaRuntime } from '../../electron/main/media-converter/engine/runtime';
import { keepAllTestRuns, pruneStaleRuns, removeTestRun } from '../support/staleRuns';

/**
 * Safe output (T-ENGINE-04): partials, publishing without replacing anything, the placeholder
 * fallback, overwriting through the recycle bin, batch names, `output_is_input`, space and FAT32
 * limits, the startup cleanup, and the input registry with its drop wrapper. Everything runs on
 * real files in a run folder under test-results/media-converter (never %TEMP%, FK-PIT-0099);
 * failures of the file system, the recycle bin, statfs and the volume type are injected. One test
 * lets the bundled ffmpeg write a partial (a 0.5 s lavfi tone, below normal priority) and is
 * skipped when the runtime has not been staged.
 */

const ARTIFACTS = path.join(process.cwd(), 'test-results', 'media-converter');
const GiB = 1024 ** 3;
const HUGE = { bavail: 1n << 40n, bsize: 4096n };
let root: string;
let runs = 0;

type Setup = { dir: string; out: string; state: string; outputs: MediaOutputs };
const noTrash = async () => { throw new Error('nothing may be moved to the recycle bin here'); };
async function setup(name: string, options: Partial<MediaOutputsOptions> = {}): Promise<Setup> {
  const dir = path.join(root, `${String(++runs).padStart(2, '0')}-${name}`);
  const out = path.join(dir, 'out'), state = path.join(dir, 'state');
  await mkdir(out, { recursive: true });
  const outputs = new MediaOutputs({ root: state, trashItem: noTrash, statfs: async () => HUGE, volumeFileSystem: async () => 'ntfs', sleep: async () => {}, ...options });
  return { dir, out, state, outputs };
}
const names = async (folder: string) => (await readdir(folder)).sort();
async function journal(state: string): Promise<Array<Record<string, unknown>>> {
  try { return JSON.parse(await readFile(path.join(state, 'partials.json'), 'utf8')).records; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
const identityOf = localSubtitleFilesystemObjectIdentityForPath;
const errno = (code?: string) => Object.assign(new Error(`injected ${code ?? 'error without a code'}`), code ? { code } : {});
const target = (owner: string, overrides: Partial<OutputTarget> = {}): OutputTarget =>
  ({ owner, baseName: 'clip', extension: 'mp4', conflict: 'number', inputs: [], ...overrides });
/** A partial written the way ffmpeg `-y` writes it: opened with truncation. */
async function finished(outputs: MediaOutputs, folder: string, content: string): Promise<PartialFile> {
  const partial = await outputs.createPartial(folder);
  await writeFile(partial.path, content);
  return partial;
}
/**
 * A file under `file` that another program deleted while still holding it open: Windows keeps the
 * name until the handle closes, and lstat and an exclusive create there answer EPERM. `pending`
 * is false where the file system frees the name at once.
 */
async function pendingDeletion(file: string) {
  await writeFile(file, 'being deleted');
  const handle = await open(file, 'r');
  await unlink(file);
  const pending = await lstat(file).then(() => true, error => (error as NodeJS.ErrnoException).code === 'EPERM');
  return { pending, close: () => handle.close() };
}
async function failure(promise: Promise<unknown>): Promise<OutputError> {
  try { await promise; } catch (error) { if (error instanceof OutputError) return error; throw error; }
  throw new Error('expected an output error');
}

beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  await pruneStaleRuns(ARTIFACTS, 'output-');
  root = await realpath(await mkdtemp(path.join(ARTIFACTS, 'output-')));
});
afterAll(async () => {
  if (root && !keepAllTestRuns()) await removeTestRun(root);
});

describe('partial files', () => {
  it('records the partial in partials.json before creating it, then its identity; ffmpeg-style truncation keeps the identity', async () => {
    const seen: { exists: boolean; records: Array<Record<string, unknown>> }[] = [];
    const { out, state, outputs } = await setup('partial', { fs: { open: async (file, flags) => {
      seen.push({ exists: existsSync(file), records: await journal(path.join(path.dirname(path.dirname(file)), 'state')) });
      return open(file, flags);
    } } });
    const partial = await outputs.createPartial(out);
    expect(path.basename(partial.path)).toMatch(/^\.fusionkit-media-[0-9a-f]{8}\.partial$/);
    expect(path.dirname(partial.path)).toBe(out);
    expect(seen).toEqual([{ exists: false, records: [expect.objectContaining({ id: partial.id, path: partial.path, expectedName: path.basename(partial.path), identity: null })] }]);
    expect(await journal(state)).toEqual([expect.objectContaining({ id: partial.id, path: partial.path, identity: partial.identity })]);
    expect((await lstat(partial.path)).size).toBe(0);
    expect(partial.identity).toEqual(await identityOf(partial.path));
    await writeFile(partial.path, 'x'.repeat(4096));
    await writeFile(partial.path, 'shorter');
    expect(await outputs.verifyPartial(partial)).toBe(true);
  });

  it('creates no partial without its record: an unwritable journal or a missing folder is output_dir_unwritable', async () => {
    const { dir, out } = await setup('partial-unwritable');
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'a file where the state folder should be');
    const blocked = new MediaOutputs({ root: blocker, trashItem: noTrash });
    expect((await failure(blocked.createPartial(out))).code).toBe('output_dir_unwritable');
    expect(await names(out)).toEqual([]);
    const { outputs, state } = await setup('partial-missing-folder');
    expect((await failure(outputs.createPartial(path.join(out, 'missing')))).code).toBe('output_dir_unwritable');
    expect((await failure(outputs.createPartial('relative'))).code).toBe('output_dir_unwritable');
    expect(await journal(state)).toEqual([]);
  });

  it('discards the partial and its record, but leaves a file that replaced it alone and never publishes that file', async () => {
    const { out, state, outputs } = await setup('discard');
    const plain = await finished(outputs, out, 'plain');
    expect(await outputs.discardPartial(plain)).toBe(true);
    expect(existsSync(plain.path)).toBe(false);

    const swapped = await finished(outputs, out, 'ours');
    await unlink(swapped.path);
    await writeFile(swapped.path, 'foreign');
    expect(await outputs.verifyPartial(swapped)).toBe(false);
    expect((await failure(outputs.publish(swapped, target('a')))).code).toBe('output_dir_unwritable');
    expect(await readFile(swapped.path, 'utf8')).toBe('foreign');
    expect(await names(out)).toEqual([path.basename(swapped.path)]);
    expect(await journal(state)).toEqual([]);
  });

  it('a replaced partial is not moved by the placeholder flow either', async () => {
    const { out, state, outputs } = await setup('swapped-placeholder', { fs: { link: async () => { throw errno('EISDIR'); } } });
    const swapped = await finished(outputs, out, 'ours');
    await unlink(swapped.path);
    await writeFile(swapped.path, 'foreign');
    expect((await failure(outputs.publish(swapped, target('a')))).code).toBe('output_dir_unwritable');
    expect(await readFile(swapped.path, 'utf8')).toBe('foreign');
    expect(await names(out)).toEqual([path.basename(swapped.path)]);
    expect(await journal(state)).toEqual([]);
  });
});

describe('publishing without replacing anything', () => {
  it('numbers the name, (1) then (2), by hard link, and leaves the existing file byte for byte', async () => {
    const links: string[] = [];
    const { out, state, outputs } = await setup('numbering', { fs: { link: async (from, to) => { links.push(path.basename(to)); await link(from, to); } } });
    const existing = path.join(out, 'clip.mp4');
    await writeFile(existing, 'original bytes');
    const before = { identity: await identityOf(existing), mtimeMs: (await stat(existing)).mtimeMs };

    const first = await finished(outputs, out, 'first');
    const one = await outputs.publish(first, target('a'));
    expect(one).toEqual({ path: path.join(out, 'clip (1).mp4'), replaced: false, warnings: [] });
    // A later batch: within one batch the second item would also carry output_name_collision.
    outputs.endBatch();
    const second = await finished(outputs, out, 'second');
    const two = await outputs.publish(second, target('b'));
    expect(two).toEqual({ path: path.join(out, 'clip (2).mp4'), replaced: false, warnings: [] });

    expect(await readFile(existing, 'utf8')).toBe('original bytes');
    expect({ identity: await identityOf(existing), mtimeMs: (await stat(existing)).mtimeMs }).toEqual(before);
    expect(await readFile(one.path, 'utf8')).toBe('first');
    expect(await readFile(two.path, 'utf8')).toBe('second');
    // The final names are the partials' own files, published by link without a copy.
    expect(await identityOf(one.path)).toEqual(first.identity);
    expect(await identityOf(two.path)).toEqual(second.identity);
    expect(links).toEqual(['clip.mp4', 'clip (1).mp4', 'clip.mp4', 'clip (1).mp4', 'clip (2).mp4']);
    expect(await names(out)).toEqual(['clip (1).mp4', 'clip (2).mp4', 'clip.mp4']);
    expect(await journal(state)).toEqual([]);
  });

  it.each(['EISDIR', 'EPERM', 'EXDEV', 'ENOTSUP', 'UNKNOWN', 'EWHATEVER', undefined])('a link error %s falls back to an exclusive placeholder', async code => {
    const opened: string[] = [], renamed: string[][] = [];
    let linkCalls = 0;
    const { out, state, outputs } = await setup(`link-${code ?? 'nocode'}`, { fs: {
      link: async () => { linkCalls++; throw errno(code); },
      open: async (file, flags) => { opened.push(path.basename(file)); return open(file, flags); },
      rename: async (from, to) => { renamed.push([path.basename(from), path.basename(to)]); await rename(from, to); },
    } });
    await writeFile(path.join(out, 'clip.mp4'), 'original');
    const partial = await finished(outputs, out, 'converted');
    const result = await outputs.publish(partial, target('a'));
    expect(result).toEqual({ path: path.join(out, 'clip (1).mp4'), replaced: false, warnings: [] });
    expect(await readFile(result.path, 'utf8')).toBe('converted');
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('original');
    // One failed link marks the volume; the taken name refuses the exclusive create, the free one becomes the placeholder the partial replaces.
    expect(linkCalls).toBe(1);
    expect(opened).toEqual([path.basename(partial.path), 'clip.mp4', 'clip (1).mp4']);
    expect(renamed).toEqual([[path.basename(partial.path), 'clip (1).mp4']]);
    expect(await names(out)).toEqual(['clip (1).mp4', 'clip.mp4']);
    expect(await journal(state)).toEqual([]);
  });

  it('when the rename over the placeholder fails, neither the placeholder nor the partial is left', async () => {
    const { out, state, outputs } = await setup('rename-fails', { fs: { link: async () => { throw errno('EISDIR'); }, rename: async () => { throw errno('EACCES'); } } });
    await writeFile(path.join(out, 'clip.mp4'), 'original');
    const partial = await finished(outputs, out, 'converted');
    expect((await failure(outputs.publish(partial, target('a')))).code).toBe('output_dir_unwritable');
    expect(await names(out)).toEqual(['clip.mp4']);
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('original');
    expect(await journal(state)).toEqual([]);
  });

  it('a rename that stays busy is tried five times over about 2 s, then cleaned up the same way', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const { out, state, outputs } = await setup('rename-busy', { sleep: async ms => { sleeps.push(ms); },
      fs: { link: async () => { throw errno('EISDIR'); }, rename: async () => { attempts++; throw errno('EBUSY'); } } });
    const partial = await finished(outputs, out, 'converted');
    expect((await failure(outputs.publish(partial, target('a')))).code).toBe('output_dir_unwritable');
    expect(attempts).toBe(5);
    expect(sleeps).toEqual([150, 300, 600, 950]);
    expect(await names(out)).toEqual([]);
    expect(await journal(state)).toEqual([]);
  });

  it('EBUSY and EPERM on the rename are retried and the publish then succeeds', async () => {
    const sleeps: number[] = [];
    const failures = ['EBUSY', 'EPERM'];
    const { out, outputs } = await setup('rename-retry', { sleep: async ms => { sleeps.push(ms); },
      fs: { link: async () => { throw errno('EISDIR'); }, rename: async (from, to) => { const code = failures.shift(); if (code) throw errno(code); await rename(from, to); } } });
    const partial = await finished(outputs, out, 'converted');
    const result = await outputs.publish(partial, target('a'));
    expect(await readFile(result.path, 'utf8')).toBe('converted');
    expect(sleeps).toEqual([150, 300]);
    expect(await names(out)).toEqual(['clip.mp4']);
  });

  it('a placeholder that is no longer empty is not removed after a failed rename', async () => {
    const { out, state, outputs } = await setup('placeholder-written', { fs: {
      link: async () => { throw errno('EISDIR'); },
      rename: async (_from, to) => { await writeFile(to, 'written by someone else'); throw errno('EACCES'); },
    } });
    const partial = await finished(outputs, out, 'converted');
    expect((await failure(outputs.publish(partial, target('a')))).code).toBe('output_dir_unwritable');
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('written by someone else');
    expect(await names(out)).toEqual(['clip.mp4']);
    expect(await journal(state)).toEqual([]);
  });

  it('a placeholder another program wrote into before the rename is left to it; the output takes the next name', async () => {
    let partialPath = '';
    let hijacked = false;
    const { out, state, outputs } = await setup('placeholder-hijacked', { fs: { link: async () => { throw errno('EISDIR'); } },
      identityOfPath: async file => {
        // Runs between the placeholder's create and the rename: the partial is checked there once more.
        const clip = path.join(path.dirname(file), 'clip.mp4');
        if (!hijacked && file === partialPath && existsSync(clip) && (await lstat(clip)).size === 0) {
          hijacked = true;
          await writeFile(clip, 'written by another program');
        }
        return identityOf(file);
      } });
    const partial = await finished(outputs, out, 'converted');
    partialPath = partial.path;
    const result = await outputs.publish(partial, target('a'));
    expect(hijacked).toBe(true);
    expect(result).toEqual({ path: path.join(out, 'clip (1).mp4'), replaced: false, warnings: [] });
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('written by another program');
    expect(await readFile(result.path, 'utf8')).toBe('converted');
    expect(await names(out)).toEqual(['clip (1).mp4', 'clip.mp4']);
    expect(await journal(state)).toEqual([]);
  });

  it('EPERM on the placeholder: a name something holds is skipped, a free name that refuses the create fails the publish', async () => {
    const opened: string[] = [];
    const refusing = (refused: (name: string) => boolean) => ({ link: async () => { throw errno('EISDIR'); }, open: async (file: string, flags: 'wx') => {
      if (!file.endsWith('.partial')) opened.push(path.basename(file));
      if (refused(path.basename(file))) throw errno('EPERM');
      return open(file, flags);
    } });
    const held = await setup('placeholder-eperm-held', { fs: refusing(name => name === 'clip.mp4') });
    await writeFile(path.join(held.out, 'clip.mp4'), 'a file that refuses the create');
    const result = await held.outputs.publish(await finished(held.outputs, held.out, 'converted'), target('a'));
    expect(result.path).toBe(path.join(held.out, 'clip (1).mp4'));
    expect(opened).toEqual(['clip.mp4', 'clip (1).mp4']);
    expect(await readFile(path.join(held.out, 'clip.mp4'), 'utf8')).toBe('a file that refuses the create');

    opened.length = 0;
    const free = await setup('placeholder-eperm-free', { fs: refusing(name => !name.endsWith('.partial')) });
    expect((await failure(free.outputs.publish(await finished(free.outputs, free.out, 'converted'), target('a')))).code).toBe('output_dir_unwritable');
    expect(opened).toEqual(['clip.mp4']);
    expect(await names(free.out)).toEqual([]);
    expect(await journal(free.state)).toEqual([]);
  });

  it('a name held by a file pending deletion is skipped, by link and by placeholder alike', async () => {
    for (const linkFails of [false, true]) {
      const { out, state, outputs } = await setup(`pending-${linkFails ? 'placeholder' : 'link'}`, linkFails ? { fs: { link: async () => { throw errno('EISDIR'); } } } : {});
      const held = await pendingDeletion(path.join(out, 'clip.mp4'));
      try {
        const result = await outputs.publish(await finished(outputs, out, 'converted'), target('a'));
        expect(result.path).toBe(path.join(out, held.pending ? 'clip (1).mp4' : 'clip.mp4'));
        expect(await readFile(result.path, 'utf8')).toBe('converted');
        expect(await journal(state)).toEqual([]);
      } finally { await held.close(); }
    }
  });

  it('after the placeholder rename, FAT and unknown volumes are checked by size, other volumes by identity', async () => {
    // FAT may give the renamed file another FileId: simulate it for the final name once the partial was renamed there.
    const renumbering = (): Partial<MediaOutputsOptions> => {
      let renamed = false;
      return {
        identityOfPath: async file => {
          const identity = await identityOf(file);
          return renamed && path.basename(file) === 'clip.mp4' && 'fileIdHex' in identity ? { ...identity, fileIdHex: 'f'.repeat(32) } : identity;
        },
        fs: { link: async () => { throw errno('EISDIR'); }, rename: async (from, to) => { await rename(from, to); renamed = true; } },
      };
    };
    const fat = await setup('fat-size', { volumeFileSystem: async () => 'exfat', ...renumbering() });
    const onFat = await fat.outputs.publish(await finished(fat.outputs, fat.out, 'converted'), target('a'));
    expect(onFat).toEqual({ path: path.join(fat.out, 'clip.mp4'), replaced: false, warnings: [] });
    expect(await readFile(onFat.path, 'utf8')).toBe('converted');
    expect(await names(fat.out)).toEqual(['clip.mp4']);
    // A share or a failed volume query: the file is in place, so it is not reported as failed.
    const unknown = await setup('unknown-size', { volumeFileSystem: async () => null, ...renumbering() });
    expect((await unknown.outputs.publish(await finished(unknown.outputs, unknown.out, 'converted'), target('a'))).path).toBe(path.join(unknown.out, 'clip.mp4'));
    // On FAT the size still tells a file that is not the converted one.
    const resized = await setup('fat-size-differs', { volumeFileSystem: async () => 'fat32', fs: { link: async () => { throw errno('EISDIR'); },
      rename: async (from, to) => { await rename(from, to); await appendFile(to, ' and more'); } } });
    expect((await failure(resized.outputs.publish(await finished(resized.outputs, resized.out, 'converted'), target('a')))).code).toBe('output_dir_unwritable');
    expect(await names(resized.out)).toEqual(['clip.mp4']);

    const ntfs = await setup('ntfs-identity', { volumeFileSystem: async () => 'ntfs', ...renumbering() });
    expect((await failure(ntfs.outputs.publish(await finished(ntfs.outputs, ntfs.out, 'converted'), target('a')))).code).toBe('output_dir_unwritable');
    // Not proven to be ours, so not deleted either.
    expect(await readFile(path.join(ntfs.out, 'clip.mp4'), 'utf8')).toBe('converted');
    expect(await names(ntfs.out)).toEqual(['clip.mp4']);
  });

  it('a partial name that cannot be removed after the link stays a second name of the output until the next start', async () => {
    const { out, state, outputs } = await setup('partial-name-stuck', { fs: { unlink: async file => {
      if (path.basename(file).endsWith('.partial')) throw errno('EACCES');
      await unlink(file);
    } } });
    const partial = await finished(outputs, out, 'converted');
    const result = await outputs.publish(partial, target('a'));
    expect(result.path).toBe(path.join(out, 'clip.mp4'));
    expect(await identityOf(partial.path)).toEqual(await identityOf(result.path));
    expect(await journal(state)).toEqual([expect.objectContaining({ id: partial.id })]);
    const restarted = new MediaOutputs({ root: state, trashItem: noTrash, sleep: async () => {} });
    expect(await restarted.cleanupAtStartup()).toEqual({ deleted: 1, removed: 0, kept: 0, workCleared: true });
    expect(await names(out)).toEqual(['clip.mp4']);
    expect(await readFile(result.path, 'utf8')).toBe('converted');
  });

  it('a numbered name beyond the path limit is output_path_too_long', async () => {
    const { out, outputs } = await setup('numbered-too-long');
    const baseName = 'n'.repeat(OUTPUT_POLICY.maxPathChars - out.length - 1 - '.mp4'.length);
    await writeFile(path.join(out, `${baseName}.mp4`), 'taken');
    expect(path.join(out, `${baseName}.mp4`)).toHaveLength(OUTPUT_POLICY.maxPathChars);
    const partial = await finished(outputs, out, 'converted');
    expect((await failure(outputs.publish(partial, target('a', { baseName })))).code).toBe('output_path_too_long');
    expect(await names(out)).toEqual([`${baseName}.mp4`]);
  });
});

describe('overwriting', () => {
  async function withTrash(name: string, options: Partial<MediaOutputsOptions> = {}) {
    const trashed: string[] = [];
    const context = await setup(name, { trashItem: async file => {
      trashed.push(file);
      await mkdir(path.join(path.dirname(path.dirname(file)), 'trash'), { recursive: true });
      await rename(file, path.join(path.dirname(path.dirname(file)), 'trash', path.basename(file)));
    }, ...options });
    return { ...context, trashed };
  }

  it('moves the old file to the recycle bin before the new one takes its name', async () => {
    const { dir, out, state, outputs, trashed } = await withTrash('overwrite');
    await writeFile(path.join(out, 'clip.mp4'), 'old');
    const result = await outputs.publish(await finished(outputs, out, 'new'), target('a', { conflict: 'overwrite' }));
    expect(result).toEqual({ path: path.join(out, 'clip.mp4'), replaced: true, warnings: [] });
    expect(trashed).toEqual([path.join(out, 'clip.mp4')]);
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('new');
    expect(await readFile(path.join(dir, 'trash', 'clip.mp4'), 'utf8')).toBe('old');
    expect(await names(out)).toEqual(['clip.mp4']);
    expect(await journal(state)).toEqual([]);

    const fresh = await outputs.publish(await finished(outputs, out, 'other'), target('b', { conflict: 'overwrite', baseName: 'new-name' }));
    expect(fresh).toEqual({ path: path.join(out, 'new-name.mp4'), replaced: false, warnings: [] });
    expect(trashed).toHaveLength(1);
  });

  it('names the file an overwrite would replace, for the confirmation before start', async () => {
    const { out, outputs } = await setup('would-replace');
    expect(await outputs.wouldReplace(out, 'clip', 'mp4')).toBeNull();
    await writeFile(path.join(out, 'clip.mp4'), 'old');
    expect(await outputs.wouldReplace(out, 'clip', '.mp4')).toBe('clip.mp4');
    await mkdir(path.join(out, 'folder.mp4'));
    expect(await outputs.wouldReplace(out, 'folder', 'mp4')).toBeNull();
  });

  it('keeps the old file and reports overwrite_trash_failed when the recycle bin refuses it', async () => {
    const { out, state, outputs } = await setup('trash-fails', { trashItem: async () => { throw new Error('Failed to move item to trash'); } });
    await writeFile(path.join(out, 'clip.mp4'), 'old');
    expect((await failure(outputs.publish(await finished(outputs, out, 'new'), target('a', { conflict: 'overwrite' })))).code).toBe('overwrite_trash_failed');
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('old');
    expect(await names(out)).toEqual(['clip.mp4']);
    expect(await journal(state)).toEqual([]);
  });

  it('a recycle bin that reports success but leaves the file never leads to replacing it', async () => {
    const { out, outputs } = await setup('trash-lies', { trashItem: async () => {} });
    await writeFile(path.join(out, 'clip.mp4'), 'old');
    expect((await failure(outputs.publish(await finished(outputs, out, 'new'), target('a', { conflict: 'overwrite' })))).code).toBe('overwrite_trash_failed');
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('old');
    expect(await names(out)).toEqual(['clip.mp4']);
  });

  it('never moves a file pending deletion to the recycle bin: the output is numbered', async () => {
    const { out, outputs } = await setup('overwrite-pending');
    const held = await pendingDeletion(path.join(out, 'clip.mp4'));
    try {
      const result = await outputs.publish(await finished(outputs, out, 'new'), target('a', { conflict: 'overwrite' }));
      expect(result).toEqual({ path: path.join(out, held.pending ? 'clip (1).mp4' : 'clip.mp4'), replaced: false, warnings: [] });
      expect(await readFile(result.path, 'utf8')).toBe('new');
    } finally { await held.close(); }
  });

  it('never moves a folder or an input to the recycle bin', async () => {
    const { out, outputs, trashed } = await withTrash('overwrite-guards');
    await mkdir(path.join(out, 'clip.mp4'));
    const numbered = await outputs.publish(await finished(outputs, out, 'new'), target('a', { conflict: 'overwrite' }));
    expect(numbered.path).toBe(path.join(out, 'clip (1).mp4'));

    const input = path.join(out, 'source.mp4');
    await writeFile(input, 'the input');
    const refused = await failure(outputs.publish(await finished(outputs, out, 'new'), target('b', { conflict: 'overwrite', baseName: 'source', inputs: [input] })));
    expect(refused.code).toBe('output_is_input');
    expect(await readFile(input, 'utf8')).toBe('the input');
    expect(trashed).toEqual([]);
    expect(await names(out)).toEqual(['clip (1).mp4', 'clip.mp4', 'source.mp4']);
  });
});

describe('names within a batch', () => {
  const request = (owner: string, out: string, overrides: Partial<OutputTarget> = {}) => ({ ...target(owner, overrides), directory: out, capBytes: 1024 });

  it('two items resolving to one name: the second is numbered and warned, whichever publishes first', async () => {
    const { out, outputs } = await setup('collision');
    expect(await outputs.preflight(request('a', out))).toEqual({ target: path.join(out, 'clip.mp4'), warnings: [] });
    expect(await outputs.preflight(request('b', out))).toEqual({ target: path.join(out, 'clip.mp4'), warnings: ['output_name_collision'] });
    const b = await outputs.publish(await finished(outputs, out, 'b'), target('b'));
    expect(b).toEqual({ path: path.join(out, 'clip (1).mp4'), replaced: false, warnings: ['output_name_collision'] });
    const a = await outputs.publish(await finished(outputs, out, 'a'), target('a'));
    expect(a).toEqual({ path: path.join(out, 'clip.mp4'), replaced: false, warnings: [] });
    expect(await readFile(a.path, 'utf8')).toBe('a');
    expect(await readFile(b.path, 'utf8')).toBe('b');
  });

  it('with overwrite, an item never replaces a name another item of the batch holds; after the batch it may', async () => {
    const trashed: string[] = [];
    const { dir, out, outputs } = await setup('collision-overwrite', { trashItem: async file => {
      trashed.push(path.basename(file));
      await rename(file, path.join(dir, `trashed-${trashed.length}`));
    } });
    await writeFile(path.join(out, 'clip.mp4'), 'old');
    const overwrite = { conflict: 'overwrite' as const };
    expect((await outputs.preflight(request('a', out, overwrite))).warnings).toEqual([]);
    expect(await outputs.publish(await finished(outputs, out, 'a'), target('a', overwrite))).toEqual({ path: path.join(out, 'clip.mp4'), replaced: true, warnings: [] });
    expect((await outputs.preflight(request('b', out, overwrite))).warnings).toEqual(['output_name_collision']);
    expect(await outputs.publish(await finished(outputs, out, 'b'), target('b', overwrite)))
      .toEqual({ path: path.join(out, 'clip (1).mp4'), replaced: false, warnings: ['output_name_collision'] });
    expect(await readFile(path.join(out, 'clip.mp4'), 'utf8')).toBe('a');
    expect(trashed).toEqual(['clip.mp4']);

    outputs.endBatch();
    expect((await outputs.preflight(request('c', out, overwrite))).warnings).toEqual([]);
    expect(await outputs.publish(await finished(outputs, out, 'c'), target('c', overwrite))).toEqual({ path: path.join(out, 'clip.mp4'), replaced: true, warnings: [] });
    expect(trashed).toEqual(['clip.mp4', 'clip.mp4']);
    expect(await readFile(path.join(dir, 'trashed-2'), 'utf8')).toBe('a');
  });

  it('an item that stops without publishing gives its name back', async () => {
    const { out, outputs } = await setup('collision-release');
    await outputs.preflight(request('a', out));
    outputs.release('a');
    expect((await outputs.preflight(request('b', out))).warnings).toEqual([]);
  });
});

describe('output_is_input', () => {
  const request = (out: string, inputs: string[], overrides: Partial<OutputTarget> = {}) => ({ ...target('a', { inputs, ...overrides }), directory: out, capBytes: 1024 });

  it('refuses a target that is an input under another case or a hard link of one; other files pass', async () => {
    const { out, outputs } = await setup('output-is-input');
    const input = path.join(out, 'Clip.mp4');
    await writeFile(input, 'input');
    expect((await failure(outputs.preflight(request(out, [input], { baseName: 'clip', extension: 'MP4' })))).code).toBe('output_is_input');

    const source = path.join(out, 'source.mkv');
    await writeFile(source, 'another input');
    await link(source, path.join(out, 'linked.mp4'));
    expect((await failure(outputs.preflight(request(out, [source], { baseName: 'linked' })))).code).toBe('output_is_input');

    await writeFile(path.join(out, 'unrelated.mp4'), 'not an input');
    expect((await outputs.preflight(request(out, [input, source], { baseName: 'unrelated' }))).warnings).toEqual([]);
    expect(await outputIsInput(path.join(out, 'absent.mp4'), [input, source])).toBe(false);
    expect(await outputIsInput(input, [path.join(out, 'gone.mp4'), input.toUpperCase()])).toBe(true);
  });

  it('with an all-zero FileId, compares the real paths: the same file is refused, another file with a zero FileId is not', async () => {
    const zeroed = async (file: string) => {
      const identity = await identityOf(file);
      return 'fileIdHex' in identity ? { ...identity, fileIdHex: '0'.repeat(32) } : { ...identity, ino: 0 };
    };
    const { out, outputs } = await setup('output-is-input-zero', { identityOfPath: zeroed });
    const input = path.join(out, 'Clip.mp4');
    await writeFile(input, 'input');
    expect((await failure(outputs.preflight(request(out, [input], { baseName: 'clip' })))).code).toBe('output_is_input');
    await writeFile(path.join(out, 'other.mp4'), 'another file, same zero FileId');
    expect((await outputs.preflight(request(out, [input], { baseName: 'other' }))).warnings).toEqual([]);
    expect(await outputIsInput(path.join(out, 'other.mp4'), [input], { identityOfPath: zeroed })).toBe(false);
  });
});

describe('space and volume limits', () => {
  it('sums the caps of the running outputs on one volume against its free space plus 512 MB', async () => {
    const free = 2.5 * GiB;
    const { dir, out, outputs } = await setup('space', {
      statfs: async () => ({ bavail: BigInt(free / 4096), bsize: 4096n }),
      volumeOf: async folder => folder.includes('other-volume') ? 'volume-b' : 'volume-a',
    });
    const otherVolume = path.join(dir, 'other-volume');
    await mkdir(otherVolume);
    const request = (owner: string, directory: string, capBytes: number) => ({ ...target(owner), directory, capBytes });

    await outputs.preflight(request('a', out, GiB));
    await outputs.preflight(request('a', out, GiB)); // Its own reservation is not counted twice.
    const low = await failure(outputs.preflight(request('b', out, 1.25 * GiB)));
    expect(low.code).toBe('disk_space_low');
    expect(low.space).toEqual({ requiredBytes: GiB + 1.25 * GiB + 512 * 1024 * 1024, availableBytes: free });
    // The same cap fits on its own, on another volume, and here once the first output ended.
    await outputs.preflight(request('c', otherVolume, 1.25 * GiB));
    outputs.release('a');
    await outputs.preflight(request('d', out, 1.25 * GiB));
    await outputs.preflight(request('e', out, 0.75 * GiB));
    outputs.release('e');
    expect((await failure(outputs.preflight(request('e', out, 0.75 * GiB + 1)))).code).toBe('disk_space_low');
  });

  it('refuses a cap over 4 GiB on FAT32 before starting, and asks the volume type only for such a cap', async () => {
    const asked: string[] = [];
    let type = 'fat32';
    const { out, outputs } = await setup('fat32', { volumeFileSystem: async folder => { asked.push(folder); return type; } });
    const request = (owner: string, capBytes: number) => ({ ...target(owner), directory: out, capBytes });
    expect((await failure(outputs.preflight(request('a', 5 * GiB)))).code).toBe('file_too_large_for_volume');
    await outputs.preflight(request('b', OUTPUT_POLICY.fatMaxFileBytes));
    expect(asked).toEqual([out]);

    type = 'exfat';
    const { out: exfatOut, outputs: exfat } = await setup('exfat', { volumeFileSystem: async () => type });
    await exfat.preflight({ ...target('a'), directory: exfatOut, capBytes: 5 * GiB });
    const { out: unknownOut, outputs: unknown } = await setup('volume-unknown', { volumeFileSystem: async () => null });
    await unknown.preflight({ ...target('a'), directory: unknownOut, capBytes: 5 * GiB });
  });

  it('the default volume query names the file system of a drive and gives up on a UNC path', async () => {
    if (process.platform !== 'win32') return;
    expect(await windowsVolumeFileSystem(root)).toMatch(/^(ntfs|refs|fat32|exfat|fat)$/);
    expect(await windowsVolumeFileSystem('\\\\server\\share\\folder')).toBeNull();
    expect(await windowsVolumeFileSystem(root, 'darwin')).toBeNull();
  }, 30_000);

  it('refuses a missing folder, a file as folder and an overlong path before anything is written', async () => {
    const { out, outputs, state } = await setup('preflight-refusals');
    const request = (directory: string, baseName = 'clip') => ({ ...target('a', { baseName }), directory, capBytes: 1024 });
    expect((await failure(outputs.preflight(request(path.join(out, 'missing'))))).code).toBe('output_dir_unwritable');
    await writeFile(path.join(out, 'file'), '');
    expect((await failure(outputs.preflight(request(path.join(out, 'file'))))).code).toBe('output_dir_unwritable');
    const tooLong = 'n'.repeat(OUTPUT_POLICY.maxPathChars - out.length - 1 - '.mp4'.length + 1);
    expect((await failure(outputs.preflight(request(out, tooLong)))).code).toBe('output_path_too_long');
    expect(await outputs.preflight(request(out, tooLong.slice(1)))).toEqual({ target: path.join(out, `${tooLong.slice(1)}.mp4`), warnings: [] });
    expect(await names(out)).toEqual(['file']);
    expect(existsSync(state)).toBe(false);
  });

  it('every output carries -fs <cap>, and -t max(duration × 1.05, duration + 10 s) when the duration is known', () => {
    expect(outputLimitArgs(1000, null)).toEqual(['-fs', '1000']);
    expect(outputLimitArgs(1000, 100_000_000)).toEqual(['-fs', '1000', '-t', '110.000000']);
    expect(outputLimitArgs(1000, 1_000_000_000)).toEqual(['-fs', '1000', '-t', '1050.000000']);
    expect(outputLimitArgs(1000, 1_500_000)).toEqual(['-fs', '1000', '-t', '11.500000']);
    expect(outputLimitArgs(1000, 400_000_001)).toEqual(['-fs', '1000', '-t', '420.000002']);
    expect(() => outputLimitArgs(0, null)).toThrow(TypeError);
    expect(() => outputLimitArgs(1.5, null)).toThrow(TypeError);
  });

  it('numbered names and busy retries follow the policy', async () => {
    expect(numberedName('clip', 'mp4', 0)).toBe('clip.mp4');
    expect(numberedName('clip', '.mkv', 2)).toBe('clip (2).mkv');
    expect(numberedName('clip.track1.eng', 'm4a', 1)).toBe('clip.track1.eng (1).m4a');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a"b', 'a\u0001b', 'CON', 'nul', 'com1', 'Aux.track1', 'lpt9. ']) {
      expect(() => numberedName(bad, 'mp4', 0), bad).toThrow(TypeError);
    }
    expect(numberedName('console', 'mp4', 0)).toBe('console.mp4');
    expect(numberedName('_con.track1', 'm4a', 0)).toBe('_con.track1.m4a');
    expect(() => numberedName('clip', 'm p4', 0)).toThrow(TypeError);

    const sleeps: number[] = [];
    let calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw errno('EBUSY'); }, async ms => { sleeps.push(ms); })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(5);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(2000);
    calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw errno('EACCES'); }, async () => {})).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toBe(1);
    expect(await retryWhileBusy(async () => (++calls > 3 ? 'done' : Promise.reject(errno('EPERM'))), async () => {})).toBe('done');
  });
});

describe('startup cleanup', () => {
  function freeDriveLetter() {
    for (const letter of 'QRSTUVWXYZJKLMNOP') if (!existsSync(`${letter}:\\`)) return letter;
    throw new Error('no free drive letter');
  }

  it('deletes matching leftovers, drops records of files that are gone or not ours, keeps unmounted and failed ones, and empties work/', async () => {
    const { dir, out, state, outputs: crashed } = await setup('cleanup');
    const matching = await finished(crashed, out, 'leftover');
    const busy = await finished(crashed, out, 'busy leftover');
    const gone = await crashed.createPartial(out);
    await unlink(gone.path);
    const foreign = await crashed.createPartial(out);
    await unlink(foreign.path);
    await writeFile(foreign.path, 'not ours');
    const locked = await finished(crashed, out, 'locked');
    const removedFolder = path.join(dir, 'removed-folder');
    await mkdir(removedFolder);
    const inRemovedFolder = await crashed.createPartial(removedFolder);
    await rm(removedFolder, { recursive: true });

    const records = await journal(state);
    expect(records).toHaveLength(6);
    const volume = records[0].volume as string;
    const record = (id: string, file: string, identity: unknown, recordVolume = volume) =>
      ({ id, path: file, expectedName: `.fusionkit-media-${id}.partial`, volume: recordVolume, identity, createdAt: 1 });
    const unmounted = record('abcdef01', `${freeDriveLetter()}:\\media\\.fusionkit-media-abcdef01.partial`, matching.identity);
    const swappedPath = path.join(out, '.fusionkit-media-0123abcd.partial');
    await writeFile(swappedPath, 'on another volume');
    const swapped = record('0123abcd', swappedPath, await identityOf(swappedPath), 'another-volume');
    const emptyPath = path.join(out, '.fusionkit-media-e0e0e0e0.partial');
    await writeFile(emptyPath, '');
    const nonEmptyPath = path.join(out, '.fusionkit-media-e1e1e1e1.partial');
    await writeFile(nonEmptyPath, 'data');
    const important = path.join(out, 'important.txt');
    await writeFile(important, 'keep me');
    const tampered = { ...record('deadbeef', important, await identityOf(important)) };
    await writeFile(path.join(state, 'partials.json'), JSON.stringify({ version: 1, records: [...records, unmounted, swapped,
      record('e0e0e0e0', emptyPath, null), record('e1e1e1e1', nonEmptyPath, null), tampered] }));
    await mkdir(path.join(state, 'work', 'job-1', 'nested'), { recursive: true });
    await writeFile(path.join(state, 'work', 'job-1', 'nested', 'pass.log'), 'log');
    await writeFile(path.join(state, 'work', 'stray.txt'), 'stray');

    let busyFailures = 2;
    const sleeps: number[] = [];
    const restarted = new MediaOutputs({ root: state, trashItem: noTrash, sleep: async ms => { sleeps.push(ms); }, fs: { unlink: async file => {
      if (file === locked.path) throw errno('EACCES');
      if (file === busy.path && busyFailures-- > 0) throw errno('EBUSY');
      await unlink(file);
    } } });
    expect(await restarted.cleanupAtStartup()).toEqual({ deleted: 3, removed: 4, kept: 3, workCleared: true });
    expect(existsSync(matching.path)).toBe(false);
    expect(existsSync(busy.path)).toBe(false);
    expect(sleeps).toEqual([150, 300]);
    expect(existsSync(emptyPath)).toBe(false);
    expect(await readFile(foreign.path, 'utf8')).toBe('not ours');
    expect(await readFile(locked.path, 'utf8')).toBe('locked');
    expect(await readFile(swappedPath, 'utf8')).toBe('on another volume');
    expect(await readFile(nonEmptyPath, 'utf8')).toBe('data');
    expect(await readFile(important, 'utf8')).toBe('keep me');
    expect((await journal(state)).map(entry => entry.id).sort()).toEqual([locked.id, 'abcdef01', '0123abcd'].sort());
    expect(await readdir(path.join(state, 'work'))).toEqual([]);
    expect(inRemovedFolder.path.startsWith(removedFolder)).toBe(true);

    // Kept records are tried again at the next start.
    const again = new MediaOutputs({ root: state, trashItem: noTrash, sleep: async () => {} });
    expect(await again.cleanupAtStartup()).toEqual({ deleted: 1, removed: 0, kept: 2, workCleared: true });
    expect(existsSync(locked.path)).toBe(false);
    expect((await journal(state)).map(entry => entry.id).sort()).toEqual(['abcdef01', '0123abcd'].sort());
    expect(await names(out)).toEqual([path.basename(foreign.path), path.basename(swappedPath), path.basename(nonEmptyPath), 'important.txt'].sort());
  });

  it('a record whose folder is gone is kept while the nearest folder there sits on another volume', async () => {
    const { out, state, outputs: crashed } = await setup('cleanup-letter-reused');
    const removed = path.join(out, 'removed');
    await mkdir(removed);
    const partial = await crashed.createPartial(removed);
    await rm(removed, { recursive: true });
    const [record] = await journal(state);
    // The drive letter now belongs to another volume: the recorded serial is not the one mounted there.
    await writeFile(path.join(state, 'partials.json'), JSON.stringify({ version: 1, records: [{ ...record, volume: 'another-volume' }] }));
    const restarted = new MediaOutputs({ root: state, trashItem: noTrash, sleep: async () => {} });
    expect(await restarted.cleanupAtStartup()).toEqual({ deleted: 0, removed: 0, kept: 1, workCleared: true });
    expect((await journal(state)).map(entry => entry.id)).toEqual([partial.id]);
  });

  it('work directories live under work/ and are removed with their contents', async () => {
    const { state, outputs } = await setup('work');
    // `work/` is emptied at startup, so the state folder is never relative to the working directory.
    expect(() => new MediaOutputs({ root: 'relative-state', trashItem: noTrash })).toThrow(TypeError);
    const work = outputs.workDirectory('job-1');
    expect(work).toBe(path.join(state, 'work', 'job-1'));
    expect(() => outputs.workDirectory('../escape')).toThrow(TypeError);
    await mkdir(path.join(work, 'nested'), { recursive: true });
    await writeFile(path.join(work, 'nested', 'pass-0.log'), 'log');
    expect(await outputs.removeWorkDirectory('job-1')).toBe(true);
    expect(existsSync(work)).toBe(false);
  });

  it('never touches the partials of jobs running in the same session', async () => {
    const { out, state, outputs } = await setup('cleanup-live');
    const running = await finished(outputs, out, 'still encoding');
    expect(await outputs.cleanupAtStartup()).toEqual({ deleted: 0, removed: 0, kept: 0, workCleared: true });
    expect(await readFile(running.path, 'utf8')).toBe('still encoding');
    expect(await journal(state)).toEqual([expect.objectContaining({ id: running.id })]);
  });

  it('keeps an unreadable journal aside and deletes nothing on a guess', async () => {
    const { out, state } = await setup('cleanup-corrupt');
    const leftover = path.join(out, '.fusionkit-media-0badf00d.partial');
    await writeFile(leftover, 'unknown');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'partials.json'), '{ not json');
    const outputs = new MediaOutputs({ root: state, trashItem: noTrash });
    expect(await outputs.cleanupAtStartup()).toEqual({ deleted: 0, removed: 0, kept: 0, workCleared: true });
    expect(await readFile(path.join(state, 'partials.corrupt.json'), 'utf8')).toBe('{ not json');
    expect(existsSync(leftover)).toBe(true);
  });
});

describe('inputs', () => {
  it('registers a file once: another case or a hard link of it is the same item; folders and missing files are refused', async () => {
    const { out } = await setup('inputs');
    const registry = new InputRegistry();
    const file = path.join(out, 'Movie.mp4');
    await writeFile(file, 'movie');
    const first = await registry.add(file);
    if (!first.ok) throw new Error(first.code);
    expect(first.duplicate).toBe(false);
    expect(await registry.add(path.join(out, 'movie.MP4'))).toEqual({ ok: true, input: first.input, duplicate: true });
    await link(file, path.join(out, 'alias.mp4'));
    expect(await registry.add(path.join(out, 'alias.mp4'))).toEqual({ ok: true, input: first.input, duplicate: true });
    expect(registry.resolveItemPath(first.input.id)).toBe(file);
    expect(registry.describe(first.input.id)).toEqual({ displayName: 'Movie.mp4', folderName: 'out' });
    expect(registry.resolveItemPath('unknown')).toBeNull();
    expect(await registry.add(out)).toEqual({ ok: false, code: 'folder_not_supported' });
    expect(await registry.add(path.join(out, 'missing.mp4'))).toEqual({ ok: false, code: 'file_unavailable' });
    expect(await registry.add('relative.mp4')).toEqual({ ok: false, code: 'file_unavailable' });
    const [concurrentA, concurrentB] = await Promise.all([registry.add(path.join(out, 'alias.mp4')), registry.add(file)]);
    expect(concurrentA.ok && concurrentB.ok && concurrentA.input.id === first.input.id && concurrentB.input.id === first.input.id).toBe(true);
    expect(registry.paths()).toEqual([file]);
  });

  it('verify: input_changed for an edit or another file with the same size and time, input_missing when gone; refresh accepts it as it is', async () => {
    const { out } = await setup('inputs-verify');
    const file = path.join(out, 'clip.mp4');
    await writeFile(file, 'version 1');
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const registry = new InputRegistry();
    const added = await registry.add(file);
    if (!added.ok) throw new Error(added.code);
    const id = added.input.id;
    expect(await registry.verify(id)).toBeNull();

    // Same size and modification time, another file: only the FileId tells.
    await unlink(file);
    await writeFile(file, 'version 2');
    await utimes(file, 1_700_000_000, 1_700_000_000);
    expect((await lstat(file)).size).toBe(added.input.state.size);
    expect(await registry.verify(id)).toBe('input_changed');
    expect(await registry.refresh(id)).toBeNull();
    expect(await registry.verify(id)).toBeNull();

    await appendFile(file, ' edited');
    expect(await registry.verify(id)).toBe('input_changed');
    await registry.refresh(id);
    // Restored from the queue's state: the remembered state, not the file as it is now, is the reference.
    const restored = new InputRegistry();
    for (const entry of registry.entries()) restored.restore(entry);
    expect(await restored.verify(id)).toBeNull();
    await appendFile(file, ' while the app was closed');
    expect(await restored.verify(id)).toBe('input_changed');
    await unlink(file);
    expect(await registry.verify(id)).toBe('input_missing');
    expect(await registry.refresh(id)).toBe('input_missing');
    expect(await registry.verify('unknown')).toBe('input_missing');
    expect(() => restored.restore({ id: '../x', path: file, state: added.input.state })).toThrow(TypeError);
    // A damaged state.json never yields an input whose remembered state cannot be compared.
    for (const state of [undefined, null, { ...added.input.state, size: -1 }, { ...added.input.state, mtimeMs: Number.NaN },
      { ...added.input.state, objectIdentity: { fileIdHex: 'zz' } }, { size: 1, mtimeMs: 1 }]) {
      expect(() => restored.restore({ id: 'damaged', path: file, state: state as never }), JSON.stringify(state)).toThrow(TypeError);
    }
    expect(restored.restore({ id: 'no-file-id', path: file, state: { objectIdentity: null, size: 1, mtimeMs: 1 } }).state.objectIdentity).toBeNull();
  });

  it('drop: a batch the resolver refuses keeps every file that was never in %TEMP%', async () => {
    const { dir, out } = await setup('drop-batch');
    // A stand-in for %TEMP% inside the run folder: drop fixtures never live in the real one (FK-PIT-0099).
    const temp = path.join(dir, 'temp');
    await mkdir(temp);
    const proxy = path.join(temp, 'clip (1).mp4'), normal = path.join(out, 'clip.mp4'), folder = path.join(out, 'season');
    await writeFile(proxy, 'proxy');
    await writeFile(normal, 'normal');
    await mkdir(folder);
    // resolveDroppedInputPaths refuses the whole valid batch when one Explorer proxy cannot be traced back.
    const resolve = vi.fn(async (paths: readonly string[]): Promise<NativeInputSelection[]> =>
      paths.map(file => file === folder ? { fileName: 'season', error: 'invalid_input' } : { fileName: path.basename(file), error: 'access_denied' }));
    expect(await resolveDroppedMediaPaths([proxy, normal, folder], { resolve, tempDirectory: temp })).toEqual([
      { ok: false, displayName: 'clip (1).mp4', code: 'temporary_copy_unresolved' },
      { ok: true, path: normal, fileName: 'clip.mp4' },
      { ok: false, displayName: 'season', code: 'folder_not_supported' },
    ]);
    expect(resolve).toHaveBeenCalledWith([proxy, normal, folder]);
    // A resolver that throws is a refusal of the batch as well; a resolved proxy takes its source's path.
    expect(await resolveDroppedMediaPaths([proxy, normal], { resolve: async () => { throw new Error('unresolved'); }, tempDirectory: temp }))
      .toEqual([{ ok: false, displayName: 'clip (1).mp4', code: 'temporary_copy_unresolved' }, { ok: true, path: normal, fileName: 'clip.mp4' }]);
    expect(await resolveDroppedMediaPaths([proxy], { resolve: async () => [{ path: normal, fileName: 'clip.mp4' }], tempDirectory: temp }))
      .toEqual([{ ok: true, path: normal, fileName: 'clip.mp4' }]);
  });

  it('drop: maps the resolver codes, with the real resolver for paths outside %TEMP%', async () => {
    const { out } = await setup('drop-codes');
    const file = path.join(out, 'clip.mp4'), folder = path.join(out, 'folder'), missing = path.join(out, 'missing.mp4'), junction = path.join(out, 'junction');
    await writeFile(file, 'clip');
    await mkdir(folder);
    await symlink(folder, junction, 'junction');
    expect(await resolveDroppedMediaPaths([file, folder, missing, junction, 'relative.mp4'])).toEqual([
      { ok: true, path: file, fileName: 'clip.mp4' },
      { ok: false, displayName: 'folder', code: 'folder_not_supported' },
      { ok: false, displayName: 'missing.mp4', code: 'file_unavailable' },
      { ok: false, displayName: 'junction', code: 'not_a_regular_file' },
      { ok: false, displayName: 'relative.mp4', code: 'file_unavailable' },
    ]);
    // invalid_input for something that is not a folder is a non-regular file.
    expect(await resolveDroppedMediaPaths([file], { resolve: async () => [{ fileName: 'clip.mp4', error: 'invalid_input' }] }))
      .toEqual([{ ok: false, displayName: 'clip.mp4', code: 'not_a_regular_file' }]);
  });
});

// ── The bundled ffmpeg writing a partial ───────────────────────────────────────────────────────

const environment: LocalSubtitleResourceEnvironment = { mode: 'development', appRoot: process.cwd() };
const available = process.platform === 'win32' && await verifyLocalSubtitleRuntimeBundle({ environment, scope: 'media' }).then(() => true, () => false);
/** Warnings that mean ffmpeg silently did something other than asked (module-engine tasks, common conventions). */
const SILENT_SUBSTITUTION = /Invalid option|Error parsing option|auto-selecting format|only the last/;

describe.skipIf(!available)('a partial written by the bundled ffmpeg', () => {
  it('ffmpeg -y truncates the partial without changing its identity, and the result publishes by link', async () => {
    const { dir, out, state, outputs } = await setup('ffmpeg');
    const runtime = new MediaRuntime({ environment, workingDirectory: path.join(dir, 'work') });
    const partial = await finished(outputs, out, 'stale bytes that the truncating open must drop'.repeat(1000));
    const result = await runtime.run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'level+warning', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-c:a', 'pcm_s16le', ...outputLimitArgs(10 * 1024 * 1024, 500_000), '-f', 'wav', '-y', `file:${partial.path}`],
    { timeoutMs: 30_000, stdoutMaxBytes: 1024 * 1024, stderrMaxBytes: 1024 * 1024 });
    const stderr = result.stderr.toString('utf8');
    expect(result.status === 'closed' && result.exitCode === 0, stderr).toBe(true);
    expect(stderr).not.toMatch(SILENT_SUBSTITUTION);
    expect(await outputs.verifyPartial(partial)).toBe(true);
    const bytes = await readFile(partial.path);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.includes('stale bytes')).toBe(false);

    const published = await outputs.publish(partial, { owner: 'a', baseName: 'tone', extension: 'wav', conflict: 'number', inputs: [] });
    expect(published).toEqual({ path: path.join(out, 'tone.wav'), replaced: false, warnings: [] });
    expect(await readFile(published.path)).toEqual(bytes);
    expect(await identityOf(published.path)).toEqual(partial.identity);
    expect(await names(out)).toEqual(['tone.wav']);
    expect(await journal(state)).toEqual([]);
  }, 60_000);
});
