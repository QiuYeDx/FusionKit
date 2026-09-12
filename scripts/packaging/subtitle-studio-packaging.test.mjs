import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { assertPackagingConfig, resolvePackagingTarget, verifyPackagingContributions, loadContributionVerifiers, RESOURCE_CONTRIBUTIONS } from './subtitle-studio-contract.mjs';
import { createBeforePackHook } from './subtitle-studio-before-pack.cjs';
import { getLocalSubtitleStagingTarget } from '../subtitle-studio/transcription/runtime/staging-contract.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const readConfig = () => JSON.parse(fs.readFileSync(path.join(projectRoot, 'electron-builder.subtitle-studio.json'), 'utf8'));
const require = createRequire(import.meta.url);
const { getConfig, validateConfig } = require('app-builder-lib/out/util/config.js');
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-packaging-')));
  for (const contribution of Object.values(RESOURCE_CONTRIBUTIONS)) fs.mkdirSync(path.join(root, contribution.from), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function context(root, config = readConfig(), platform = 'darwin', arch = 3) {
  return { electronPlatformName: platform, arch, packager: { config, platform: { nodeName: platform }, info: { projectDir: root } } };
}

test('validates the real electron-builder resolved configuration without modifying the old entry', async () => {
  const config = await getConfig(projectRoot, path.join(projectRoot, 'electron-builder.subtitle-studio.json'));
  await validateConfig(config);
  assert.equal(assertPackagingConfig(config), true);
  const old = JSON.parse(fs.readFileSync(path.join(projectRoot, 'electron-builder.json'), 'utf8'));
  const expected = structuredClone(old);
  expected.beforePack = 'scripts/packaging/subtitle-studio-before-pack.cjs';
  expected.extraResources.push({ from: RESOURCE_CONTRIBUTIONS.studio.from, to: RESOURCE_CONTRIBUTIONS.studio.to, filter: ['**/*'] });
  expected.mac.signIgnore.push('Contents/Resources/subtitle-studio/transcription/');
  assert.deepEqual(readConfig(), expected);
  assert.equal(old.extraResources.length, 1);
});

test('checks the complete config before loading any verifier', async () => {
  const mutations = [
    value => { value.beforePack = 'other.cjs'; },
    value => { value.extraResources.pop(); },
    value => { value.extraResources[1].from = value.extraResources[0].from; },
    value => { value.extraResources[1].to = 'subtitle-studio'; },
    value => { value.extraResources[1].filter = ['**/*.node']; },
    value => { value.extraResources[1].optional = true; },
    value => { value.extraResources.push(structuredClone(value.extraResources[1])); },
    value => { value.mac.signIgnore.pop(); },
    value => { value.mac.signIgnore[1] = 'Contents/Resources/'; },
    value => { value.mac.target[0].arch = ['x64']; },
    value => { value.win.target[0].target = 'zip'; },
    value => { value.mac.artifactName = '${productName}.${ext}'; },
    value => { value.mac.extraResources = []; },
    value => { value.afterSign = 'unreviewed.cjs'; },
  ];
  let loads = 0;
  const hook = createBeforePackHook({ host: { platform: 'darwin', arch: 'arm64' }, loadVerifiers: () => { loads++; throw new Error('must not load'); } });
  for (const mutate of mutations) {
    const config = readConfig(); mutate(config);
    await assert.rejects(hook(context(projectRoot, config)), error => error.code === 'runtime_staging_invalid');
  }
  assert.equal(loads, 0);
});

test('enforces exact native host, builder and packager targets', () => {
  assert.deepEqual(resolvePackagingTarget(context(projectRoot), { platform: 'darwin', arch: 'arm64' }), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(resolvePackagingTarget(context(projectRoot, readConfig(), 'win32', 1), { platform: 'win32', arch: 'x64' }), { platform: 'win32', arch: 'x64' });
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) assert.throws(() => resolvePackagingTarget(context(projectRoot), { platform, arch }), /targets must match/);
  const mismatch = context(projectRoot); mismatch.packager.platform.nodeName = 'win32';
  assert.throws(() => resolvePackagingTarget(mismatch, { platform: 'darwin', arch: 'arm64' }), /targets must match/);
});

test('dispatches both full verifiers with canonical roots and rejects partial readiness', async () => {
  const f = fixture();
  try {
    const calls = [];
    const hook = createBeforePackHook({ host: { platform: 'darwin', arch: 'arm64' }, loadVerifiers: async id => ({
      verifyRuntimeBundle: async options => { calls.push({ id, kind: 'runtime', options }); return { ready: true }; },
      verifyStagedOverwriteNativeAddon: async options => { calls.push({ id, kind: 'overwrite', options }); return { ready: true, moduleExportsVerified: true }; },
    }) });
    const report = await hook(context(f.root));
    assert.equal(report.ready, true);
    assert.equal(report.officialRuntimeLaunchPerformed, false);
    assert.equal(report.overwriteAddonModuleProbePerformed, true);
    assert.deepEqual(calls, Object.entries(RESOURCE_CONTRIBUTIONS).flatMap(([id, item]) => [
      { id, kind: 'runtime', options: { runtimeRoot: path.join(f.root, item.from), platform: 'darwin', arch: 'arm64', scope: 'all', launch: false } },
      { id, kind: 'overwrite', options: { root: path.join(f.root, item.from), platform: 'darwin', arch: 'arm64' } },
    ]));
    for (const kind of ['runtime', 'overwrite']) await assert.rejects(verifyPackagingContributions({ projectRoot: f.root, target: { platform: 'darwin', arch: 'arm64' } }, { loadVerifiers: async () => ({
      verifyRuntimeBundle: async () => ({ ready: kind !== 'runtime' }),
      verifyStagedOverwriteNativeAddon: async () => ({ ready: true, moduleExportsVerified: kind !== 'overwrite' }),
    }) }), /failed verification/);
  } finally { f.cleanup(); }
});

test('rejects absent and linked canonical roots before loading verifier code', async () => {
  const f = fixture();
  try {
    const source = path.join(f.root, RESOURCE_CONTRIBUTIONS.studio.from);
    fs.rmSync(source, { recursive: true });
    let loaded = false;
    const options = { projectRoot: f.root, target: { platform: 'darwin', arch: 'arm64' }, contributionIds: ['studio'] };
    const dependencies = { loadVerifiers: () => { loaded = true; throw new Error('not reached'); } };
    await assert.rejects(verifyPackagingContributions(options, dependencies), error => error.contribution === 'studio');
    fs.symlinkSync(path.join(f.root, RESOURCE_CONTRIBUTIONS.legacy.from), source, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifyPackagingContributions(options, dependencies), error => error.contribution === 'studio');
    assert.equal(loaded, false);
  } finally { f.cleanup(); }
});

test('uses both real runtime validators to reject missing, changed, wrong-architecture and missing-license bytes', async () => {
  for (const id of ['legacy', 'studio']) for (const fault of ['missing-manifest', 'changed-artifact', 'wrong-arch', 'missing-license']) {
    const f = fixture();
    try {
      const synthetic = createWindowsRuntime(f.root, id);
      if (fault === 'missing-manifest') fs.unlinkSync(synthetic.manifestPath);
      if (fault === 'changed-artifact') fs.appendFileSync(synthetic.artifactPath, 'changed');
      if (fault === 'wrong-arch') {
        const bytes = fs.readFileSync(synthetic.artifactPath); bytes.writeUInt16LE(0xaa64, 68); fs.writeFileSync(synthetic.artifactPath, bytes);
        // Keep the content hash valid so this reaches the architecture check.
        const manifest = JSON.parse(fs.readFileSync(synthetic.manifestPath, 'utf8'));
        manifest.artifacts[0].sha256 = sha(bytes); fs.writeFileSync(synthetic.manifestPath, JSON.stringify(manifest));
      }
      if (fault === 'missing-license') fs.unlinkSync(synthetic.licensePath);
      let addonCalls = 0;
      await assert.rejects(verifyPackagingContributions({ projectRoot: f.root, target: { platform: 'win32', arch: 'x64' }, contributionIds: [id] }, {
        loadVerifiers: async selected => {
          const real = await loadContributionVerifiers(selected);
          return { verifyRuntimeBundle: real.verifyRuntimeBundle, verifyStagedOverwriteNativeAddon: async () => { addonCalls++; return { ready: true, moduleExportsVerified: true }; } };
        },
      }), error => error.contribution === id && /^(media_|runtime_)/.test(error.code));
      assert.equal(addonCalls, 0);
    } finally { f.cleanup(); }
  }
});

test('verifies both valid synthetic Windows runtimes before addon dispatch', async () => {
  const f = fixture();
  try {
    for (const id of ['legacy', 'studio']) createWindowsRuntime(f.root, id);
    const calls = [];
    const report = await verifyPackagingContributions({ projectRoot: f.root, target: { platform: 'win32', arch: 'x64' } }, { loadVerifiers: async id => {
      const real = await loadContributionVerifiers(id);
      return { verifyRuntimeBundle: real.verifyRuntimeBundle, verifyStagedOverwriteNativeAddon: async () => { calls.push(id); return { ready: true, moduleExportsVerified: true }; } };
    } });
    assert.deepEqual(calls, ['legacy', 'studio']);
    assert.equal(report.contributions.every(item => item.runtime.ready && item.runtime.noPathFallback), true);
  } finally { f.cleanup(); }
});

test('loads and validates the Studio contribution in a source tree containing no legacy scripts or resources', async () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.root, 'build/local-subtitle-resources'), { recursive: true });
    const files = ['scripts/packaging/subtitle-studio-contract.mjs',
      ...['runtime-manifest.mjs', 'staging-contract.mjs'].map(name => `scripts/subtitle-studio/transcription/runtime/${name}`),
      ...['overwrite-native-staging.mjs', 'overwrite-staging.mjs', 'overwrite-staging-contract.mjs'].map(name => `scripts/subtitle-studio/transcription/overwrite-native/${name}`)];
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true }); fs.copyFileSync(path.join(projectRoot, file), path.join(f.root, file)); }
    fs.cpSync(path.join(projectRoot, 'resources/subtitle-studio/transcription'), path.join(f.root, 'resources/subtitle-studio/transcription'), { recursive: true });
    const entry = pathToFileURL(path.join(f.root, files[0])).href;
    const script = `import assert from 'node:assert/strict'; const api = await import(${JSON.stringify(entry)}); const loaded = await api.loadContributionVerifiers('studio'); assert.equal(typeof loaded.verifyStagedOverwriteNativeAddon, 'function'); await assert.rejects(api.verifyPackagingContributions({projectRoot:${JSON.stringify(f.root)}, target:{platform:'win32',arch:'x64'}, contributionIds:['studio']}), error => error.contribution === 'studio' && error.code === 'media_runtime_missing'); console.log('independent Studio verifier loaded');`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8', timeout: 15_000 });
    assert.match(output, /independent Studio verifier loaded/);
    assert.equal(fs.existsSync(path.join(f.root, 'scripts/local-subtitle')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'resources/local-subtitle')), false);
  } finally { f.cleanup(); }
});

