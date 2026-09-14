import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RESOURCE_CONTRIBUTIONS } from './subtitle-studio-contract.mjs';
import { collectPackagedResourceIntegrity, createIntegritySnapshot, createSigningOptions, signPackagedApplication } from './sign-subtitle-studio.mjs';

const appPath = path.join(path.parse(process.cwd()).root, 'test-app', 'FusionKit.app');
const target = { platform: 'darwin', arch: 'arm64' };
const hash = 'a'.repeat(64);
const developerSignature = 'Authority=Developer ID Application: Example (TEAM)\nCodeDirectory v=20500 size=460 flags=0x10000(runtime) hashes=9+7\nTimestamp=Sep 14, 2026 at 12:00:00\n';
function runtime(signatureKind = 'adhoc') {
  return { ready: true, manifestSha256: hash, artifactSummary: [{ id: 'server', sha256: hash, signatureKind }] };
}
function overwrite(signatureKind = 'adhoc') {
  return { ready: true, generation: hash, artifact: { sha256: hash, signatureKind }, buildReceiptSha256: hash, moduleExportsVerified: true };
}
function snapshots(signatureKind = 'adhoc') {
  return ['legacy', 'studio'].map(id => ({ id, ...createIntegritySnapshot(runtime(signatureKind), overwrite(signatureKind)) }));
}
function dependencies(overrides = {}) {
  const calls = [];
  return { calls, host: target, collectIntegrity: async () => { calls.push('collect'); return snapshots(); },
    sign: async options => { calls.push({ sign: options }); },
    runCommand: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === '-dvvv') return { stdout: '', stderr: 'Signature=adhoc\n' };
      if (file === '/usr/sbin/spctl') throw Object.assign(new Error('private app path'), { code: 3, stderr: 'rejected (the code is valid but does not seem to be an app)' });
      return { stdout: '', stderr: '' };
    }, ...overrides };
}

