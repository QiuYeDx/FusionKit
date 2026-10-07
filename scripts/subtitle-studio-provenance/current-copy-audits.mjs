import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FORK_PATH } from './copy-policy.mjs';

export const CURRENT_COPY_AUDIT_PATH = 'scripts/subtitle-studio-provenance/current-copy-audits.json';
// Same value as TRANSCRIPT_EXECUTOR_PROVENANCE_PATH; importing it would form a module cycle.
const TRANSCRIPT_EXECUTOR_PROVENANCE = 'resources/subtitle-studio/provenance/transcription-executor-fork.json';
/** Reviewable destinations, each owned by the provenance record whose plan produced it. */
export const CURRENT_COPY_AUDIT_OWNERS = Object.freeze({
  'electron/main/subtitle-studio/transcription/native/filesystem-object-identity.ts': FORK_PATH,
  'electron/main/subtitle-studio/transcription/native/media-normalizer.ts': FORK_PATH,
  'test/subtitle-studio/transcription/productionExecutor.test.ts': FORK_PATH,
  'electron/main/subtitle-studio/transcription/transcript-executor.ts': TRANSCRIPT_EXECUTOR_PROVENANCE,
});
const allowed = new Set(Object.keys(CURRENT_COPY_AUDIT_OWNERS));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Audit current bug fixes without rewriting the frozen copy recipe or evidence. */
export function validateCurrentCopyAudits(plan, document, provenancePath = FORK_PATH) {
  if (!exact(document, ['schemaVersion', 'sourceCommit', 'entries']) || document.schemaVersion !== 1
    || document.sourceCommit !== plan.baseline.sourceCommit || !Array.isArray(document.entries)
    || document.entries.length !== allowed.size) throw new Error('Invalid current copy audit header');
  const seen = new Set(), result = new Map();
  for (const entry of document.entries) {
    if (!exact(entry, ['destinationPath', 'copiedSha256', 'currentSha256', 'reason'])
      || !allowed.has(entry.destinationPath) || seen.has(entry.destinationPath)
      || !/^[a-f0-9]{64}$/.test(entry.copiedSha256) || !/^[a-f0-9]{64}$/.test(entry.currentSha256)
      || typeof entry.reason !== 'string' || !entry.reason.trim())
      throw new Error('Invalid current copy audit entry');
    seen.add(entry.destinationPath);
    // Entries owned by another provenance record are checked by that record's plan.
    if (CURRENT_COPY_AUDIT_OWNERS[entry.destinationPath] !== provenancePath) continue;
    const original = plan.files.find(file => file.destinationPath === entry.destinationPath);
    if (!original || hash(original.bytes) !== entry.copiedSha256 || entry.currentSha256 === entry.copiedSha256)
      throw new Error(`Stale current copy audit: ${entry.destinationPath}`);
    result.set(entry.destinationPath, Object.freeze({ ...entry }));
  }
  return result;
}

export function readCurrentCopyAudits(root, plan, provenancePath = FORK_PATH) {
  if (!Object.values(CURRENT_COPY_AUDIT_OWNERS).includes(provenancePath)) return new Map();
  let absolute = root;
  for (const part of CURRENT_COPY_AUDIT_PATH.split('/')) {
    absolute = path.join(absolute, part);
    if (!fs.existsSync(absolute)) return new Map();
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Symlink current copy audit');
  }
  return validateCurrentCopyAudits(plan, JSON.parse(fs.readFileSync(absolute, 'utf8')), provenancePath);
}

export function matchesCurrentCopy(destinationPath, actual, frozen, audits) {
  const audit = audits.get(destinationPath);
  return audit ? hash(frozen) === audit.copiedSha256 && hash(actual) === audit.currentSha256 : actual.equals(frozen);
}
