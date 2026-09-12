import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SHARED_EXTRACTION_SOURCE_COMMIT } from './shared-resource-extraction.mjs';

export const SHARED_MIGRATION_RECEIPTS_PATH = 'resources/speech-resources/provenance/migration-receipts.v1.json';
export const SHARED_MIGRATION_RECEIPT_PAIRS = Object.freeze(['legacy', 'studio'].flatMap(owner => {
  const prefix = owner === 'legacy' ? 'local-subtitle' : 'subtitle-studio';
  const directory = owner === 'legacy' ? 'resources/local-subtitle/manifests' : 'resources/subtitle-studio/transcription/manifests';
  return ['models', 'vad', 'windows-cuda-pack'].map(kind => Object.freeze({
    sourcePath: `${directory}/${prefix}-${kind}.v1.json`,
    destinationPath: `resources/speech-resources/migration/${owner}/${prefix}-${kind}.v1.json`,
  }));
}));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lf = bytes => Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
function read(root, relative) {
  let absolute = root;
  for (const part of relative.split('/')) { absolute = path.join(absolute, part); if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Receipt symlink: ${relative}`); }
  if (!fs.statSync(absolute).isFile()) throw new Error(`Receipt is not a file: ${relative}`);
  return fs.readFileSync(absolute);
}
function git(root, args) {
  return execFileSync('git', ['-c', `safe.directory=${path.resolve(root).replaceAll('\\', '/')}`, '-C', root, ...args],
    { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

/** Maintenance-only provenance: production imports only the six neutral-owned snapshots. */
export function checkSharedMigrationReceipts({ root = process.cwd(), readSourceBlob } = {}) {
  const manifest = JSON.parse(read(root, SHARED_MIGRATION_RECEIPTS_PATH).toString());
  if (!exact(manifest, ['schemaVersion', 'kind', 'sourceCommit', 'copyPolicy', 'entries']) || manifest.schemaVersion !== 1
    || manifest.kind !== 'neutral-owned-historical-migration-receipts' || manifest.sourceCommit !== SHARED_EXTRACTION_SOURCE_COMMIT
    || manifest.copyPolicy !== 'Exact initial checkout byte copy; Git LF source identity is independently pinned. No runtime dependency on historical source paths.'
    || !Array.isArray(manifest.entries) || manifest.entries.length !== SHARED_MIGRATION_RECEIPT_PAIRS.length) throw new Error('Invalid migration receipt header');
  for (let index = 0; index < SHARED_MIGRATION_RECEIPT_PAIRS.length; index++) {
    const expected = SHARED_MIGRATION_RECEIPT_PAIRS[index], record = manifest.entries[index];
    if (!exact(record, ['sourcePath', 'destinationPath', 'sourceBlobOid', 'sourceByteSize', 'sourceSha256', 'copiedByteSize', 'copiedSha256'])
      || record.sourcePath !== expected.sourcePath || record.destinationPath !== expected.destinationPath
      || !/^[a-f0-9]{40}$/.test(record.sourceBlobOid) || !/^[a-f0-9]{64}$/.test(record.sourceSha256)
      || !/^[a-f0-9]{64}$/.test(record.copiedSha256) || !Number.isSafeInteger(record.sourceByteSize)
      || !Number.isSafeInteger(record.copiedByteSize) || record.sourceByteSize < 1 || record.copiedByteSize < 1) throw new Error('Invalid fixed migration receipt record');
    const blob = readSourceBlob ? readSourceBlob(record, manifest.sourceCommit) : (() => {
      if (git(root, ['rev-parse', `${manifest.sourceCommit}:${record.sourcePath}`]).toString().trim() !== record.sourceBlobOid) throw new Error('Migration receipt source commit/blob mismatch');
      return git(root, ['cat-file', 'blob', record.sourceBlobOid]);
    })();
    const source = read(root, record.sourcePath), destination = read(root, record.destinationPath);
    if (!Buffer.isBuffer(blob) || blob.length !== record.sourceByteSize || sha(blob) !== record.sourceSha256) throw new Error('Frozen migration receipt source differs');
    if (!lf(source).equals(blob)) throw new Error('Historical migration receipt checkout changed');
    if (destination.length !== record.copiedByteSize || sha(destination) !== record.copiedSha256 || !lf(destination).equals(blob)) throw new Error('Neutral migration receipt snapshot changed');
  }
  const migrationOwners = fs.readdirSync(path.join(root, 'resources/speech-resources/migration'), { withFileTypes: true });
  if (migrationOwners.length !== 2 || migrationOwners.some(entry => !entry.isDirectory() || entry.isSymbolicLink()
    || !['legacy', 'studio'].includes(entry.name))) throw new Error('Unregistered neutral migration receipt owner');
  for (const owner of ['legacy', 'studio']) {
    const directory = `resources/speech-resources/migration/${owner}`;
    const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
    if (entries.length !== 3 || entries.some(entry => !entry.isFile() || entry.isSymbolicLink()
      || !SHARED_MIGRATION_RECEIPT_PAIRS.some(pair => pair.destinationPath === `${directory}/${entry.name}`))) throw new Error('Unregistered neutral migration receipt');
  }
  return { sourceCommit: manifest.sourceCommit, receipts: manifest.entries.length, exact: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkSharedMigrationReceipts(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
