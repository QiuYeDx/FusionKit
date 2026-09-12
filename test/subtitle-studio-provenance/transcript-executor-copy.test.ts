import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyTranscriptExecutorPlan, deriveTranscriptExecutor } from '../../scripts/subtitle-studio-provenance/transcript-executor-copy.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const sourceBytes = Buffer.from('import { clean } from "./clean";\nexport function run() { clean(); return "file-export"; }\n');
  const recipe = { sourcePath: 'native/executor.ts', destinationPath: 'transcript-executor.ts', sourceSha256: hash(sourceBytes),
    literalEdits: [{ fromText: 'return "file-export";', toText: 'return "transcript-ready";', count: 1, reason: 'Replace the terminal output seam only.' }] };
  return { sourceBytes, recipe, availableDestinations: ['native/clean.ts'] };
}
describe('tracked transcript executor derivation', () => {
  it('preserves a dependency target when moving the derived file and remains deterministic', () => {
    const f = fixture(), output = deriveTranscriptExecutor(f);
    expect(output.bytes.toString()).toContain('from "./native/clean"');
    expect(output.bytes.toString()).toContain('clean(); return "transcript-ready";');
    expect(deriveTranscriptExecutor(f)).toEqual(output);
    expect(output.dependencies).toEqual([{ destinationPath: 'native/clean.ts', specifier: './native/clean', typeOnly: false }]);
  });
  it('rejects source content drift and stale exact transformations', () => {
    const f = fixture();
    expect(() => deriveTranscriptExecutor({ ...f, sourceBytes: Buffer.from(f.sourceBytes.toString() + '\n') })).toThrow(/source hash differs/);
    expect(() => deriveTranscriptExecutor({ ...f, recipe: { ...f.recipe, literalEdits: [{ ...f.recipe.literalEdits[0], count: 2 }] } })).toThrow(/exact text differs/);
  });
  it('rejects a missing dependency instead of falling back outside the frozen closure', () => {
    const f = fixture();
    expect(() => deriveTranscriptExecutor({ ...f, availableDestinations: [] })).toThrow(/Unrecorded derived executor dependency/);
  });
  it('refuses source overwrite, case collisions, and path traversal', () => {
    const f = fixture();
    for (const destinationPath of ['native/executor.ts', 'native/EXECUTOR.ts', '../escape.ts', '/tmp/escape.ts']) {
      expect(() => deriveTranscriptExecutor({ ...f, recipe: { ...f.recipe, destinationPath } })).toThrow(/cannot replace|Unsafe/);
    }
  });
  it('refuses unknown or malformed transformations', () => {
    const f = fixture();
    expect(() => deriveTranscriptExecutor({ ...f, recipe: { ...f.recipe, literalEdits: [{ ...f.recipe.literalEdits[0], fromText: '', count: 0 }] } })).toThrow(/Invalid/);
    expect(() => deriveTranscriptExecutor({ ...f, recipe: { ...f.recipe, literalEdits: [{ ...f.recipe.literalEdits[0], toText: 'return {' }] } })).toThrow(/valid TypeScript/);
  });
  it('preflights user edits before publishing either code or provenance', () => {
    const f = fixture(), derived = deriveTranscriptExecutor(f);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-executor-copy-')); roots.push(root);
    const plan = { files: [{ destinationPath: f.recipe.destinationPath, bytes: derived.bytes }], provenance: { sourceSha256: f.recipe.sourceSha256 } };
    fs.writeFileSync(path.join(root, f.recipe.destinationPath), 'user work');
    expect(() => applyTranscriptExecutorPlan(plan, { root, write: true, provenancePath: 'fork.json' })).toThrow(/Destination content differs/);
    expect(fs.existsSync(path.join(root, 'fork.json'))).toBe(false);
    fs.unlinkSync(path.join(root, f.recipe.destinationPath));
    applyTranscriptExecutorPlan(plan, { root, write: true, provenancePath: 'fork.json' });
    fs.writeFileSync(path.join(root, 'fork.json'), '{}');
    expect(() => applyTranscriptExecutorPlan(plan, { root, provenancePath: 'fork.json' })).toThrow(/Destination content differs/);
  });
});
