import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateBaseline, serialize } from '../../scripts/subtitle-studio-provenance/generate.mjs';
import { applyCopyPlan, createCopyPlan, COMPOSITION_AUDIT_PATH } from '../../scripts/subtitle-studio-provenance/copy.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function fixture(large = false, composition = false, buildComposition = false, packageVersion = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-copy-')); roots.push(root);
  const write = (name: string, bytes: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes); };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write('old/index.ts', "import { value } from './value';\nimport type { Value } from './value';\nconst resource = new URL('fixture.json', import.meta.url);\n// local-subtitle:fixture is historical documentation.\nexport const channel = 'local-subtitle:fixture';\nthrow new Error('never execute this module');\n");
  write('old/value.ts', 'export const value = 42;\nexport type Value = number;\n' + (large ? '// Large source for direct Git file hashing.\n'.repeat(8192) : ''));
  write('old/fixture.json', '{"root":"old/runtime","upstreamHash":"unchanged"}\n');
  if (composition) write('app/main.ts', 'export const shutdown = "legacy";\n');
  if (buildComposition) {
    write('package.json', JSON.stringify({ name: 'fixture', version: packageVersion, scripts: { build: 'vite build && electron-builder', dev: 'vite' }, dependencies: { fixture: '1.0.0' }, devDependencies: { vite: '5.4.11' } }, null, 2) + '\n');
    write('electron-builder.json', '{"extraResources":[]}\n');
    write('pnpm-lock.yaml', 'lockfileVersion: 6.0\n');
  }
  git('add', '.'); git('-c', 'user.name=Copy test', '-c', 'user.email=copy@example.invalid', 'commit', '-qm', 'frozen');
  const sourceCommit = git('rev-parse', 'HEAD');
  const baselinePolicy = { version: 1, roots: ['old/', ...(composition ? ['app/'] : []), ...(buildComposition ? ['package.json', 'electron-builder.json', 'pnpm-lock.yaml'] : [])], rules: [
    { source: 'old/index.ts', destination: 'new/transcription/index.ts', category: 'source', disposition: 'planned-copy', reason: 'test' },
    { source: 'old/value.ts', destination: 'new/domain.ts', category: 'source', disposition: 'planned-copy', reason: 'test' },
    { source: 'old/fixture.json', destination: 'new/data/fixture.json', category: 'resource', disposition: 'planned-copy', reason: 'test' },
    ...(composition ? [{ source: 'app/main.ts', destination: null, category: 'application-composition', disposition: 'reference-only', follow: false, reason: 'Application wiring is evidence only.' }] : []),
    ...(buildComposition ? ['package.json', 'electron-builder.json', 'pnpm-lock.yaml'].map(source => ({ source, destination: null, category: 'build-composition', disposition: 'reference-only', follow: false, reason: 'Build wiring is evidence only.' })) : []),
  ], dynamicAudits: [], snapshots: [], manualAudits: [], runtimeReferences: [], excludedScopes: [] };
  const baseline = generateBaseline({ root, sourceCommit, policy: baselinePolicy });
  write('baseline.json', serialize(baseline));
  const policy = { version: 1, roots: ['old/index.ts'], includePrefixes: [], assemblySource: '', productionPrefix: '', textEdits: [], deferred: ['No runtime is created.'] };
  const literalEdits = [{ sourcePath: 'old/index.ts', from: "'local-subtitle:fixture'", to: "'studio:fixture'", count: 1, reason: 'New IPC namespace.' }];
  const jsonEdits = [{ sourcePath: 'old/fixture.json', pointer: '/root', from: 'old/runtime', to: 'new/runtime', reason: 'Independent root.' }];
  const options = { root, sourceCommit, baselinePath: 'baseline.json', baselinePolicy, policy, literalEdits, jsonEdits };
  return { root, write, git, baseline, options, apply: { root, provenancePath: 'fork.json' } };
}

