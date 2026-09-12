import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SHARED_EXTRACTION_SOURCE_COMMIT } from './shared-resource-extraction.mjs';

export const SHARED_INTEGRATION_AUDIT_PATH = 'resources/speech-resources/provenance/current-integration-audits.v1.json';
// Worktree review only. Neither this list nor the audit changes a frozen source blob or generated copy.
export const SHARED_INTEGRATION_PATHS = Object.freeze({
  'electron/main/index.ts': 'composition',
  'electron/preload/index.ts': 'composition',
  'electron/main/app-shutdown.ts': 'composition',
  'electron/main/local-subtitle/model-ipc.ts': 'legacy-bridge',
  'electron/main/local-subtitle/session-ipc.ts': 'legacy-bridge',
  'electron/main/local-subtitle/shared-resources.ts': 'legacy-adapter',
  'src/services/local-subtitle/localSubtitleEnvironmentService.ts': 'legacy-observer',
  'src/services/local-subtitle/localSubtitleEnvironmentService.test.ts': 'legacy-observer-test',
  'electron/main/subtitle-studio/index.ts': 'studio-composition',
  'electron/main/subtitle-studio/transcription/runtime.ts': 'studio-composition',
  'electron/main/subtitle-studio/transcription/shared-resources.ts': 'studio-adapter',
});
const eligible = new Set(Object.entries(SHARED_INTEGRATION_PATHS).filter(([, role]) => role.startsWith('legacy-')).map(([name]) => name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
function git(root, args) {
  return execFileSync('git', ['-c', `safe.directory=${path.resolve(root).replaceAll('\\', '/')}`, '-C', root, ...args],
    { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}
function checkedPath(root, name) {
  let absolute = root;
  for (const part of name.split('/')) { absolute = path.join(absolute, part); if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Shared integration symlink: ${name}`); }
  if (!fs.statSync(absolute).isFile()) throw new Error(`Shared integration entry is not a file: ${name}`);
  return absolute;
}

export function validateSharedIntegrationAudit(document) {
  if (!exact(document, ['schemaVersion', 'sourceCommit', 'purpose', 'entries']) || document.schemaVersion !== 1
    || document.sourceCommit !== SHARED_EXTRACTION_SOURCE_COMMIT
    || document.purpose !== 'Current shared-resource composition only; frozen source manifests, copied files and replay remain unchanged.'
    || !Array.isArray(document.entries) || document.entries.length !== Object.keys(SHARED_INTEGRATION_PATHS).length) throw new Error('Invalid shared integration audit header');
  const audits = new Map();
  for (const entry of document.entries) {
    if (!exact(entry, ['sourcePath', 'role', 'sourceBlobOid', 'sourceSha256', 'currentBlobOid', 'reason'])
      || !Object.hasOwn(SHARED_INTEGRATION_PATHS, entry.sourcePath) || entry.role !== SHARED_INTEGRATION_PATHS[entry.sourcePath]
      || !/^[a-f0-9]{40}$/.test(entry.currentBlobOid) || typeof entry.reason !== 'string' || !entry.reason.trim()
      || audits.has(entry.sourcePath)) throw new Error('Invalid or duplicate shared integration entry');
    const isNew = entry.role === 'legacy-adapter' || entry.role === 'studio-adapter';
    if (isNew ? entry.sourceBlobOid !== null || entry.sourceSha256 !== null
      : !/^[a-f0-9]{40}$/.test(entry.sourceBlobOid) || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) throw new Error('Invalid shared integration source identity');
    audits.set(entry.sourcePath, entry);
  }
  return audits;
}

export function readSharedResourceIntegrationAudits(root, baseline, { required = false } = {}) {
  if (!fs.existsSync(path.join(root, SHARED_INTEGRATION_AUDIT_PATH))) {
    if (required) throw new Error('Missing shared integration audit');
    return new Map();
  }
  const document = JSON.parse(fs.readFileSync(checkedPath(root, SHARED_INTEGRATION_AUDIT_PATH), 'utf8'));
  const audits = validateSharedIntegrationAudit(document);
  for (const [name, entry] of audits) {
    checkedPath(root, name);
    const historical = git(root, ['ls-tree', document.sourceCommit, '--', name]).toString().trim();
    if (entry.sourceBlobOid === null) {
      if (historical) throw new Error(`Shared integration adapter was not new: ${name}`);
    } else {
      const oid = historical.split(/\s+/)[2];
      if (oid !== entry.sourceBlobOid || sha(git(root, ['cat-file', 'blob', oid])) !== entry.sourceSha256) throw new Error(`Shared integration source pin changed: ${name}`);
    }
    const attributes = git(root, ['check-attr', '-z', 'filter', '--', name]).toString().split('\0');
    if (!['unspecified', 'unset'].includes(attributes[2])) throw new Error(`Unsupported clean filter on ${name}`);
    const current = git(root, ['hash-object', `--path=${name}`, '--', name]).toString().trim();
    if (current !== entry.currentBlobOid) throw new Error(`Changed audited shared integration source: ${name}`);
    const frozen = baseline?.files.find(file => file.sourcePath === name);
    if (eligible.has(name) && entry.sourceBlobOid !== null && baseline
      && (!frozen || frozen.blobOid !== entry.sourceBlobOid || frozen.sha256 !== entry.sourceSha256)) throw new Error(`Shared integration baseline pin differs: ${name}`);
  }
  return new Map([...audits].filter(([name]) => eligible.has(name)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const audits = readSharedResourceIntegrationAudits(process.cwd(), undefined, { required: true }); console.log(JSON.stringify({ entries: Object.keys(SHARED_INTEGRATION_PATHS).length, legacyWorktreeAudits: audits.size, exact: true }, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
