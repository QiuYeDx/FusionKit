import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_COPY_AUDIT_PATH, validateCurrentCopyAudits, matchesCurrentCopy } from '../../scripts/subtitle-studio-provenance/current-copy-audits.mjs';
import { applyCopyPlan } from '../../scripts/subtitle-studio-provenance/copy.mjs';
import { FORK_PATH } from '../../scripts/subtitle-studio-provenance/copy-policy.mjs';
import { serialize } from '../../scripts/subtitle-studio-provenance/generate.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const files = ['filesystem-object-identity', 'media-normalizer'].map(name => ({
    destinationPath: `electron/main/subtitle-studio/transcription/native/${name}.ts`, bytes: Buffer.from(`original ${name}`),
  }));
  const plan = { baseline: { sourceCommit: 'a'.repeat(40) }, files };
  const document = { schemaVersion: 1, sourceCommit: plan.baseline.sourceCommit,
    entries: files.map(file => ({ destinationPath: file.destinationPath, copiedSha256: hash(file.bytes.toString()),
      currentSha256: hash(`reviewed ${file.destinationPath}`), reason: 'Reviewed source metadata fix.' })) };
  return { files, plan, document };
}

it('accepts exact reviewed bytes without changing the historical plan or allowing further edits/reverts', () => {
  const f = fixture(), original = JSON.stringify(f.plan);
  const audits = validateCurrentCopyAudits(f.plan, f.document);
  for (const file of f.files) {
    expect(matchesCurrentCopy(file.destinationPath, Buffer.from(`reviewed ${file.destinationPath}`), file.bytes, audits)).toBe(true);
    expect(matchesCurrentCopy(file.destinationPath, Buffer.from('further edit'), file.bytes, audits)).toBe(false);
    expect(matchesCurrentCopy(file.destinationPath, file.bytes, file.bytes, audits)).toBe(false);
    expect(matchesCurrentCopy(file.destinationPath, Buffer.from(`reviewed ${file.destinationPath}`), file.bytes, new Map())).toBe(false);
    expect(matchesCurrentCopy(file.destinationPath, Buffer.from(`reviewed ${file.destinationPath}`), Buffer.from('changed baseline'), audits)).toBe(false);
  }
  expect(matchesCurrentCopy('unrelated.ts', Buffer.from('changed'), Buffer.from('original'), audits)).toBe(false);
  expect(JSON.stringify(f.plan)).toBe(original);
});

it.each(['source', 'unknown-path', 'duplicate', 'copied-hash', 'current-hash', 'reason', 'missing', 'extra-field'])('rejects %s audit corruption', kind => {
  const f = fixture();
  if (kind === 'source') f.document.sourceCommit = 'b'.repeat(40);
  if (kind === 'unknown-path') f.document.entries[0].destinationPath = '../other.ts';
  if (kind === 'duplicate') f.document.entries[1] = f.document.entries[0];
  if (kind === 'copied-hash') f.document.entries[0].copiedSha256 = '0'.repeat(64);
  if (kind === 'current-hash') f.document.entries[0].currentSha256 = 'invalid';
  if (kind === 'reason') f.document.entries[0].reason = ' ';
  if (kind === 'missing') f.document.entries.pop();
  if (kind === 'extra-field') Object.assign(f.document.entries[0], { skip: true });
  expect(() => validateCurrentCopyAudits(f.plan, f.document)).toThrow();
});

it('checks reviewed destinations through the real copy entry point and never restores missing or edited audited files', () => {
  const f = fixture(), plan = { ...f.plan, provenance: { frozen: true } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-copy-audit-')); roots.push(root);
  const write = (name: string, bytes: string) => {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  };
  write(CURRENT_COPY_AUDIT_PATH, JSON.stringify(f.document)); write(FORK_PATH, serialize(plan.provenance));
  for (const file of f.files) write(file.destinationPath, `reviewed ${file.destinationPath}`);
  expect(() => applyCopyPlan(plan, { root })).not.toThrow();
  const target = f.files[0].destinationPath;
  write(target, 'unreviewed edit');
  expect(() => applyCopyPlan(plan, { root, write: true })).toThrow('Destination content differs');
  expect(fs.readFileSync(path.join(root, target), 'utf8')).toBe('unreviewed edit');
  fs.unlinkSync(path.join(root, target));
  expect(() => applyCopyPlan(plan, { root, write: true })).toThrow('Missing audited destination');
  expect(fs.existsSync(path.join(root, target))).toBe(false);
});
