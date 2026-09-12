import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSpeechResources, type MigrateSpeechResourcesOptions, type SpeechMigrationFile, type SpeechMigrationResource } from '../../electron/main/speech-resources/migration';

const roots: string[] = [];
const bytes = Buffer.from('fixed native model payload');
const oldMetadata = Buffer.from('{"namespace":"old"}\n');
const canonicalMetadata = Buffer.from('{"namespace":"speech"}\n');
const expected = (relativePath: string, value: Buffer, contents = false): SpeechMigrationFile => ({ relativePath, byteSize: value.length,
  sha256: createHash('sha256').update(value).digest('hex'), ...(contents ? { contents: value } : {}) });
async function present(p: string) { try { await lstat(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function install(root: string, files: readonly SpeechMigrationFile[]) {
  for (const f of files) { const destination = path.join(root, f.relativePath); await mkdir(path.dirname(destination), { recursive: true });
    const content = f.contents ?? (f.sha256 === expected('', bytes).sha256 ? bytes : oldMetadata); await writeFile(destination, content); }
}
async function fixture(options: { twoSources?: boolean; changedManifestPath?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'srm-unit-'))); roots.push(root);
  const sharedRoot = path.join(root, 'speech-resources');
  const legacyFiles = [expected('native/model.bin', bytes), expected('manifest.json', oldMetadata)];
  const files = [expected('native/model.bin', bytes), expected(options.changedManifestPath ? 'manifests/speech.json' : 'manifest.json', canonicalMetadata, true)];
  const resource: SpeechMigrationResource = { id: 'fixed-resource', relativeDirectory: 'models/fixed-resource', files,
    sources: [{ root: 'local-subtitle', relativeDirectory: 'models/fixed-resource', files: legacyFiles },
      { root: 'subtitle-studio/transcription', relativeDirectory: 'models/fixed-resource', files: legacyFiles }] };
  const source = path.join(root, 'local-subtitle', resource.relativeDirectory), other = path.join(root, 'subtitle-studio/transcription', resource.relativeDirectory);
  const target = path.join(sharedRoot, resource.relativeDirectory);
  await install(source, legacyFiles); if (options.twoSources) await install(other, legacyFiles);
  const input: MigrateSpeechResourcesOptions = { userDataRoot: root, sharedRoot, resources: [resource] };
  return { root, sharedRoot, resource, source, other, target, input };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(await realpath(root)).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(root)).toMatch(/^srm-unit-/);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('fixed speech resource local migration', () => {
  it.each([false, true])('moves payload identity without copying and rewrites bounded metadata (new path: %s)', async changedManifestPath => {
    const f = await fixture({ changedManifestPath }); const before = await lstat(path.join(f.source, 'native/model.bin'), { bigint: true });
    const result = await migrateSpeechResources(f.input);
    expect(result.resources[0]).toMatchObject({ status: 'ready', migratedFrom: 'local-subtitle', issues: [] });
    expect(result.cleanupPending).toBe(false); expect(await present(f.source)).toBe(false);
    const after = await lstat(path.join(f.target, 'native/model.bin'), { bigint: true }); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await readFile(path.join(f.target, changedManifestPath ? 'manifests/speech.json' : 'manifest.json'))).toEqual(canonicalMetadata);
    expect(await readdir(path.join(f.sharedRoot, '.migration'))).toEqual([]);
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('ready');
  });

  it('removes two verified old copies only after canonical publication and leaves unrelated directories alone', async () => {
    const f = await fixture({ twoSources: true }); const unrelated = path.join(f.root, 'local-subtitle', 'notes.txt'); await writeFile(unrelated, 'keep');
    const result = await migrateSpeechResources(f.input);
    expect(result.resources[0]).toMatchObject({ status: 'ready', deduplicatedSources: ['subtitle-studio/transcription'] });
    expect(await present(f.source)).toBe(false); expect(await present(f.other)).toBe(false);
    expect(await readFile(path.join(f.target, 'native/model.bin'))).toEqual(bytes); expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  it.each(['journal-written', 'source-renamed', 'metadata-prepared', 'metadata-rewritten', 'published'])('recovers after interruption at %s without downloading or losing payload', async event => {
    const f = await fixture(); let tripped = false;
    const failed = await migrateSpeechResources({ ...f.input, hooks: { checkpoint(p) { if (p.event === event && !tripped) { tripped = true; throw new Error('simulated process interruption'); } } } });
    expect(tripped).toBe(true); expect(failed.resources[0]?.status).toBe('blocked');
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('ready');
    expect(await readFile(path.join(f.target, 'native/model.bin'))).toEqual(bytes);
    expect(await readdir(path.join(f.sharedRoot, '.migration'))).toEqual([]);
  });

  it('resumes partially deleted duplicate cleanup and retains the canonical copy throughout', async () => {
    const f = await fixture({ twoSources: true }); let tripped = false;
    const first = await migrateSpeechResources({ ...f.input, hooks: { checkpoint(p) { if (p.event === 'after-delete-file' && !tripped) { tripped = true; throw new Error('stop cleanup'); } } } });
    expect(first.resources[0]?.status).toBe('blocked'); expect(first.cleanupPending).toBe(true);
    expect(await readFile(path.join(f.target, 'native/model.bin'))).toEqual(bytes);
    const next = await migrateSpeechResources(f.input); expect(next.resources[0]?.status).toBe('ready');
    expect(await present(f.other)).toBe(false); expect(await readdir(path.join(f.sharedRoot, '.migration'))).toEqual([]);
  });

  it('preserves invalid old manifests and extra files while still allowing a verified other source', async () => {
    const f = await fixture({ twoSources: true }); await writeFile(path.join(f.source, 'unexpected.bin'), 'user bytes');
    const result = await migrateSpeechResources(f.input);
    expect(result.resources[0]).toMatchObject({ status: 'ready', migratedFrom: 'subtitle-studio/transcription' });
    expect(result.issues.map(i => i.code)).toContain('invalid_source'); expect(await readFile(path.join(f.source, 'unexpected.bin'), 'utf8')).toBe('user bytes');
    expect(await readFile(path.join(f.source, 'native/model.bin'))).toEqual(bytes);
  });

  it.each(['manifest.json', 'native/model.bin'])('never moves a hash-invalid source %s', async file => {
    const f = await fixture(); await writeFile(path.join(f.source, file), 'tampered');
    const result = await migrateSpeechResources(f.input); expect(result.resources[0]?.status).toBe('blocked');
    expect(result.issues[0]?.code).toBe('invalid_source'); expect(await readFile(path.join(f.source, file), 'utf8')).toBe('tampered'); expect(await present(f.target)).toBe(false);
  });

  it('does not overwrite an existing incompatible target', async () => {
    const f = await fixture(); await mkdir(f.target, { recursive: true }); await writeFile(path.join(f.target, 'other.txt'), 'keep');
    const result = await migrateSpeechResources(f.input); expect(result.resources[0]?.status).toBe('blocked'); expect(result.issues[0]?.code).toBe('target_conflict');
    expect(await readFile(path.join(f.target, 'other.txt'), 'utf8')).toBe('keep'); expect(await present(f.source)).toBe(true);
  });

  it('preserves a destination collision appearing immediately before publication', async () => {
    const f = await fixture(); const first = await migrateSpeechResources({ ...f.input, hooks: { async checkpoint(p) {
      if (p.event === 'before-publish') { await mkdir(f.target, { recursive: true }); await writeFile(path.join(f.target, 'other.txt'), 'keep'); }
    } } });
    expect(first.issues.map(i => i.code)).toContain('target_conflict'); expect(await readFile(path.join(f.target, 'other.txt'), 'utf8')).toBe('keep');
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('blocked');
    const tx = (await readdir(path.join(f.sharedRoot, '.migration'))).find(n => !n.includes('.'))!;
    expect(await readFile(path.join(f.sharedRoot, '.migration', tx, 'payload/native/model.bin'))).toEqual(bytes);
  });

  it('preserves recovery payload after a staged manifest is tampered', async () => {
    const f = await fixture(); await migrateSpeechResources({ ...f.input, hooks: { checkpoint(p) { if (p.event === 'source-renamed') throw new Error('stop'); } } });
    const tx = (await readdir(path.join(f.sharedRoot, '.migration'))).find(n => !n.includes('.'))!;
    const payload = path.join(f.sharedRoot, '.migration', tx, 'payload'); await writeFile(path.join(payload, 'manifest.json'), 'foreign metadata');
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('blocked');
    expect(await readFile(path.join(payload, 'manifest.json'), 'utf8')).toBe('foreign metadata'); expect(await readFile(path.join(payload, 'native/model.bin'))).toEqual(bytes);
  });

  it('does not infer recovery ownership from a prefix or a tampered journal', async () => {
    const f = await fixture(); await mkdir(path.join(f.sharedRoot, '.migration', '0011223344556677'), { recursive: true });
    await writeFile(path.join(f.sharedRoot, '.migration', '0011223344556677.json'), JSON.stringify({ version: 1, source: '../foreign' }));
    const result = await migrateSpeechResources(f.input); expect(result.resources[0]?.status).toBe('blocked'); expect(result.issues[0]?.code).toBe('unknown_transaction');
    expect(await present(f.source)).toBe(true); expect(await present(path.join(f.sharedRoot, '.migration', '0011223344556677.json'))).toBe(true);
  });

  it('rejects source junctions and never follows them into other files', async () => {
    const f = await fixture(); const moved = path.join(f.root, 'unrelated'); await rename(f.source, moved); await symlink(moved, f.source, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await migrateSpeechResources(f.input); expect(result.resources[0]?.status).toBe('blocked');
    expect(await readFile(path.join(moved, 'native/model.bin'))).toEqual(bytes); expect((await lstat(f.source)).isSymbolicLink()).toBe(true);
  });

  it('rejects shared-root junctions before modifying either source or junction target', async () => {
    const f = await fixture(); const outside = path.join(f.root, 'unrelated'); await mkdir(outside); await symlink(outside, f.sharedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await migrateSpeechResources(f.input); expect(result.issues[0]?.code).toBe('invalid_root'); expect(await readdir(outside)).toEqual([]); expect(await present(f.source)).toBe(true);
  });

  it('retains the quarantined valid source if the committed target changes before duplicate deletion', async () => {
    const f = await fixture({ twoSources: true }); let changed = false;
    const result = await migrateSpeechResources({ ...f.input, hooks: { async checkpoint(p) { if (p.event === 'before-delete-file' && !changed) { changed = true; await writeFile(path.join(f.target, 'native/model.bin'), 'changed target'); } } } });
    expect(result.resources[0]?.status).toBe('blocked'); expect(result.issues.map(i => i.code)).toContain('target_conflict');
    const tx = (await readdir(path.join(f.sharedRoot, '.migration'))).find(n => !n.includes('.'))!;
    expect(await readFile(path.join(f.sharedRoot, '.migration', tx, 'payload/native/model.bin'))).toEqual(bytes);
  });

  it('reports source disappearance after durable intent without scanning elsewhere', async () => {
    const f = await fixture(); const elsewhere = path.join(f.root, 'elsewhere');
    await migrateSpeechResources({ ...f.input, hooks: { async checkpoint(p) { if (p.event === 'journal-written') { await rename(f.source, elsewhere); throw new Error('stop'); } } } });
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('blocked'); expect(await readFile(path.join(elsewhere, 'native/model.bin'))).toEqual(bytes);
  });

  it('does not adopt an identity-replaced source even if replacement bytes match the catalog', async () => {
    const f = await fixture(); const original = path.join(f.root, 'original-kept');
    await migrateSpeechResources({ ...f.input, hooks: { async checkpoint(p) { if (p.event === 'journal-written') {
      await rename(f.source, original); await install(f.source, f.resource.sources[0]!.files); throw new Error('stop');
    } } } });
    const result = await migrateSpeechResources(f.input); expect(result.resources[0]?.status).toBe('blocked');
    expect(await readFile(path.join(original, 'native/model.bin'))).toEqual(bytes); expect(await readFile(path.join(f.source, 'native/model.bin'))).toEqual(bytes);
  });

  it('refuses a changed catalog during recovery and keeps the earlier verified payload', async () => {
    const f = await fixture(); await migrateSpeechResources({ ...f.input, hooks: { checkpoint(p) { if (p.event === 'source-renamed') throw new Error('stop'); } } });
    const metadata = Buffer.from('{"namespace":"unexpected-revision"}\n');
    const changed = { ...f.resource, files: [f.resource.files[0]!, expected('manifest.json', metadata, true)] };
    expect((await migrateSpeechResources({ ...f.input, resources: [changed] })).issues[0]?.code).toBe('unknown_transaction');
    expect((await migrateSpeechResources(f.input)).resources[0]?.status).toBe('ready');
  });

  it('does not touch resource bytes when already aborted', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    const result = await migrateSpeechResources({ ...f.input, signal: controller.signal });
    expect(result.issues[0]?.code).toBe('cancelled'); expect(await present(f.source)).toBe(true); expect(await present(f.target)).toBe(false);
  });

  it('reports cross-device failure without copying or removing the source', async () => {
    const f = await fixture(); const result = await migrateSpeechResources({ ...f.input, hooks: { checkpoint(p) { if (p.event === 'before-source-rename') throw Object.assign(new Error('different volume'), { code: 'EXDEV' }); } } });
    expect(result.issues.map(i => i.code)).toContain('cross_device'); expect(await readFile(path.join(f.source, 'native/model.bin'))).toEqual(bytes); expect(await present(f.target)).toBe(false);
  });

  it('joins concurrent entry calls instead of allowing two publishers', async () => {
    const f = await fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
    const first = migrateSpeechResources({ ...f.input, hooks: { async checkpoint(p) { if (p.event === 'source-verified') { reached(); await held; } } } });
    await started; const second = migrateSpeechResources(f.input); expect(second).toBe(first); release(); expect((await first).resources[0]?.status).toBe('ready');
  });

  it('does not migrate unrelated roots, transform payloads, or trust arbitrary metadata bytes', async () => {
    const f = await fixture(); expect(() => migrateSpeechResources({ ...f.input, sharedRoot: path.join(f.root, 'foreign') })).toThrow();
    expect(() => migrateSpeechResources({ ...f.input, resources: [{ ...f.resource, relativeDirectory: '../other' }] })).toThrow();
    expect(() => migrateSpeechResources({ ...f.input, resources: [{ ...f.resource, files: [expected('different.bin', bytes)] }] })).toThrow();
    expect(() => migrateSpeechResources({ ...f.input, resources: [{ ...f.resource, files: [{ ...expected('manifest.json', canonicalMetadata, true), contents: oldMetadata }] }] })).toThrow();
    expect(await present(f.source)).toBe(true);
  });
});
