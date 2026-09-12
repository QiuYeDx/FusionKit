import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateBaseline, serialize, checkBaseline, checkWorktree } from '../../scripts/subtitle-studio-provenance/generate.mjs';

const temporaryRoots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(extraFiles: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-provenance-'));
  temporaryRoots.push(root);
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries({
    'package.json': '{"type":"module"}\n',
    '.gitattributes': '*.ts text eol=lf\n',
    'src/legacy/index.ts': `import { type Value } from '@/types';\nimport { value } from './value';\nexport const fixture = new URL('fixture.json', import.meta.url);\nthrow new Error('this module must never execute');\n`,
    'src/legacy/value.ts': 'export const value = 42;\n',
    'src/legacy/fixture.json': '{"source":"test-only"}\n',
    'src/types.ts': 'export interface Value { count: number }\n',
    ...extraFiles,
  })) write(name, content);
  git('add', '.');
  git('-c', 'user.name=Provenance test', '-c', 'user.email=provenance@example.invalid', 'commit', '-qm', 'fixture');
  const sourceCommit = git('rev-parse', 'HEAD');
  const policy = {
    version: 1, roots: ['src/legacy/'],
    rules: [
      { prefix: 'src/legacy/', destination: 'new/transcription/', category: 'source', disposition: 'planned-copy', reason: 'Isolated test input.' },
      { source: 'src/types.ts', destination: 'new/domain.ts', category: 'type', disposition: 'planned-copy', reason: 'Alias dependency.' },
    ],
    dynamicAudits: [], runtimeReferences: [], snapshots: [], manualAudits: [], excludedScopes: [],
  };
  const options = { root, sourceCommit, policy, baselinePath: 'baseline.json' };
  const freeze = () => {
    const baseline = generateBaseline(options);
    write('baseline.json', serialize(baseline));
    return baseline;
  };
  return { ...options, options, git, write, freeze };
}