test('protects both exact resource subtrees while retaining outer-app signing', () => {
  const options = createSigningOptions(appPath, '-', '1.0.5');
  assert.equal(options.strictVerify, false);
  assert.equal(options.identityValidation, false);
  assert.deepEqual(options.optionsForFile(appPath), { hardenedRuntime: false });
  assert.deepEqual(options.optionsForFile(path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')), { hardenedRuntime: false });
  for (const item of Object.values(RESOURCE_CONTRIBUTIONS)) {
    const root = path.join(appPath, 'Contents', 'Resources', item.to);
    assert.equal(options.ignore(root), true);
    assert.equal(options.ignore(path.join(root, 'native', 'addon.node')), true);
    assert.equal(options.ignore(`${root}-other/addon.node`), false);
  }
  assert.equal(options.ignore(appPath), false);
  assert.equal(options.ignore(path.join(appPath, 'Contents', 'Resources', 'app.asar')), false);
  assert.equal(options.ignore(path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')), false);
  assert.equal(Object.hasOwn(createSigningOptions(appPath, '-', '1.0.6'), 'strictVerify'), false);
  assert.equal(createSigningOptions(appPath, 'Developer ID Application: Example').identityValidation, true);
  assert.deepEqual(createSigningOptions(appPath, 'Developer ID Application: Example').optionsForFile(appPath), { hardenedRuntime: true });
});

test('collects both packaged runtimes and native addons through their real resource mappings', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-signing-')));
  try {
    for (const item of Object.values(RESOURCE_CONTRIBUTIONS)) fs.mkdirSync(path.join(root, 'Contents', 'Resources', item.to), { recursive: true });
    const calls = [];
    const result = await collectPackagedResourceIntegrity(root, { loadVerifiers: async id => ({
      verifyRuntimeBundle: async options => { calls.push({ id, type: 'runtime', options }); return runtime(); },
      verifyStagedOverwriteNativeAddon: async options => { calls.push({ id, type: 'addon', options }); return overwrite(); },
    }) });
    assert.deepEqual(result, snapshots());
    assert.deepEqual(calls, Object.entries(RESOURCE_CONTRIBUTIONS).flatMap(([id, item]) => {
      const runtimeRoot = path.join(root, 'Contents', 'Resources', item.to);
      return [
        { id, type: 'runtime', options: { runtimeRoot, ...target, scope: 'all', launch: true } },
        { id, type: 'addon', options: { root: runtimeRoot, ...target } },
      ];
    }));
    fs.rmSync(path.join(root, 'Contents', 'Resources', 'subtitle-studio'), { recursive: true });
    await assert.rejects(collectPackagedResourceIntegrity(root, { loadVerifiers: async () => ({ verifyRuntimeBundle: async () => runtime(), verifyStagedOverwriteNativeAddon: async () => overwrite() }) }), /unavailable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects missing integrity and addon-module evidence', () => {
  assert.throws(() => createIntegritySnapshot({ ...runtime(), manifestSha256: undefined }, overwrite()), /incomplete/);
  assert.throws(() => createIntegritySnapshot({ ...runtime(), artifactSummary: [] }, overwrite()), /incomplete/);
  assert.throws(() => createIntegritySnapshot(runtime(), { ...overwrite(), moduleExportsVerified: false }), /incomplete/);
  assert.throws(() => createIntegritySnapshot(runtime('other'), overwrite()), /incomplete/);
  assert.throws(() => createIntegritySnapshot(runtime(), overwrite('unsigned')), /incomplete/);
});

test('ad-hoc signing checks both resource snapshots and independently runs deep strict verification', async () => {
  const deps = dependencies();
  const report = await signPackagedApplication({ appPath, identity: '-' }, deps);
  assert.equal(deps.calls[0], 'collect');
  assert.ok(deps.calls[1].sign);
  assert.equal(deps.calls[2], 'collect');
  assert.deepEqual(deps.calls[3], { file: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', '--verbose=4', appPath] });
  assert.equal(report.resourceIntegrityUnchangedByOuterSigning, true);
  assert.equal(report.appSignatureKind, 'adhoc');
  assert.equal(report.nestedDeveloperIdSigned, false);
  assert.deepEqual(report.gatekeeper, { status: 'rejected', exitCode: 3 });
  assert.equal(report.notarizationPerformed, false);
  assert.equal(report.releaseReadinessAssessed, false);
  assert.equal(JSON.stringify(report).includes(appPath), false);
});

test('rejects changed Studio runtime or native-addon bytes after outer signing', async () => {
  for (const kind of ['runtime', 'addon']) {
    let collections = 0;
    const deps = dependencies({ collectIntegrity: async () => {
      const result = snapshots();
      if (collections++ > 0) {
        if (kind === 'runtime') result[1].artifactHashes[0].sha256 = 'b'.repeat(64);
        else result[1].overwriteNative.artifactSha256 = 'b'.repeat(64);
      }
      return result;
    } });
    await assert.rejects(signPackagedApplication({ appPath }, deps), /changed a frozen/);
    assert.equal(deps.calls.some(call => call.file), false);
  }
});

test('never treats a failed system strict check as a successful signing report', async () => {
  const deps = dependencies({ runCommand: async () => { throw new Error('strict verification rejected the app'); } });
  await assert.rejects(signPackagedApplication({ appPath }, deps), error => error.code === 'packaged_deep_strict_verification_failed' && error.cause.message === 'strict verification rejected the app');
});

test('requires final Developer ID nested signatures before signing with a public identity', async () => {
  const deps = dependencies();
  await assert.rejects(signPackagedApplication({ appPath, identity: 'Developer ID Application: Example' }, deps), /both resource roots/);
  assert.deepEqual(deps.calls, ['collect']);
});

test('Developer ID signature evidence remains separate from notarization and overall release acceptance', async () => {
  const deps = dependencies({ collectIntegrity: async () => snapshots('developer_id'),
    runCommand: async (file, args) => args[0] === '-dvvv' ? { stdout: '', stderr: developerSignature } : { stdout: 'accepted', stderr: '' } });
  const report = await signPackagedApplication({ appPath, identity: 'Developer ID Application: Example' }, deps);
  assert.equal(report.appSignatureKind, 'developer_id');
  assert.equal(report.nestedDeveloperIdSigned, true);
  assert.equal(report.appHardenedRuntimeEnabled, true);
  assert.equal(report.appSecureTimestampPresent, true);
  assert.equal(report.gatekeeper.status, 'accepted');
  assert.equal(report.notarizationPerformed, false);
  assert.equal(report.releaseReadinessAssessed, false);
  assert.equal(JSON.stringify(report).includes('Example'), false);
});

test('verification-only never signs or invents a before/after-signing claim', async () => {
  const deps = dependencies();
  const report = await signPackagedApplication({ appPath, verifyOnly: true }, deps);
  assert.equal(deps.calls.some(call => call.sign), false);
  assert.equal(deps.calls.filter(call => call === 'collect').length, 1);
  assert.equal(report.signingPerformed, false);
  assert.equal(report.resourceIntegrityUnchangedByOuterSigning, null);
});

test('verification-only rejects unknown signatures and honors an explicitly requested signing mode', async () => {
  for (const [signature, identity, expected] of [
    ['Authority=Apple Development: Example\n', undefined, /unsupported signature/],
    [developerSignature, '-', /requested signing mode/],
    ['Signature=adhoc\n', 'Developer ID Application: Example', /requested signing mode/],
  ]) {
    const deps = dependencies({ collectIntegrity: async () => snapshots('developer_id'), runCommand: async () => ({ stdout: '', stderr: signature }) });
    await assert.rejects(signPackagedApplication({ appPath, identity, verifyOnly: true }, deps), expected);
    assert.equal(deps.calls.some(call => call.sign), false);
  }
  const report = await signPackagedApplication({ appPath, verifyOnly: true }, dependencies({ collectIntegrity: async () => snapshots('developer_id'), runCommand: async () => ({ stdout: '', stderr: developerSignature }) }));
  assert.equal(report.appSignatureKind, 'developer_id');
});

test('Developer ID verification rejects missing nested signatures, hardened runtime or secure timestamp', async () => {
  const finalSnapshots = snapshots('developer_id');
  for (const [signature, resources] of [
    [developerSignature, snapshots()],
    [developerSignature, []],
    [developerSignature, [finalSnapshots[0], finalSnapshots[0]]],
    [developerSignature.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), finalSnapshots],
    [developerSignature.replace(/Timestamp=.+\n/u, ''), finalSnapshots],
    [developerSignature.replace(/Timestamp=.+\n/u, 'Timestamp=none\n'), finalSnapshots],
  ]) {
    const deps = dependencies({ collectIntegrity: async () => resources, runCommand: async () => ({ stdout: '', stderr: signature }) });
    await assert.rejects(signPackagedApplication({ appPath, verifyOnly: true }, deps), /final nested resource signatures, hardened runtime and a secure timestamp/);
  }
});

test('rejects an ad-hoc candidate with hardened library validation even when deep strict verification passes', async () => {
  const deps = dependencies({ runCommand: async () => ({ stdout: '', stderr: 'Signature=adhoc\nCodeDirectory v=20500 size=460 flags=0x10002(adhoc,runtime) hashes=9+7\n' }) });
  await assert.rejects(signPackagedApplication({ appPath, verifyOnly: true }, deps), /ad-hoc candidate must disable hardened runtime/);
});

test('phase failures carry safe diagnostics while retaining the private cause outside reports', async () => {
  for (const [overrides, code] of [
    [{ collectIntegrity: async () => { throw new Error('private staging path'); } }, 'packaged_resource_preflight_failed'],
    [{ sign: async () => { throw new Error('private certificate and keychain path'); } }, 'packaged_outer_signing_failed'],
  ]) {
    await assert.rejects(signPackagedApplication({ appPath }, dependencies(overrides)), error => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes('private'), false);
      assert.equal(error.cause.message.includes('private'), true);
      return true;
    });
  }
});

test('rejects unsupported hosts and incomplete inputs before inspecting or signing', async () => {
  const deps = dependencies({ host: { platform: 'win32', arch: 'x64' } });
  await assert.rejects(signPackagedApplication({ appPath }, deps), /native darwin\/arm64/);
  assert.deepEqual(deps.calls, []);
  await assert.rejects(signPackagedApplication({ appPath: '' }, dependencies()), /appPath is required/);
});
