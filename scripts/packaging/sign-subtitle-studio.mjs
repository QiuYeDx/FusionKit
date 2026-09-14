#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadContributionVerifiers, RESOURCE_CONTRIBUTIONS, verifyContributionRoot } from './subtitle-studio-contract.mjs';

const require = createRequire(import.meta.url);
const { signAsync } = require('@electron/osx-sign');
const signerVersion = require('@electron/osx-sign/package.json').version;
const execFileAsync = promisify(execFile);
const target = Object.freeze({ platform: 'darwin', arch: 'arm64' });
const hashPattern = /^[a-f0-9]{64}$/u;
const signatureKinds = new Set(['adhoc', 'developer_id']);

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resourceRoot(appPath, contribution) {
  return path.join(appPath, 'Contents', 'Resources', contribution.to);
}

export function createIntegritySnapshot(runtime, overwrite) {
  if (runtime?.ready !== true || overwrite?.ready !== true || overwrite.moduleExportsVerified !== true ||
      !hashPattern.test(runtime.manifestSha256) || !Array.isArray(runtime.artifactSummary) || runtime.artifactSummary.length === 0 ||
      runtime.artifactSummary.some(item => typeof item.id !== 'string' || !hashPattern.test(item.sha256) || !signatureKinds.has(item.signatureKind)) ||
      !hashPattern.test(overwrite.generation) || !hashPattern.test(overwrite.artifact?.sha256) || !signatureKinds.has(overwrite.artifact?.signatureKind) || !hashPattern.test(overwrite.buildReceiptSha256)) {
    throw new Error('The packaged resource integrity snapshot is incomplete.');
  }
  return {
    manifestSha256: runtime.manifestSha256,
    artifactHashes: runtime.artifactSummary.map(({ id, sha256, signatureKind }) => ({ id, sha256, signatureKind })),
    overwriteNative: {
      generation: overwrite.generation,
      artifactSha256: overwrite.artifact.sha256,
      signatureKind: overwrite.artifact.signatureKind,
      buildReceiptSha256: overwrite.buildReceiptSha256,
      moduleExportsVerified: true,
    },
  };
}

export async function collectPackagedResourceIntegrity(appPath, { loadVerifiers = loadContributionVerifiers } = {}) {
  const contributions = [];
  for (const [id, contribution] of Object.entries(RESOURCE_CONTRIBUTIONS)) {
    const root = await verifyContributionRoot(appPath, { from: `Contents/Resources/${contribution.to}` });
    const verifier = await loadVerifiers(id);
    const runtime = await verifier.verifyRuntimeBundle({ runtimeRoot: root, ...target, scope: 'all', launch: true });
    const overwrite = await verifier.verifyStagedOverwriteNativeAddon({ root, ...target });
    contributions.push({ id, ...createIntegritySnapshot(runtime, overwrite) });
  }
  return contributions;
}

export function createSigningOptions(appPath, identity, version = signerVersion) {
  return {
    app: appPath,
    identity,
    identityValidation: identity !== '-',
    // Ad-hoc binaries have no Team ID, so hardened library validation cannot
    // admit their Electron framework. osx-sign 1.x reads this per file only.
    optionsForFile: () => ({ hardenedRuntime: identity !== '-' }),
    // Only osx-sign 1.0.5 needs this workaround; system deep/strict verification always runs below.
    ...(version === '1.0.5' ? { strictVerify: false } : {}),
    ignore: candidate => Object.values(RESOURCE_CONTRIBUTIONS).some(item => isPathInside(resourceRoot(appPath, item), candidate)),
  };
}

function nestedDeveloperIdSigned(contributions) {
  return contributions.length === Object.keys(RESOURCE_CONTRIBUTIONS).length &&
    Object.keys(RESOURCE_CONTRIBUTIONS).every(id => contributions.filter(item => item.id === id).length === 1) &&
    contributions.every(item => item.artifactHashes.length > 0 && item.artifactHashes.every(artifact => artifact.signatureKind === 'developer_id') && item.overwriteNative.signatureKind === 'developer_id');
}

async function signingPhase(code, operation) {
  try { return await operation(); }
  catch (cause) { throw Object.assign(new Error(code.replaceAll('_', ' '), { cause }), { code }); }
}