function createWindowsRuntime(root, id) {
  const item = RESOURCE_CONTRIBUTIONS[id], target = getLocalSubtitleStagingTarget('win32', 'x64');
  const runtimeRoot = path.join(root, item.from);
  const bytes = Buffer.alloc(128); bytes.write('MZ', 0, 'ascii'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64, 'binary'); bytes.writeUInt16LE(0x8664, 68);
  const manifest = { schemaVersion: 1, runtimeContractVersion: 1, manifestId: `packaging-${id}-fixture`, target: { platform: 'win32', arch: 'x64' },
    integrityProfile: target.integrityProfile, integrity: structuredClone(target.integrity),
    artifacts: target.requiredArtifacts.map(required => ({ ...structuredClone(required), platform: 'win32', arch: 'x64', byteSize: bytes.length, sha256: sha(bytes),
      version: ['ffmpeg', 'ffprobe'].includes(required.kind) ? target.artifactVersions.media : target.artifactVersions.runner, signatureKind: 'unsigned' })),
    licenses: structuredClone(target.requiredLicenses), sources: structuredClone(target.requiredSources),
  };
  for (const artifact of manifest.artifacts) { const file = path.join(runtimeRoot, artifact.relativePath); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  for (const record of [...manifest.licenses.flatMap(item => [...item.licenseFiles, ...item.noticeFiles]), ...manifest.sources.map(item => item.evidenceFile)]) {
    const file = path.join(runtimeRoot, record.relativePath); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(projectRoot, 'resources/subtitle-studio/transcription', record.relativePath), file);
  }
  const manifestPath = path.join(runtimeRoot, 'manifests', `${id === 'studio' ? 'subtitle-studio' : 'local-subtitle'}-runtime.v1.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true }); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, artifactPath: path.join(runtimeRoot, manifest.artifacts[0].relativePath), licensePath: path.join(runtimeRoot, manifest.licenses[0].licenseFiles[0].relativePath) };
}
