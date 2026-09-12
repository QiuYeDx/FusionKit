import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createToolingCopyPlan, applyToolingCopyPlan } from '../../scripts/subtitle-studio-provenance/tooling-copy.mjs';

const roots: string[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tooling-copy-')); roots.push(root);
  const write = (name: string, value: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write('old/a.ts', 'export const root = "old/root";\n'); write('old/b.ts', 'export const version = 1;\n');
  git('add', '.'); git('-c', 'user.name=Tooling test', '-c', 'user.email=tooling@example.invalid', 'commit', '-qm', 'source');
  const sourceCommit = git('rev-parse', 'HEAD');
  const files = ['old/a.ts', 'old/b.ts'].map(sourcePath => {
    const bytes = fs.readFileSync(path.join(root, sourcePath));
    return { sourcePath, blobOid: git('rev-parse', `${sourceCommit}:${sourcePath}`), byteSize: bytes.length, sha256: sha(bytes) };
  });
  const baseline = JSON.stringify({ sourceCommit, files }); write('baseline.json', baseline);
  const recipe = { sourceCommit, baselinePath: 'baseline.json', baselineSha256: sha(baseline), files: files.map((file, index) => ({
    sourcePath: file.sourcePath, destinationPath: `new/${index}.ts`,
    edits: index === 0 ? [{ from: '"old/root"', to: '"new/root"', count: 1, reason: 'Independent root.' }] : [],
  })), deferred: ['No native runtime is built.'] };
  return { root, write, git, recipe, options: { root, recipe }, apply: { root, provenancePath: 'fork.json' } };
}

describe('T03 tooling copy provenance', () => {
  it('rebuilds fixed blobs with precise edits and verifies every actual output', () => {
    const f = fixture(), plan = createToolingCopyPlan(f.options);
    expect(plan.files[0].bytes.toString()).toBe('export const root = "new/root";\n');
    expect(plan.files[1].transforms).toEqual([]);
    applyToolingCopyPlan(plan, { ...f.apply, write: true });
    expect(createToolingCopyPlan(f.options).provenance).toStrictEqual(plan.provenance);
    expect(() => applyToolingCopyPlan(plan, f.apply)).not.toThrow();
    for (const file of plan.files) expect(sha(fs.readFileSync(path.join(f.root, file.destinationPath)))).toBe(file.destinationSha256);
    f.write('new/1.ts', 'tampered');
    expect(() => applyToolingCopyPlan(plan, f.apply)).toThrow(/destination differs/);
  });

  it('refuses source drift, changed baseline bytes and stale or overlapping edits', () => {
    const f = fixture();
    expect(() => createToolingCopyPlan({ ...f.options, recipe: { ...f.recipe, baselineSha256: '0'.repeat(64) } })).toThrow(/baseline hash/);
    const stale = structuredClone(f.recipe); stale.files[0].edits[0].count = 2;
    expect(() => createToolingCopyPlan({ root: f.root, recipe: stale })).toThrow(/edit count/);
    const overlap = structuredClone(f.recipe); overlap.files[0].edits.push(overlap.files[0].edits[0]);
    expect(() => createToolingCopyPlan({ root: f.root, recipe: overlap })).toThrow(/Overlapping/);
    f.write('old/a.ts', 'changed');
    expect(() => createToolingCopyPlan(f.options)).toThrow(/worktree drift/);
  });

  it('rejects destination collisions and user edits before writing any output', () => {
    const f = fixture(), plan = createToolingCopyPlan(f.options);
    const collision = structuredClone(f.recipe); collision.files[1].destinationPath = collision.files[0].destinationPath.toUpperCase();
    expect(() => createToolingCopyPlan({ root: f.root, recipe: collision })).toThrow(/Conflicting/);
    f.write('new/1.ts', 'user edit');
    expect(() => applyToolingCopyPlan(plan, { ...f.apply, write: true })).toThrow(/destination differs/);
    expect(fs.existsSync(path.join(f.root, 'new/0.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, 'new/1.ts'), 'utf8')).toBe('user edit');
  });

  it('rejects source and destination links without writing through them', () => {
    const f = fixture(), plan = createToolingCopyPlan(f.options);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-outside-')); roots.push(outside);
    fs.symlinkSync(outside, path.join(f.root, 'new'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => applyToolingCopyPlan(plan, { ...f.apply, write: true })).toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(f.root, 'old/a.ts')); fs.symlinkSync(path.join(outside, 'absent.ts'), path.join(f.root, 'old/a.ts'));
    expect(() => createToolingCopyPlan(f.options)).toThrow(/symlink/);
  });

  it('refuses configured clean filters before Git can execute them', () => {
    const f = fixture();
    f.write('filter.cjs', 'require("node:fs").writeFileSync("filter-executed", "yes"); process.stdout.write(require("node:fs").readFileSync(0));');
    f.git('config', 'filter.trip.clean', 'node filter.cjs');
    f.write('.gitattributes', '*.ts filter=trip\n');
    expect(() => createToolingCopyPlan(f.options)).toThrow(/Unsupported tooling clean filter/);
    expect(fs.existsSync(path.join(f.root, 'filter-executed'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, 'new'))).toBe(false);
  });
});
