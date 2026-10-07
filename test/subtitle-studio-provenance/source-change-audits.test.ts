import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  gitBlobOid, isApprovedSourceChange, SOURCE_CHANGE_AUDIT_PURPOSE, validateSourceChangeAudits,
} from '../../scripts/subtitle-studio-provenance/source-change-audits.mjs';

const frozen = 'a'.repeat(40), current = 'b'.repeat(40);
const document = () => ({ schemaVersion: 1, purpose: SOURCE_CHANGE_AUDIT_PURPOSE,
  entries: [{ sourcePath: 'src/type/example.ts', frozenBlobOid: frozen, currentBlobOid: current, reason: 'Reviewed fix.' }] });

describe('source change audits', () => {
  it('approves only the exact reviewed bytes for the exact frozen blob', () => {
    const audits = validateSourceChangeAudits(document());
    expect(isApprovedSourceChange(audits, 'src/type/example.ts', frozen, current)).toBe(true);
    expect(isApprovedSourceChange(audits, 'src/type/example.ts', frozen, 'c'.repeat(40))).toBe(false);
    expect(isApprovedSourceChange(audits, 'src/type/example.ts', 'd'.repeat(40), current)).toBe(false);
    expect(isApprovedSourceChange(audits, 'src/type/other.ts', frozen, current)).toBe(false);
  });

  it.each(['purpose', 'extra-field', 'same-blob', 'duplicate', 'unsafe-path', 'windows-path', 'reason', 'oid'])('rejects %s', kind => {
    const value: any = document(), entry = value.entries[0];
    if (kind === 'purpose') value.purpose = 'Anything goes.';
    if (kind === 'extra-field') entry.commit = 'abc';
    if (kind === 'same-blob') entry.currentBlobOid = frozen;
    if (kind === 'duplicate') value.entries.push({ ...entry });
    if (kind === 'unsafe-path') entry.sourcePath = '../outside.ts';
    if (kind === 'windows-path') entry.sourcePath = 'src\\type\\example.ts';
    if (kind === 'reason') entry.reason = ' ';
    if (kind === 'oid') entry.currentBlobOid = 'not-an-oid';
    expect(() => validateSourceChangeAudits(value)).toThrow();
  });

  it('computes the same blob id as Git for normalized bytes', () => {
    const bytes = Buffer.from('export const value = 1;\n');
    expect(gitBlobOid(bytes)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString().trim());
  });
});