function compositionFixture() {
  const f = fixture(false, true);
  const originalPlan = createCopyPlan(f.options);
  const baselineBytes = fs.readFileSync(path.join(f.root, 'baseline.json'));
  const original = fs.readFileSync(path.join(f.root, 'app/main.ts'), 'utf8');
  const current = 'export const shutdown = "legacy-and-studio";\n';
  f.write('app/main.ts', current);
  const source = f.baseline.files.find(file => file.sourcePath === 'app/main.ts')!;
  const audit = { schemaVersion: 1, sourceCommit: f.baseline.sourceCommit, entries: [{ sourcePath: source.sourcePath,
    sourceBlobOid: source.blobOid, sourceSha256: source.sha256,
    currentBlobOid: f.git('hash-object', '--path=app/main.ts', '--', 'app/main.ts'), reason: 'Reviewed the complete application shutdown wiring.' }] };
  const writeAudit = () => f.write(COMPOSITION_AUDIT_PATH, JSON.stringify(audit));
  writeAudit();
  return { ...f, audit, writeAudit, originalPlan, baselineBytes, original, current };
}

function packageCompositionFixture(packageVersion = '1.0.0') {
  const f = fixture(false, false, true, packageVersion);
  const originalPlan = createCopyPlan(f.options);
  const baselineBytes = fs.readFileSync(path.join(f.root, 'baseline.json'));
  const current = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8'));
  current.scripts.build += ' --config electron-builder.subtitle-studio.json --publish never';
  const source = f.baseline.files.find(file => file.sourcePath === 'package.json')!;
  const audit = { schemaVersion: 1, sourceCommit: f.baseline.sourceCommit, entries: [{ sourcePath: source.sourcePath,
    sourceBlobOid: source.blobOid, sourceSha256: source.sha256, currentBlobOid: '', reason: 'Reviewed only the default build resource composition.' }] };
  const writeAudit = () => f.write(COMPOSITION_AUDIT_PATH, JSON.stringify(audit));
  const writeCurrent = () => {
    f.write('package.json', JSON.stringify(current, null, 2) + '\n');
    audit.entries[0].currentBlobOid = f.git('hash-object', '--path=package.json', '--', 'package.json');
    writeAudit();
  };
  writeCurrent();
  return { ...f, current, audit, writeAudit, writeCurrent, originalPlan, baselineBytes };
}

