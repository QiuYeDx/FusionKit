import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SHARED_EXTRACTION_SOURCE_COMMIT = '99d064719d7ec93dea02944a9bfde31c4afec221';
export const SHARED_EXTRACTION_PATH = 'resources/speech-resources/provenance/resource-engine-extraction.v1.json';
const roots = ['electron/main/speech-resources/engine/', 'test/speech-resources/engine/', 'resources/speech-resources/manifests/'];
const extraOutputs = ['src/speech-resources/contracts.ts', 'src/speech-resources/schemas.ts', 'electron/main/speech-resources/catalog.ts'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value)
    || path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new Error('Unsafe extraction path');
  return value;
}
function read(root, name) {
  let current = root;
  for (const part of relative(name).split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Extraction symlink: ${name}`); }
  if (!fs.statSync(current).isFile()) throw new Error(`Extraction entry is not a file: ${name}`);
  return fs.readFileSync(current);
}
function git(root, args) {
  return execFileSync('git', ['-c', `safe.directory=${path.resolve(root).replaceAll('\\', '/')}`, '-C', root, ...args],
    { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

/** Byte offsets and removed-byte digests bind every reviewed insertion/deletion to the frozen Git blob. */
export function applySharedExtractionEdits(source, edits) {
  if (!Buffer.isBuffer(source) || !Array.isArray(edits) || edits.length > 4096) throw new Error('Invalid extraction edits');
  const chunks = []; let offset = 0;
  for (const edit of edits) {
    if (!exact(edit, ['startByte', 'endByte', 'removedSha256', 'insertedText']) || !Number.isSafeInteger(edit.startByte)
      || !Number.isSafeInteger(edit.endByte) || edit.startByte < offset || edit.endByte < edit.startByte || edit.endByte > source.length
      || !hashValid(edit.removedSha256) || typeof edit.insertedText !== 'string' || edit.insertedText.includes('\r')
      || sha(source.subarray(edit.startByte, edit.endByte)) !== edit.removedSha256) throw new Error('Invalid or overlapping audited extraction edit');
    chunks.push(source.subarray(offset, edit.startByte), Buffer.from(edit.insertedText)); offset = edit.endByte;
  }
  chunks.push(source.subarray(offset)); return Buffer.concat(chunks);
}

export function checkSharedResourceExtraction({ root = process.cwd(), manifestPath = SHARED_EXTRACTION_PATH, readSourceBlob } = {}) {
  const manifest = JSON.parse(read(root, manifestPath).toString('utf8'));
  if (!exact(manifest, ['schemaVersion', 'kind', 'sourceCommit', 'sourceMapSha256', 'transformations', 'sources', 'outputs', 'sourceCheckoutPolicy', 'scopeRoots'])
    || manifest.schemaVersion !== 1 || manifest.kind !== 'audited-neutral-resource-extraction'
    || manifest.sourceCommit !== SHARED_EXTRACTION_SOURCE_COMMIT || !hashValid(manifest.sourceMapSha256)
    || manifest.sourceCheckoutPolicy !== 'Git blobs are authoritative; source checkout permits only CRLF-to-LF normalization. Output bytes must match exactly.'
    || JSON.stringify(manifest.scopeRoots) !== JSON.stringify(roots) || !Array.isArray(manifest.transformations)
    || !manifest.transformations.length || manifest.transformations.some(value => typeof value !== 'string' || !value.trim())
    || !Array.isArray(manifest.sources) || !manifest.sources.length || !Array.isArray(manifest.outputs) || !manifest.outputs.length) throw new Error('Invalid shared extraction header');
  const sourceBytes = new Map();
  for (const source of manifest.sources) {
    if (!exact(source, ['path', 'blobOid', 'byteSize', 'sha256']) || !/^[a-f0-9]{40}$/.test(source.blobOid)
      || !Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || !hashValid(source.sha256)) throw new Error('Invalid extraction source record');
    const name = relative(source.path);
    if (sourceBytes.has(name)) throw new Error(`Duplicate extraction source: ${name}`);
    const blob = readSourceBlob ? readSourceBlob(source, manifest.sourceCommit) : (() => {
      const oid = git(root, ['rev-parse', `${manifest.sourceCommit}:${name}`]).toString().trim();
      if (oid !== source.blobOid) throw new Error(`Source commit/blob mismatch: ${name}`);
      return git(root, ['cat-file', 'blob', oid]);
    })();
    if (!Buffer.isBuffer(blob) || blob.length !== source.byteSize || sha(blob) !== source.sha256) throw new Error(`Frozen extraction source differs: ${name}`);
    const current = Buffer.from(read(root, name).toString('utf8').replaceAll('\r\n', '\n'));
    if (!current.equals(blob)) throw new Error(`Extraction source worktree changed: ${name}`);
    sourceBytes.set(name, blob);
  }
  const outputNames = new Set(), usedSources = new Set(); let editCount = 0;
  for (const output of manifest.outputs) {
    if (!exact(output, ['path', 'kind', 'sourcePaths', 'baseSourcePath', 'byteSize', 'sha256', 'edits', 'reason'])
      || !['new', 'derived'].includes(output.kind) || !Array.isArray(output.sourcePaths)
      || !Number.isSafeInteger(output.byteSize) || output.byteSize < 1 || !hashValid(output.sha256)
      || typeof output.reason !== 'string' || !output.reason.trim()) throw new Error('Invalid extraction output record');
    const name = relative(output.path);
    if ((!roots.some(prefix => name.startsWith(prefix)) && !extraOutputs.includes(name)) || outputNames.has(name.toLowerCase())) throw new Error(`Invalid or duplicate extraction output: ${name}`);
    outputNames.add(name.toLowerCase());
    if (new Set(output.sourcePaths).size !== output.sourcePaths.length || output.sourcePaths.some(source => !sourceBytes.has(source))) throw new Error(`Unknown extraction input: ${name}`);
    output.sourcePaths.forEach(source => usedSources.add(source));
    if (output.kind === 'new' ? output.baseSourcePath !== null || output.sourcePaths.length !== 0 : output.baseSourcePath !== output.sourcePaths[0]) throw new Error(`Extraction base differs: ${name}`);
    const generated = applySharedExtractionEdits(output.baseSourcePath === null ? Buffer.alloc(0) : sourceBytes.get(output.baseSourcePath), output.edits);
    if (generated.length !== output.byteSize || sha(generated) !== output.sha256) throw new Error(`Audited transforms do not produce the pinned output: ${name}`);
    if (!read(root, name).equals(generated)) throw new Error(`Extraction output changed: ${name}`);
    editCount += output.edits.length;
  }
  if (usedSources.size !== sourceBytes.size) throw new Error('Unreferenced extraction source');
  function inventory(directory) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) throw new Error(`Missing extraction scope: ${directory}`);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Extraction scope symlink: ${directory}`);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = `${directory.replace(/\/$/, '')}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Extraction symlink: ${name}`);
      if (entry.isDirectory()) inventory(name);
      else if (!outputNames.has(name.toLowerCase())) throw new Error(`Unregistered extraction output: ${name}`);
    }
  }
  roots.forEach(inventory);
  return { sourceCommit: manifest.sourceCommit, sources: sourceBytes.size, outputs: outputNames.size, edits: editCount, exact: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkSharedResourceExtraction(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
