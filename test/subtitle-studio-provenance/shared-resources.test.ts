import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { applySharedExtractionEdits, checkSharedResourceExtraction, SHARED_EXTRACTION_PATH } from '../../scripts/subtitle-studio-provenance/shared-resource-extraction.mjs';
import { checkSharedMigrationReceipts, SHARED_MIGRATION_RECEIPTS_PATH } from '../../scripts/subtitle-studio-provenance/shared-migration-receipts.mjs';
import { SHARED_INTEGRATION_PATHS, validateSharedIntegrationAudit } from '../../scripts/subtitle-studio-provenance/shared-resource-integration.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const readJson = (root: string, name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function fixture(kind: 'engine' | 'receipts' = 'engine') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusionkit-shared-provenance-')); roots.push(root);
  const manifestPath = kind === 'engine' ? SHARED_EXTRACTION_PATH : SHARED_MIGRATION_RECEIPTS_PATH;
  const manifest = readJson(repositoryRoot, manifestPath);
  const inputs = kind === 'engine' ? manifest.sources.map((record: { path: string }) => record.path)
    : manifest.entries.map((record: { sourcePath: string }) => record.sourcePath);
  const outputs = kind === 'engine' ? manifest.outputs.map((record: { path: string }) => record.path)
    : manifest.entries.map((record: { destinationPath: string }) => record.destinationPath);
  const sourceBytes = new Map<string, Buffer>();
  for (const name of [...inputs, ...outputs, manifestPath]) {
    const destination = path.join(root, name); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, name), destination);
  }
  for (const name of inputs) sourceBytes.set(name, Buffer.from(fs.readFileSync(path.join(repositoryRoot, name), 'utf8').replaceAll('\r\n', '\n')));
  const readSourceBlob = (record: { path?: string; sourcePath?: string }) => sourceBytes.get(record.path ?? record.sourcePath!);
  return { root, manifest, writeManifest: () => fs.writeFileSync(path.join(root, manifestPath), JSON.stringify(manifest)),
    check: () => kind === 'engine' ? checkSharedResourceExtraction({ root, readSourceBlob }) : checkSharedMigrationReceipts({ root, readSourceBlob }) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(fs.realpathSync(root)) !== parent || !path.basename(root).startsWith('fusionkit-shared-provenance-')) throw new Error('Unexpected test cleanup root');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('neutral shared resource extraction provenance', () => {
  it('replays the reviewed transforms from the actual pinned Git commit and checks six exact historical snapshots', () => {
    expect(checkSharedResourceExtraction({ root: repositoryRoot })).toMatchObject({ sources: 29, outputs: 31, exact: true });
    expect(checkSharedMigrationReceipts({ root: repositoryRoot })).toMatchObject({ receipts: 6, exact: true });
  }, 30_000);

  it('reconstructs every output in an isolated fixture using the captured authoritative source bytes', () => {
    expect(fixture().check()).toMatchObject({ outputs: 31, exact: true });
  });

  it.each(['output', 'source', 'source-pin', 'extra-file', 'unsafe-output', 'duplicate-output', 'edit-digest'] as const)('rejects %s drift', mutation => {
    const f = fixture();
    if (mutation === 'output') fs.appendFileSync(path.join(f.root, f.manifest.outputs[0].path), '\n// drift');
    if (mutation === 'source') fs.appendFileSync(path.join(f.root, f.manifest.sources[0].path), '\n// drift');
    if (mutation === 'source-pin') f.manifest.sources[0].sha256 = '0'.repeat(64);
    if (mutation === 'extra-file') fs.writeFileSync(path.join(f.root, 'electron/main/speech-resources/engine/extra.ts'), 'export {};');
    if (mutation === 'unsafe-output') f.manifest.outputs[0].path = '../escape.ts';
    if (mutation === 'duplicate-output') f.manifest.outputs.push(f.manifest.outputs[0]);
    if (mutation === 'edit-digest') f.manifest.outputs.find((entry: { edits: unknown[] }) => entry.edits.length).edits[0].removedSha256 = '0'.repeat(64);
    f.writeManifest();
    expect(f.check).toThrow();
  });

  it('rejects a linked output without following or altering its target', () => {
    const f = fixture(), name = path.join(f.root, f.manifest.outputs[0].path), target = path.join(f.root, 'unchanged');
    fs.writeFileSync(target, 'keep'); fs.unlinkSync(name); fs.symlinkSync(target, name);
    expect(f.check).toThrow(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
  });

  it('requires ordered, non-overlapping byte edits with exact removed-byte digests', () => {
    const source = Buffer.from('a中b\n');
    const edit = { startByte: 1, endByte: 4, removedSha256: sha(Buffer.from('中')), insertedText: 'X' };
    expect(applySharedExtractionEdits(source, [edit]).toString()).toBe('aXb\n');
    expect(() => applySharedExtractionEdits(source, [edit, edit])).toThrow();
    expect(() => applySharedExtractionEdits(source, [{ ...edit, endByte: source.length + 1 }])).toThrow();
    expect(() => applySharedExtractionEdits(source, [{ ...edit, startByte: -1 }])).toThrow();
    expect(() => applySharedExtractionEdits(source, [{ ...edit, removedSha256: '0'.repeat(64) }])).toThrow();
  });

  it.each(['snapshot', 'source', 'record-path', 'extra-receipt', 'extra-owner'] as const)('rejects neutral receipt %s changes', mutation => {
    const f = fixture('receipts');
    expect(f.check()).toMatchObject({ receipts: 6, exact: true });
    if (mutation === 'snapshot') fs.appendFileSync(path.join(f.root, f.manifest.entries[0].destinationPath), '\n');
    if (mutation === 'source') fs.appendFileSync(path.join(f.root, f.manifest.entries[0].sourcePath), '\n');
    if (mutation === 'record-path') f.manifest.entries[0].destinationPath = '../escape.json';
    if (mutation === 'extra-receipt') fs.writeFileSync(path.join(f.root, 'resources/speech-resources/migration/legacy/unregistered.json'), '{}');
    if (mutation === 'extra-owner') fs.mkdirSync(path.join(f.root, 'resources/speech-resources/migration/unknown'));
    f.writeManifest(); expect(f.check).toThrow();
  });

  it('cannot approve arbitrary old ASR or resource engine changes through current integration metadata', () => {
    const document = { schemaVersion: 1, sourceCommit: '99d064719d7ec93dea02944a9bfde31c4afec221',
      purpose: 'Current shared-resource composition only; frozen source manifests, copied files and replay remain unchanged.',
      entries: Object.entries(SHARED_INTEGRATION_PATHS).map(([sourcePath, role]) => ({ sourcePath, role,
        sourceBlobOid: role === 'legacy-adapter' || role === 'studio-adapter' ? null : 'a'.repeat(40),
        sourceSha256: role === 'legacy-adapter' || role === 'studio-adapter' ? null : 'a'.repeat(64), currentBlobOid: 'b'.repeat(40), reason: 'reviewed' })) };
    expect(validateSharedIntegrationAudit(document).size).toBe(Object.keys(SHARED_INTEGRATION_PATHS).length);
    for (const sourcePath of ['electron/main/local-subtitle/transcript-executor.ts', 'electron/main/local-subtitle/model-manager.ts', '../escape.ts']) {
      const changed = structuredClone(document); changed.entries[0].sourcePath = sourcePath;
      expect(() => validateSharedIntegrationAudit(changed)).toThrow();
    }
    const duplicate = structuredClone(document); duplicate.entries[1] = duplicate.entries[0];
    expect(() => validateSharedIntegrationAudit(duplicate)).toThrow();
  });

  it('builds neutral and Studio closures while historical tool source and resource directories are unavailable', async () => {
    const unavailable = /^(?:electron\/main\/local-subtitle\/|resources\/local-subtitle\/|src\/services\/local-subtitle\/|src\/type\/localSubtitle)/;
    const result = await build({ absWorkingDir: repositoryRoot,
      entryPoints: ['electron/main/speech-resources/service.ts', 'electron/main/subtitle-studio/index.ts'],
      outdir: 'unused-memory-output', write: false, bundle: true, platform: 'node', format: 'esm', external: ['electron'],
      metafile: true, logLevel: 'silent', plugins: [{ name: 'historical-tool-unavailable', setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|tsx|js|mjs|cjs|json)$/ }, args => {
          const name = path.relative(repositoryRoot, args.path).replaceAll('\\', '/');
          if (unavailable.test(name)) return { errors: [{ text: `Historical tool file unavailable: ${name}` }] };
          return null;
        });
      } }],
    });
    expect(result.outputFiles.length).toBe(2);
    expect(Object.keys(result.metafile!.inputs).filter(name => unavailable.test(name))).toEqual([]);
    expect(Object.keys(result.metafile!.inputs).filter(name => name.startsWith('resources/speech-resources/migration/'))).toHaveLength(6);
  });
});