describe('transcription source copy', () => {
  it('recomputes relative module/type/URL paths and only changes audited tokens/JSON fields', () => {
    const f = fixture(); const plan = createCopyPlan(f.options);
    const index = plan.files.find(file => file.sourcePath === 'old/index.ts')!;
    expect(index.bytes.toString()).toContain("from '../domain'");
    expect(index.bytes.toString()).toContain("new URL('../data/fixture.json', import.meta.url)");
    expect(index.bytes.toString()).toContain("export const channel = 'studio:fixture'");
    expect(index.bytes.toString()).toContain('// local-subtitle:fixture is historical documentation.');
    const data = JSON.parse(plan.files.find(file => file.sourcePath === 'old/fixture.json')!.bytes.toString());
    expect(data).toEqual({ root: 'new/runtime', upstreamHash: 'unchanged' });
    expect(plan.files.find(file => file.sourcePath === 'old/value.ts')!.transforms).toEqual([]);
    applyCopyPlan(plan, { ...f.apply, write: true });
    for (const item of plan.provenance.files) expect(hash(fs.readFileSync(path.join(f.root, item.destinationPath)))).toBe(item.destinationSha256);
    expect(serialize(createCopyPlan(f.options).provenance)).toBe(serialize(plan.provenance));
    expect(() => applyCopyPlan(createCopyPlan(f.options), f.apply)).not.toThrow();
  });

  it('rejects conflicting destinations before writing any file', () => {
    const f = fixture();
    const baseline = structuredClone(f.baseline);
    baseline.files.find(file => file.sourcePath === 'old/value.ts')!.plannedDestination = 'new/transcription/INDEX.ts';
    expect(() => createCopyPlan({ ...f.options, baseline })).toThrow(/Conflicting destination/);
    expect(fs.existsSync(path.join(f.root, 'new'))).toBe(false);
  });

  it.each(['edit', 'delete', 'add'])('refuses current source %s drift while preserving the fixed baseline', operation => {
    const f = fixture(); const before = fs.readFileSync(path.join(f.root, 'baseline.json'));
    if (operation === 'edit') f.write('old/value.ts', 'export const value = 43;\n');
    if (operation === 'delete') fs.unlinkSync(path.join(f.root, 'old/value.ts'));
    if (operation === 'add') f.write('old/added.ts', 'export const value = 44;\n');
    expect(() => createCopyPlan(f.options)).toThrow(/Worktree drift/);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(before);
    expect(fs.existsSync(path.join(f.root, 'new'))).toBe(false);
  });

  it('refuses an unrecorded relative dependency or a missing closure target', () => {
    const f = fixture();
    const baseline = structuredClone(f.baseline);
    baseline.dependencies = baseline.dependencies.filter(edge => edge.resolvedPath !== 'old/value.ts');
    expect(() => createCopyPlan({ ...f.options, baseline })).toThrow(/Missing dependency edge/);
    baseline.dependencies = f.baseline.dependencies;
    baseline.files = baseline.files.filter(file => file.sourcePath !== 'old/value.ts');
    expect(() => createCopyPlan({ ...f.options, baseline })).toThrow(/Selected source missing/);
  });

  it('checks Git blob size and SHA independently of supplied inventory metadata', () => {
    const f = fixture(); const baseline = structuredClone(f.baseline);
    baseline.files[0].sha256 = '0'.repeat(64);
    expect(() => createCopyPlan({ ...f.options, baseline })).toThrow(/Source identity differs/);
  });

  it('refuses changed or missing destinations and never overwrites user content', () => {
    const f = fixture(); const plan = createCopyPlan(f.options);
    f.write('new/domain.ts', 'user edit\n');
    expect(() => applyCopyPlan(plan, { ...f.apply, write: true })).toThrow(/Destination content differs/);
    expect(fs.readFileSync(path.join(f.root, 'new/domain.ts'), 'utf8')).toBe('user edit\n');
    expect(fs.existsSync(path.join(f.root, 'new/data/fixture.json'))).toBe(false);
    fs.unlinkSync(path.join(f.root, 'new/domain.ts'));
    expect(() => applyCopyPlan(plan, f.apply)).toThrow(/Missing destination/);
    applyCopyPlan(plan, { ...f.apply, write: true });
    f.write('new/domain.ts', 'later edit\n');
    expect(() => applyCopyPlan(plan, f.apply)).toThrow(/Destination content differs/);
    expect(() => applyCopyPlan(plan, { ...f.apply, write: true })).toThrow(/Destination content differs/);
  });

  it('rejects stale literal counts, JSON values, and overlapping transformations', () => {
    const f = fixture();
    expect(() => createCopyPlan({ ...f.options, literalEdits: [{ ...f.options.literalEdits[0], count: 2 }] })).toThrow(/Literal audit count changed/);
    expect(() => createCopyPlan({ ...f.options, jsonEdits: [{ ...f.options.jsonEdits[0], from: 'wrong' }] })).toThrow(/JSON audit value changed/);
    expect(() => createCopyPlan({ ...f.options, literalEdits: [...f.options.literalEdits, f.options.literalEdits[0]] })).toThrow(/Overlapping/);
  });

  it('refuses source and output symlinks', () => {
    const f = fixture(); const plan = createCopyPlan(f.options);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-copy-outside-')); roots.push(outside);
    fs.symlinkSync(outside, path.join(f.root, 'new'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => applyCopyPlan(plan, { ...f.apply, write: true })).toThrow(/Symlink destination/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(f.root, 'old/value.ts'));
    fs.symlinkSync(path.join(outside, 'unavailable.ts'), path.join(f.root, 'old/value.ts'));
    expect(() => createCopyPlan(f.options)).toThrow(/Worktree drift/);
  });

  it('hashes large source files with Git CRLF rules and refuses clean filters', () => {
    const f = fixture(true);
    const original = fs.readFileSync(path.join(f.root, 'old/value.ts'), 'utf8');
    expect(Buffer.byteLength(original)).toBeGreaterThan(256 * 1024);
    f.write('.gitattributes', '*.ts text eol=lf\n');
    f.write('old/value.ts', original.replaceAll('\n', '\r\n'));
    expect(() => createCopyPlan(f.options)).not.toThrow();
    f.write('.gitattributes', '*.ts text eol=lf filter=untrusted\n');
    f.git('config', 'filter.untrusted.clean', 'this-filter-must-not-execute');
    expect(() => createCopyPlan(f.options)).toThrow(/Unsupported clean filter/);
  });

  it('audits exact current application wiring while preserving every frozen copy and baseline byte', () => {
    const f = compositionFixture();
    expect(createCopyPlan(f.options)).toEqual(f.originalPlan);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(f.baselineBytes);
    f.write('.gitattributes', 'app/*.ts text eol=lf\n');
    f.write('app/main.ts', f.current.replaceAll('\n', '\r\n'));
    expect(createCopyPlan(f.options)).toEqual(f.originalPlan);
    f.write('old/value.ts', 'export const value = 43;\n');
    expect(() => createCopyPlan(f.options)).toThrow(/Changed source: old\/value.ts/);
  });

  it.each(['changed-current', 'reverted-current', 'missing-audit'] as const)('rejects %s instead of treating composition as an unchecked exception', kind => {
    const f = compositionFixture();
    if (kind === 'changed-current') f.write('app/main.ts', f.current + '// Unreviewed content.\n');
    if (kind === 'reverted-current') f.write('app/main.ts', f.original);
    if (kind === 'missing-audit') fs.unlinkSync(path.join(f.root, COMPOSITION_AUDIT_PATH));
    expect(() => createCopyPlan(f.options)).toThrow(/Changed (audited composition )?source: app\/main.ts/);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(f.baselineBytes);
  });

  it.each(['wrong-commit', 'wrong-source-sha', 'wrong-source-oid', 'unchanged-source', 'duplicate', 'unknown', 'wildcard', 'copied-source', 'extra-field'] as const)
    ('rejects an invalid composition audit: %s', kind => {
      const f = compositionFixture(), entry = f.audit.entries[0]!;
      if (kind === 'wrong-commit') f.audit.sourceCommit = '0'.repeat(40);
      if (kind === 'wrong-source-sha') entry.sourceSha256 = '0'.repeat(64);
      if (kind === 'wrong-source-oid') entry.sourceBlobOid = '0'.repeat(40);
      if (kind === 'unchanged-source') entry.currentBlobOid = entry.sourceBlobOid;
      if (kind === 'duplicate') f.audit.entries.push({ ...entry });
      if (kind === 'unknown') entry.sourcePath = 'app/absent.ts';
      if (kind === 'wildcard') entry.sourcePath = 'app/*.ts';
      if (kind === 'copied-source') {
        const copied = f.baseline.files.find(file => file.sourcePath === 'old/value.ts')!;
        Object.assign(entry, { sourcePath: copied.sourcePath, sourceBlobOid: copied.blobOid, sourceSha256: copied.sha256 });
      }
      if (kind === 'extra-field') Object.assign(entry, { allowAnyCurrentContent: true });
      f.writeAudit();
      expect(() => createCopyPlan(f.options)).toThrow(/composition audit/i);
    });

  it('does not let an approved composition bypass source symlink or clean-filter rejection', () => {
    const f = compositionFixture();
    f.write('.gitattributes', 'app/*.ts text eol=lf filter=untrusted\n');
    f.git('config', 'filter.untrusted.clean', 'this-filter-must-not-execute');
    expect(() => createCopyPlan(f.options)).toThrow(/Unsupported clean filter/);
    f.write('.gitattributes', 'app/*.ts text eol=lf\n');
    fs.unlinkSync(path.join(f.root, 'app/main.ts'));
    f.write('linked-main.ts', f.current);
    fs.symlinkSync(path.join(f.root, 'linked-main.ts'), path.join(f.root, 'app/main.ts'));
    expect(() => createCopyPlan(f.options)).toThrow(/Worktree symlink/);
  });

  it('permits the exact reviewed package build command while leaving frozen replay and baseline bytes unchanged', () => {
    const f = packageCompositionFixture();
    expect(createCopyPlan(f.options)).toEqual(f.originalPlan);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(f.baselineBytes);
    expect(createCopyPlan(f.options).files.some(file => file.sourcePath === 'package.json')).toBe(false);
    f.write('.gitattributes', '*.json text eol=lf\n');
    f.write('package.json', (JSON.stringify(f.current, null, 2) + '\n').replaceAll('\n', '\r\n'));
    expect(createCopyPlan(f.options)).toEqual(f.originalPlan);
  });

  it.each(['dependencies', 'devDependencies', 'other-script', 'name', 'version', 'added-field', 'deleted-field', 'unchanged-build', 'missing-build', 'invalid-build'] as const)
    ('refuses a package audit that also changes %s even with the exact current blob hash', kind => {
      const f = packageCompositionFixture();
      if (kind === 'dependencies') f.current.dependencies.fixture = '2.0.0';
      if (kind === 'devDependencies') f.current.devDependencies.vite = '6.0.0';
      if (kind === 'other-script') f.current.scripts.dev = 'vite --host';
      if (kind === 'name') f.current.name = 'changed';
      if (kind === 'version') f.current.version = '2.0.0';
      if (kind === 'added-field') f.current.packageManager = 'pnpm@10.0.0';
      if (kind === 'deleted-field') delete f.current.dependencies;
      if (kind === 'unchanged-build') f.current.scripts.build = 'vite build && electron-builder';
      if (kind === 'missing-build') delete f.current.scripts.build;
      if (kind === 'invalid-build') f.current.scripts.build = ['vite build'];
      f.writeCurrent();
      expect(() => createCopyPlan(f.options)).toThrow(/composition audit/);
      expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(f.baselineBytes);
    });

  it('accepts only the reviewed release version migration alongside the exact build change', () => {
    const f = packageCompositionFixture('0.3.0');
    f.current.version = '0.3.1';
    f.writeCurrent();
    expect(createCopyPlan(f.options)).toEqual(f.originalPlan);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'))).toEqual(f.baselineBytes);
    f.current.dependencies.fixture = '2.0.0';
    f.writeCurrent();
    expect(() => createCopyPlan(f.options)).toThrow(/permits only a scripts.build change/);
  });

  it.each([['0.2.11', '0.3.1'], ['0.3.0', '0.3.2'], ['0.3.1', '0.3.0']])('rejects an unaudited version migration %s -> %s', (sourceVersion, currentVersion) => {
    const f = packageCompositionFixture(sourceVersion);
    f.current.version = currentVersion;
    f.writeCurrent();
    expect(() => createCopyPlan(f.options)).toThrow(/permits only a scripts.build change/);
  });

  it.each(['missing-audit', 'stale-current', 'wrong-source-oid', 'wrong-source-sha', 'empty-reason'] as const)
    ('keeps exact package audit identities and reason mandatory: %s', kind => {
      const f = packageCompositionFixture();
      if (kind === 'missing-audit') fs.unlinkSync(path.join(f.root, COMPOSITION_AUDIT_PATH));
      else {
        if (kind === 'stale-current') f.audit.entries[0].currentBlobOid = '0'.repeat(40);
        if (kind === 'wrong-source-oid') f.audit.entries[0].sourceBlobOid = '0'.repeat(40);
        if (kind === 'wrong-source-sha') f.audit.entries[0].sourceSha256 = '0'.repeat(64);
        if (kind === 'empty-reason') f.audit.entries[0].reason = '  ';
        f.writeAudit();
      }
      expect(() => createCopyPlan(f.options)).toThrow(/Worktree drift|composition audit/i);
    });

  it.each(['electron-builder.json', 'pnpm-lock.yaml'])('does not extend the build exception to %s', sourcePath => {
    const f = packageCompositionFixture();
    const source = f.baseline.files.find(file => file.sourcePath === sourcePath)!;
    const entry = f.audit.entries[0];
    Object.assign(entry, { sourcePath, sourceBlobOid: source.blobOid, sourceSha256: source.sha256 });
    f.writeAudit();
    expect(() => createCopyPlan(f.options)).toThrow(/Composition audit is not supported reference-only evidence/);
  });
});