async function systemCommand(file, args) {
  return execFileAsync(file, args, {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function assessGatekeeper(appPath, runCommand) {
  try {
    const result = await runCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    return { status: /\baccepted\b/iu.test(`${result.stdout}${result.stderr}`) ? 'accepted' : 'unavailable', exitCode: 0 };
  } catch (error) {
    return { status: /\brejected\b/iu.test(`${error?.stdout ?? ''}${error?.stderr ?? ''}`) ? 'rejected' : 'unavailable', exitCode: Number.isInteger(error?.code) ? error.code : null };
  }
}

export async function signPackagedApplication(options, dependencies = {}) {
  const host = dependencies.host ?? process;
  if (host.platform !== target.platform || host.arch !== target.arch) throw new Error('Packaged signing requires a native darwin/arm64 host.');
  if (typeof options.appPath !== 'string' || options.appPath.trim() === '') throw new Error('appPath is required.');
  const appPath = path.resolve(options.appPath);
  const identity = options.identity ?? '-';
  if (typeof identity !== 'string' || identity.trim() === '') throw new Error('A signing identity or explicit ad-hoc dash is required.');
  const collect = dependencies.collectIntegrity ?? collectPackagedResourceIntegrity;
  const sign = dependencies.sign ?? signAsync;
  const runCommand = dependencies.runCommand ?? systemCommand;
  const before = await signingPhase('packaged_resource_preflight_failed', () => collect(appPath));
  if (!options.verifyOnly) {
    if (identity !== '-' && !nestedDeveloperIdSigned(before)) throw new Error('Developer ID signing requires both resource roots to be staged with their final Developer ID signatures before freezing manifests.');
    await signingPhase('packaged_outer_signing_failed', () => sign(createSigningOptions(appPath, identity, dependencies.signerVersion ?? signerVersion)));
  }
  const after = options.verifyOnly ? before : await signingPhase('packaged_resource_postflight_failed', () => collect(appPath));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Outer signing changed a frozen packaged resource or native addon.');
  await signingPhase('packaged_deep_strict_verification_failed', () => runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]));
  const signature = await signingPhase('packaged_signature_inspection_failed', () => runCommand('/usr/bin/codesign', ['-dvvv', appPath]));
  const signatureOutput = `${signature.stdout}${signature.stderr}`;
  const appSignatureKind = /^Signature=adhoc$/mu.test(signatureOutput) ? 'adhoc' : /^Authority=Developer ID Application:/mu.test(signatureOutput) ? 'developer_id' : 'other';
  if (!signatureKinds.has(appSignatureKind)) throw new Error('The final application has an unsupported signature kind.');
  // An omitted identity in verification mode inspects either supported kind; an explicit identity constrains it.
  if ((!options.verifyOnly || options.identity !== undefined) && appSignatureKind !== (identity === '-' ? 'adhoc' : 'developer_id')) throw new Error('The final application signature does not match the requested signing mode.');
  const signatureFlags = /\bflags=(0x[\da-f]+)/iu.exec(signatureOutput)?.[1];
  const appHardenedRuntimeEnabled = signatureFlags !== undefined && (Number.parseInt(signatureFlags, 16) & 0x10000) !== 0;
  const appSecureTimestampPresent = /^Timestamp=(?!none\s*$)\S.+$/miu.test(signatureOutput);
  if (appSignatureKind === 'adhoc' && appHardenedRuntimeEnabled) throw new Error('The local ad-hoc candidate must disable hardened runtime to load its unsigned-team Electron framework.');
  if (appSignatureKind === 'developer_id' && (!nestedDeveloperIdSigned(after) || !appHardenedRuntimeEnabled || !appSecureTimestampPresent)) throw new Error('Developer ID verification requires both final nested resource signatures, hardened runtime and a secure timestamp.');
  const gatekeeper = await assessGatekeeper(appPath, runCommand);
  return {
    schemaVersion: 1,
    target,
    signingPerformed: !options.verifyOnly,
    appSignatureKind,
    appHardenedRuntimeEnabled,
    appSecureTimestampPresent,
    deepStrictVerificationPassed: true,
    resourceIntegrityUnchangedByOuterSigning: options.verifyOnly ? null : true,
    nestedDeveloperIdSigned: nestedDeveloperIdSigned(after),
    contributions: after,
    gatekeeper,
    notarizationPerformed: false,
    releaseReadinessAssessed: false,
    privacy: { absolutePathsRecorded: false, signingIdentityRecorded: false },
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    app: { type: 'string' }, identity: { type: 'string' },
    'verify-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  }, strict: true });
  if (values.help) {
    process.stdout.write('Usage: node scripts/packaging/sign-subtitle-studio.mjs --app <FusionKit.app> [--identity <identity-or-dash>] [--verify-only]\n');
    return;
  }
  const report = await signPackagedApplication({ appPath: values.app, identity: values.identity, verifyOnly: values['verify-only'] });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => {
    // Raw signer errors can contain certificate names, keychain locations and private app paths.
    const knownCodes = new Set(['packaged_resource_preflight_failed', 'packaged_outer_signing_failed', 'packaged_resource_postflight_failed', 'packaged_deep_strict_verification_failed', 'packaged_signature_inspection_failed']);
    const code = knownCodes.has(error?.code) ? error.code : 'packaged_signing_failed';
    process.stderr.write(`${code}: signing or resource verification failed; no release readiness was established.\n`);
    process.exitCode = 1;
  });
}