describe('fixed Git transcription provenance', () => {
  it('rebuilds identical canonical bytes without executing source, including alias/type/resource edges', () => {
    const f = fixture();
    const first = f.freeze();
    expect(serialize(generateBaseline(f.options))).toBe(serialize(first));
    expect(first.files.map(file => file.sourcePath)).toEqual(['src/legacy/fixture.json', 'src/legacy/index.ts', 'src/legacy/value.ts', 'src/types.ts']);
    expect(first.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'relative-url', resolvedPath: 'src/legacy/fixture.json' }),
      expect.objectContaining({ typeOnly: true, resolvedPath: 'src/types.ts' }),
    ]));
    const value = first.files.find(file => file.sourcePath === 'src/legacy/value.ts')!;
    expect(value.blobOid).toBe(f.git('rev-parse', `${f.sourceCommit}:src/legacy/value.ts`));
    expect(value.byteSize).toBe(Buffer.byteLength('export const value = 42;\n'));
    expect(serialize(first)).not.toContain(f.root);
    f.write('unrelated.md', 'later unrelated commit\n'); f.git('add', 'unrelated.md');
    f.git('-c', 'user.name=Provenance test', '-c', 'user.email=provenance@example.invalid', 'commit', '-qm', 'later');
    expect(checkBaseline(f.options)).toEqual(first);
  });

  it.each(['digest', 'omission', 'destination', 'commit', 'policy'])('rejects baseline %s tampering without rewriting it', kind => {
    const f = fixture();
    const baseline = f.freeze();
    if (kind === 'digest') baseline.files[0].sha256 = '0'.repeat(64);
    if (kind === 'omission') baseline.files.pop();
    if (kind === 'destination') baseline.files[0].plannedDestination = 'different.json';
    if (kind === 'commit') baseline.sourceCommit = '0'.repeat(40);
    if (kind === 'policy') baseline.policy.roots = [];
    const tampered = serialize(baseline);
    f.write('baseline.json', tampered);
    expect(() => checkBaseline(f.options)).toThrow(/Baseline/);
    expect(fs.readFileSync(path.join(f.root, 'baseline.json'), 'utf8')).toBe(tampered);
  });

  it.each(['change', 'add', 'delete'])('detects worktree source %s while historical validation still passes', operation => {
    const f = fixture(); f.freeze();
    if (operation === 'change') f.write('src/legacy/value.ts', 'export const value = 43;\n');
    if (operation === 'add') f.write('src/legacy/new.ts', 'export const added = true;\n');
    if (operation === 'delete') fs.unlinkSync(path.join(f.root, 'src/legacy/value.ts'));
    expect(() => checkBaseline(f.options)).not.toThrow();
    expect(() => checkWorktree(f.options)).toThrow(/Worktree drift/);
  });

  it('uses Git clean newline rules and refuses external filters without executing them', () => {
    const f = fixture(); f.freeze();
    f.write('src/legacy/value.ts', 'export const value = 42;\r\n');
    expect(() => checkWorktree(f.options)).not.toThrow();
    f.write('.gitattributes', '*.ts text eol=lf filter=untrusted\n');
    f.git('config', 'filter.untrusted.clean', 'this-command-must-not-run');
    expect(() => checkWorktree(f.options)).toThrow(/Unsupported clean filter/);
  });

  it.each([
    "import './missing';\n",
    "export const fixture = new URL('missing.json', import.meta.url);\n",
  ])('rejects unresolved relative imports and URL fixtures', source => {
    const f = fixture({ 'src/legacy/index.ts': source });
    expect(() => generateBaseline(f.options)).toThrow(/Unresolved relative dependency/);
  });

  it('rejects duplicate destination paths including case-only collisions', () => {
    const f = fixture();
    f.policy.rules.push({ source: 'src/types.ts', destination: 'new/transcription/value.ts', category: 'source', disposition: 'planned-copy', reason: 'collision' });
    // Replace the previous exact rule, as real mapping policy gives it priority.
    f.policy.rules.splice(1, 1);
    expect(() => generateBaseline(f.options)).toThrow(/Conflicting destination/);
    f.policy.rules[1].destination = 'new/transcription/VALUE.ts';
    expect(() => generateBaseline(f.options)).toThrow(/Conflicting destination/);
  });

  it('requires exact audits for computed import and createRequire, and rejects stale/new loader expressions', () => {
    const expression = 'createRequire(import.meta.url)(addonPath)';
    const source = `import { createRequire } from 'node:module';\n${expression};\n`;
    const f = fixture({ 'src/legacy/index.ts': source });
    expect(() => generateBaseline(f.options)).toThrow(/Unaudited dynamic dependency/);
    const policy = { ...f.policy, dynamicAudits: [{ source: 'src/legacy/index.ts', sourceSha256: digest(source), expression, targets: [], reason: 'Prepared test addon only; never executed.' }] };
    expect(generateBaseline({ ...f.options, policy }).dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ resolution: 'audited-dynamic' })]));
    expect(() => generateBaseline({ ...f.options, policy: { ...policy, dynamicAudits: [{ ...policy.dynamicAudits[0], expression: 'require(differentPath)' }] } })).toThrow(/Unaudited dynamic dependency/);
    const changed = fixture({ 'src/legacy/index.ts': "const module = import(newLoaderPath);\n" });
    expect(() => generateBaseline({ ...changed.options, policy })).toThrow(/Unaudited dynamic dependency/);
    const sameExpression = fixture({ 'src/legacy/index.ts': `const addonPath = 'new-unreviewed-target';\n${source}` });
    expect(() => generateBaseline({ ...sameExpression.options, policy })).toThrow(/Dynamic audit source changed/);
    expect(() => generateBaseline({ ...f.options, policy: { ...policy, dynamicAudits: [...policy.dynamicAudits, { source: 'src/legacy/index.ts', expression: 'require(stalePath)', targets: [], reason: 'Stale audit.' }] } })).toThrow(/Stale dynamic audit/);
  });

  it('preserves exact audit targets and refuses missing target files', () => {
    const f = fixture({ 'src/legacy/index.ts': 'import(moduleUrl);\n' });
    const policy = { ...f.policy, dynamicAudits: [{ source: 'src/legacy/index.ts', sourceSha256: digest('import(moduleUrl);\n'), expression: 'import(moduleUrl)', targets: ['src/legacy/value.ts'], reason: 'Fixed local verifier.' }] };
    expect(generateBaseline({ ...f.options, policy }).files.some(file => file.sourcePath === 'src/legacy/value.ts')).toBe(true);
    policy.dynamicAudits[0].targets = ['src/legacy/missing.ts'];
    expect(() => generateBaseline({ ...f.options, policy })).toThrow(/Missing source/);
  });

  it('extracts effective literal defaults and arithmetic without evaluating business code', () => {
    const f = fixture({ 'src/legacy/defaults.ts': 'export const CONTRACT = { model: { id: "frozen" }, bytes: 64 * 1024 } as const;\nexport const DEFAULTS = { model: CONTRACT.model.id, enabled: true, duration: 7_000 } as const;\n' });
    const policy = { ...f.policy, snapshots: [{ source: 'src/legacy/defaults.ts', symbols: ['CONTRACT', 'DEFAULTS'] }] };
    const baseline = generateBaseline({ ...f.options, policy });
    expect(baseline.defaultSnapshots[1].value).toEqual({ model: 'frozen', enabled: true, duration: 7000 });
  });

  it('fails on missing selected roots and syntactically invalid source', () => {
    const f = fixture();
    expect(() => generateBaseline({ ...f.options, policy: { ...f.policy, roots: ['missing/'] } })).toThrow(/Missing selected source/);
    const broken = fixture({ 'src/legacy/index.ts': 'export const = ;\n' });
    expect(() => generateBaseline(broken.options)).toThrow(/Cannot parse source/);
  });
});
