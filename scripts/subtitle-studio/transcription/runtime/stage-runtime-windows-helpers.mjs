import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './runtime-manifest.mjs';
import { getLocalSubtitleStagingTarget, resolveRuntimeStagingOutputParent } from './staging-contract.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const cleanupOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

export function getRuntimeLayout(platform, arch) {
  const target = getLocalSubtitleStagingTarget(platform, arch);
  if (target.id !== 'win32-x64') throw new Error('This staging helper only supports Windows x64.');
  return Object.freeze({ targetId: target.id, server: 'win-x64/cpu/whisper-server.exe',
    ffmpeg: 'win-x64/media/ffmpeg.exe', ffprobe: 'win-x64/media/ffprobe.exe',
    dependencyRoot: 'win-x64/cpu', serverBackend: 'cpu' });
}

export function resolveRuntimeOutputParent(value) {
  if (value === undefined) return resolveRuntimeStagingOutputParent(PROJECT_ROOT);
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('outputParent must be a non-empty path.');
  return path.resolve(value);
}

async function assertNoLinkedAncestors(directory) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Runtime output ancestors must be regular directories.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function assertMissing(target) {
  try { await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('The final runtime staging directory already exists.');
}

export async function assertRuntimeOutputMissing(outputParent) {
  await assertNoLinkedAncestors(outputParent);
  await assertMissing(path.join(outputParent, 'transcription'));
}

export async function copyRuntimeArtifact(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

export async function verifyStagedCopyMatches(filePath, expected, artifactId) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== expected.byteSize ||
      await sha256File(filePath) !== expected.sha256) {
    throw new Error(`${artifactId} staged bytes do not match the verified input.`);
  }
}

// The lock covers every publisher using this entry point. The final directory is
// never merged, and an existing directory or link is rejected before publication.
export async function withRuntimePublication(outputParent, operation) {
  await assertRuntimeOutputMissing(outputParent);
  await mkdir(outputParent, { recursive: true });
  await assertNoLinkedAncestors(outputParent);
  const lockPath = path.join(outputParent, '.transcription.stage.lock');
  const lock = await open(lockPath, 'wx');
  const finalRoot = path.join(outputParent, 'transcription');
  let partialRoot, published = false, failure, result;
  try {
    await assertMissing(finalRoot);
    partialRoot = await mkdtemp(path.join(outputParent, 'transcription.partial-'));
    result = await operation({ finalRoot, partialRoot, publish: async () => {
      if (published) throw new Error('Runtime staging was already published.');
      await assertNoLinkedAncestors(outputParent);
      await assertMissing(finalRoot);
      await rename(partialRoot, finalRoot);
      published = true;
    } });
    if (!published) throw new Error('Runtime staging did not publish a verified bundle.');
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  if (partialRoot && !published) {
    try { await rm(partialRoot, cleanupOptions); } catch (error) { cleanupErrors.push(error); }
  }
  try { await lock.close(); } catch (error) { cleanupErrors.push(error); }
  try { await rm(lockPath, { force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Runtime staging cleanup failed.');
  if (failure) throw failure;
  return result;
}
