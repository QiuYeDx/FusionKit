import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createNativeCopyPlan, applyNativeCopyPlan } from '../../scripts/subtitle-studio-provenance/native-copy.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-native-copy-')); roots.push(root);
  const write = (name: string, bytes: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes); };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write('old/addon.cc', 'const auto partial = ".fusionkit-local-subtitle-";\nconst auto code = "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST";\n');
  write('old/helper.mjs', 'export const value = 8;\n');
  git('add', '.'); git('-c', 'user.name=Native copy fixture', '-c', 'user.email=native@example.invalid', 'commit', '-qm', 'freeze');
  const sourceCommit = git('rev-parse', 'HEAD');
  const baseline = { sourceCommit, files: ['old/addon.cc', 'old/helper.mjs'].map(sourcePath => {
    const bytes = fs.readFileSync(path.join(root, sourcePath));
    return { sourcePath, blobOid: git('rev-parse', `${sourceCommit}:${sourcePath}`), sha256: hash(bytes), byteSize: bytes.length };
  }), dependencies: [{ sourcePath: 'old/addon.cc', resolvedPath: 'old/helper.mjs' }] };
  const recipe = { sourceCommit, files: [{ sourcePath: 'old/addon.cc', destinationPath: 'new/addon.cc' }],
    dependencies: [{ sourcePath: 'old/helper.mjs', destinationPath: 'new/helper.mjs', provenancePath: 'tooling.json' }],
    literalEdits: [{ sourcePath: 'old/addon.cc', fromText: '.fusionkit-local-subtitle-', toText: '.fusionkit-subtitle-studio-', count: 1, reason: 'Independent partial namespace.' }], deferred: [] };
  const bytes = fs.readFileSync(path.join(root, 'old/helper.mjs'));
  write('new/helper.mjs', bytes.toString());
  write('tooling.json', JSON.stringify({ sourceCommit, files: [{ ...recipe.dependencies[0], sourceSha256: hash(bytes), destinationSha256: hash(bytes) }] }));
  return { root, write, git, baseline, recipe, options: { root, baseline, recipe }, apply: { root, provenancePath: 'native.json' } };
}
describe('independent native source copy', () => {
  it('rebuilds exact audited C++ changes and binds shared tools to their owner', () => {
    const f = fixture(), plan = createNativeCopyPlan(f.options);
    expect(plan.files[0].bytes.toString()).toContain('.fusionkit-subtitle-studio-');
    expect(plan.files[0].bytes.toString()).toContain('ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST');
    applyNativeCopyPlan(plan, { ...f.apply, write: true });
    expect(createNativeCopyPlan(f.options).provenance).toEqual(plan.provenance);
    expect(() => applyNativeCopyPlan(plan, f.apply)).not.toThrow();
    expect(hash(fs.readFileSync(path.join(f.root, 'new/addon.cc')))).toBe(plan.provenance.files[0].destinationSha256);
  });
  it('rejects stale exact-text rules and undeclared dependencies', () => {
    const f = fixture();
    expect(() => createNativeCopyPlan({ ...f.options, recipe: { ...f.recipe, literalEdits: [{ ...f.recipe.literalEdits[0], count: 2 }] } })).toThrow(/literal count differs/);
    expect(() => createNativeCopyPlan({ ...f.options, recipe: { ...f.recipe, dependencies: [] } })).toThrow(/Missing native dependency/);
  });
  it('refuses source hash and commit mismatches', () => {
    const f = fixture();
    const baseline = structuredClone(f.baseline); baseline.files[0].sha256 = '0'.repeat(64);
    expect(() => createNativeCopyPlan({ ...f.options, baseline })).toThrow(/source content differs/);
    expect(() => createNativeCopyPlan({ ...f.options, recipe: { ...f.recipe, sourceCommit: '0'.repeat(40) } })).toThrow(/source commit differs/);
  });
  it.each(['edit', 'delete', 'filter'])('rejects %s source drift before copying', operation => {
    const f = fixture();
    if (operation === 'edit') f.write('old/addon.cc', 'user edit');
    if (operation === 'delete') fs.unlinkSync(path.join(f.root, 'old/addon.cc'));
    if (operation === 'filter') { f.write('.gitattributes', '*.cc filter=never\n'); f.git('config', 'filter.never.clean', 'this-command-must-not-execute'); }
    expect(() => createNativeCopyPlan(f.options)).toThrow(/Worktree drift/);
    expect(fs.existsSync(path.join(f.root, 'new/addon.cc'))).toBe(false);
  });
  it.each(['bytes', 'provenance'])('refuses shared dependency %s tampering', kind => {
    const f = fixture();
    if (kind === 'bytes') f.write('new/helper.mjs', 'export const value = 9;\n');
    else { const owner = JSON.parse(fs.readFileSync(path.join(f.root, 'tooling.json'), 'utf8')); owner.files[0].sourceSha256 = '0'.repeat(64); f.write('tooling.json', JSON.stringify(owner)); }
    expect(() => createNativeCopyPlan(f.options)).toThrow(/dependency provenance differs/);
  });
  it('preflights conflicts and preserves both source and user destination', () => {
    const f = fixture(), plan = createNativeCopyPlan(f.options);
    f.write('new/addon.cc', 'user destination');
    expect(() => applyNativeCopyPlan(plan, { ...f.apply, write: true })).toThrow(/Destination content differs/);
    expect(fs.existsSync(path.join(f.root, 'native.json'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, 'new/addon.cc'), 'utf8')).toBe('user destination');
    expect(() => createNativeCopyPlan({ ...f.options, recipe: { ...f.recipe, files: [...f.recipe.files, { sourcePath: 'old/helper.mjs', destinationPath: 'new/ADDON.cc' }], dependencies: [] } })).toThrow(/Conflicting native destination/);
  });
  it('refuses symlinked shared dependencies without touching their target', () => {
    const f = fixture(); fs.unlinkSync(path.join(f.root, 'new/helper.mjs'));
    fs.symlinkSync(path.join(f.root, 'old/helper.mjs'), path.join(f.root, 'new/helper.mjs'));
    expect(() => createNativeCopyPlan(f.options)).toThrow(/Symlink native dependency/);
  });
});
