import { lstat } from 'node:fs/promises';
import path from 'node:path';

export const PACKAGING_HOOK = 'scripts/packaging/subtitle-studio-before-pack.cjs';
export const ARTIFACT_NAME_PATTERN = '${productName}_${version}_${arch}.${ext}';
export const RESOURCE_CONTRIBUTIONS = Object.freeze({
  legacy: Object.freeze({ from: 'build/local-subtitle-resources/local-subtitle', to: 'local-subtitle',
    runtimeVerifier: '../local-subtitle/runtime/runtime-manifest.mjs', overwriteVerifier: '../local-subtitle/overwrite-native/overwrite-native-staging.mjs' }),
  studio: Object.freeze({ from: 'build/subtitle-studio-resources/transcription', to: 'subtitle-studio/transcription',
    runtimeVerifier: '../subtitle-studio/transcription/runtime/runtime-manifest.mjs', overwriteVerifier: '../subtitle-studio/transcription/overwrite-native/overwrite-native-staging.mjs' }),
});

export function packagingError(message, contribution, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = typeof cause?.code === 'string' ? cause.code : 'runtime_staging_invalid';
  if (contribution) error.contribution = contribution;
  return error;
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function selectedContributions(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(RESOURCE_CONTRIBUTIONS, id))) throw packagingError('Unknown or repeated resource contribution.');
  return ids.map(id => [id, RESOURCE_CONTRIBUTIONS[id]]);
}

export function assertPackagingConfig(config, { contributionIds = ['legacy', 'studio'] } = {}) {
  const selected = selectedContributions(contributionIds);
  if (!config || config.beforePack !== PACKAGING_HOOK || !Array.isArray(config.extraResources) || config.extraResources.length !== selected.length) throw packagingError('The complete builder resource configuration is invalid.');
  const expectedMappings = selected.map(([, item]) => ({ from: item.from, to: item.to, filter: ['**/*'] }));
  if (config.extraResources.some((item, index) => !exactObject(item, ['from', 'to', 'filter']) || item.from !== expectedMappings[index].from || item.to !== expectedMappings[index].to || !Array.isArray(item.filter) || item.filter.length !== 1 || item.filter[0] !== '**/*')) throw packagingError('The builder contains an incorrect resource mapping.');
  for (const [platform, targets, arch] of [['mac', ['dmg', 'zip'], 'arm64'], ['win', ['nsis'], 'x64']]) {
    const value = config[platform];
    if (!value || value.artifactName !== ARTIFACT_NAME_PATTERN || !Array.isArray(value.target) || value.target.length !== targets.length || value.target.some((entry, index) => !exactObject(entry, ['target', 'arch']) || entry.target !== targets[index] || !Array.isArray(entry.arch) || entry.arch.length !== 1 || entry.arch[0] !== arch)) throw packagingError('The builder artifact name or target matrix is invalid.');
    // Per-platform overrides can silently bypass the common resource contribution.
    for (const key of ['extraResources', 'extraFiles', 'beforePack', 'sign']) if (Object.hasOwn(value, key)) throw packagingError(`Unsupported platform override: ${platform}.${key}`);
  }
  const ignores = selected.map(([, item]) => `Contents/Resources/${item.to}/`);
  if (!Array.isArray(config.mac.signIgnore) || config.mac.signIgnore.length !== ignores.length || config.mac.signIgnore.some((value, index) => value !== ignores[index])) throw packagingError('Both frozen resource roots must be excluded from outer signing.');
  for (const key of ['extraFiles', 'afterPack', 'afterSign']) if (Object.hasOwn(config, key)) throw packagingError(`Unaudited packaging hook or resource override: ${key}`);
  return true;
}

export function resolvePackagingTarget(context, { platform = process.platform, arch = process.arch } = {}) {
  const selectedPlatform = context?.electronPlatformName;
  const selectedArch = context?.arch === 1 ? 'x64' : context?.arch === 3 ? 'arm64' : context?.arch;
  if (!((selectedPlatform === 'darwin' && selectedArch === 'arm64') || (selectedPlatform === 'win32' && selectedArch === 'x64')) || selectedPlatform !== platform || selectedArch !== arch || context?.packager?.platform?.nodeName !== selectedPlatform) throw packagingError('Builder, packager and native host targets must match.');
  return { platform: selectedPlatform, arch: selectedArch };
}

export async function verifyContributionRoot(projectRoot, contribution) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw packagingError('The packaging project root must be absolute.');
  let current = path.resolve(projectRoot);
  for (const segment of ['', ...contribution.from.split('/')]) {
    if (segment) current = path.join(current, segment);
    let stat;
    try { stat = await lstat(current); } catch (cause) { throw packagingError('A canonical staging directory is unavailable.', undefined, cause); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw packagingError('A canonical staging directory contains a link or non-directory.');
  }
  return current;
}

export async function loadContributionVerifiers(id) {
  const [[, contribution]] = selectedContributions([id]);
  const runtime = await import(new URL(contribution.runtimeVerifier, import.meta.url).href);
  const overwrite = await import(new URL(contribution.overwriteVerifier, import.meta.url).href);
  if (typeof runtime.verifyRuntimeBundle !== 'function' || typeof overwrite.verifyStagedOverwriteNativeAddon !== 'function') throw packagingError('A contribution verifier is unavailable.', id);
  return { verifyRuntimeBundle: runtime.verifyRuntimeBundle, verifyStagedOverwriteNativeAddon: overwrite.verifyStagedOverwriteNativeAddon };
}

export async function verifyPackagingContributions({ projectRoot, target, contributionIds = ['legacy', 'studio'] }, { loadVerifiers = loadContributionVerifiers } = {}) {
  const selected = selectedContributions(contributionIds);
  if (!((target?.platform === 'darwin' && target.arch === 'arm64') || (target?.platform === 'win32' && target.arch === 'x64'))) throw packagingError('Unsupported staging target.');
  const reports = [];
  for (const [id, contribution] of selected) {
    try {
      const root = await verifyContributionRoot(projectRoot, contribution);
      const verifiers = await loadVerifiers(id);
      const runtime = await verifiers.verifyRuntimeBundle({ runtimeRoot: root, ...target, scope: 'all', launch: false });
      if (runtime?.ready !== true) throw packagingError('The official runtime is not ready.');
      const overwrite = await verifiers.verifyStagedOverwriteNativeAddon({ root, ...target });
      if (overwrite?.ready !== true || overwrite.moduleExportsVerified !== true) throw packagingError('The native addon verification is incomplete.');
      reports.push({ id, from: contribution.from, to: contribution.to, runtime, overwrite });
    } catch (cause) { throw packagingError(`Resource contribution ${id} failed verification.`, id, cause); }
  }
  return { schemaVersion: 1, target, ready: true, officialRuntimeLaunchPerformed: false, overwriteAddonModuleProbePerformed: true, contributions: reports };
}
