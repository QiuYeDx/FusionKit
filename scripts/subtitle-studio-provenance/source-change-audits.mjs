import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Reviewed later changes to frozen source paths. Frozen blobs, copy plans, replay
// and extraction outputs keep using the pinned bytes; an entry only approves the
// exact current worktree bytes of one path, so any further edit drifts again.
export const SOURCE_CHANGE_AUDIT_PATH = 'scripts/subtitle-studio-provenance/current-source-audits.json';
export const SOURCE_CHANGE_AUDIT_PURPOSE = 'Reviewed current worktree bytes of frozen sources only; frozen blobs, copies, extraction outputs and replay remain unchanged.';

const oidPattern = /^[a-f0-9]{40}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !/^[A-Za-z]:|^\//.test(value) && path.posix.normalize(value) === value && !value.split('/').includes('..');
}

/** Git blob id of already line-ending-normalized bytes, matching `git hash-object`. */
export function gitBlobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function validateSourceChangeAudits(document) {
  if (!exact(document, ['schemaVersion', 'purpose', 'entries']) || document.schemaVersion !== 1
    || document.purpose !== SOURCE_CHANGE_AUDIT_PURPOSE || !Array.isArray(document.entries)) throw new Error('Invalid source change audit header');
  const audits = new Map();
  for (const entry of document.entries) {
    if (!exact(entry, ['sourcePath', 'frozenBlobOid', 'currentBlobOid', 'reason']) || !safeRelativePath(entry.sourcePath)
      || !oidPattern.test(entry.frozenBlobOid) || !oidPattern.test(entry.currentBlobOid) || entry.frozenBlobOid === entry.currentBlobOid
      || typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('Invalid source change audit entry');
    const key = `${entry.sourcePath}\n${entry.frozenBlobOid}`;
    if (audits.has(key)) throw new Error(`Duplicate source change audit: ${entry.sourcePath}`);
    audits.set(key, Object.freeze({ ...entry }));
  }
  return audits;
}

export function readSourceChangeAudits(root) {
  let absolute = root;
  for (const part of SOURCE_CHANGE_AUDIT_PATH.split('/')) {
    absolute = path.join(absolute, part);
    if (!fs.existsSync(absolute)) return new Map();
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Source change audit path is a symlink');
  }
  return validateSourceChangeAudits(JSON.parse(fs.readFileSync(absolute, 'utf8')));
}

/** True only when a reviewed entry pins both this frozen blob and these exact current bytes. */
export function isApprovedSourceChange(audits, sourcePath, frozenBlobOid, currentBlobOid) {
  return audits.get(`${sourcePath}\n${frozenBlobOid}`)?.currentBlobOid === currentBlobOid;
}
