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

/**
 * Ordinary application resources after the frozen runtime roots: copied as they are and
 * signed with the app, with no runtime verifier. The external agent's stdio bridge script.
 */
export const APPLICATION_RESOURCES = Object.freeze([
  Object.freeze({ from: 'resources/external-agent', to: 'external-agent' }),
]);

/**
 * Windows only: Microsoft's signed VC++ redistributable and its version record, staged and verified
 * in build/vc-redist by the before-pack hook (vc-redist.mjs). The NSIS include installs it when the
 * runtime is missing or older; the app reads the record and offers the same installer as a repair.
 */
export const WINDOWS_RESOURCES = Object.freeze([
  Object.freeze({ from: 'build/vc-redist', to: 'vc-redist', filter: Object.freeze(['vc_redist.x64.exe', 'vc-redist.json']) }),
]);
export const NSIS_INCLUDE = 'build/installer.nsh';

/**
 * macOS: the DMG shows the app, the Applications link and a self-contained help page on opening an
 * unsigned app (zh + en, no external resources), each at a fixed place; electron-builder needs
 * explicit positions once the window holds more than the app and the link. No background is set,
 * so dmg-builder's own 540×380 picture is used: the window keeps its size, the app and the link stay
 * at electron-builder's default places on both ends of its arrow (icon centres), and the help page
 * sits in the empty band above them.
 */
export const DMG_HELP_FILE = 'build/dmg/打不开请看这里.html';
/** Its name inside the DMG, in Chinese and English, so either reader knows what it is. */
export const DMG_HELP_NAME = "打不开请看这里 Can't open.html";
export const DMG_WINDOW = Object.freeze({ width: 540, height: 380 });
export const DMG_CONTENTS = Object.freeze([
  Object.freeze({ x: 130, y: 220 }),
  Object.freeze({ x: 410, y: 220, type: 'link', path: '/Applications' }),
  Object.freeze({ x: 270, y: 80, type: 'file', path: DMG_HELP_FILE, name: DMG_HELP_NAME }),
]);

export function packagingError(message, contribution, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = typeof cause?.code === 'string' ? cause.code : 'runtime_staging_invalid';
  if (contribution) error.contribution = contribution;
  return error;
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sameMappings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => exactObject(item, ['from', 'to', 'filter'])
    && item.from === expected[index].from && item.to === expected[index].to && Array.isArray(item.filter)
    && item.filter.length === expected[index].filter.length && item.filter.every((value, position) => value === expected[index].filter[position]));
}

function sameEntry(actual, expected) {
  return exactObject(actual, Object.keys(expected)) && Object.keys(expected).every(key => actual[key] === expected[key]);
}

function sameDmgLayout(dmg) {
  return dmg !== null && typeof dmg === 'object' && sameEntry(dmg.window, DMG_WINDOW)
    && Array.isArray(dmg.contents) && dmg.contents.length === DMG_CONTENTS.length
    && dmg.contents.every((entry, index) => sameEntry(entry, DMG_CONTENTS[index]));
}

function selectedContributions(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(RESOURCE_CONTRIBUTIONS, id))) throw packagingError('Unknown or repeated resource contribution.');
  return ids.map(id => [id, RESOURCE_CONTRIBUTIONS[id]]);
}

export function assertPackagingConfig(config, { contributionIds = ['legacy', 'studio'] } = {}) {
  const selected = selectedContributions(contributionIds);
  const expectedMappings = [...selected.map(([, item]) => item), ...APPLICATION_RESOURCES].map(item => ({ from: item.from, to: item.to, filter: ['**/*'] }));
  if (!config || config.beforePack !== PACKAGING_HOOK || !Array.isArray(config.extraResources) || config.extraResources.length !== expectedMappings.length) throw packagingError('The complete builder resource configuration is invalid.');
  if (config.extraResources.some((item, index) => !exactObject(item, ['from', 'to', 'filter']) || item.from !== expectedMappings[index].from || item.to !== expectedMappings[index].to || !Array.isArray(item.filter) || item.filter.length !== 1 || item.filter[0] !== '**/*')) throw packagingError('The builder contains an incorrect resource mapping.');
  for (const [platform, targets, arch] of [['mac', ['dmg', 'zip'], 'arm64'], ['win', ['nsis'], 'x64']]) {
    const value = config[platform];
    if (!value || value.artifactName !== ARTIFACT_NAME_PATTERN || !Array.isArray(value.target) || value.target.length !== targets.length || value.target.some((entry, index) => !exactObject(entry, ['target', 'arch']) || entry.target !== targets[index] || !Array.isArray(entry.arch) || entry.arch.length !== 1 || entry.arch[0] !== arch)) throw packagingError('The builder artifact name or target matrix is invalid.');
    // Per-platform overrides can silently bypass the common resource contribution; Windows adds exactly the VC++ redistributable.
    for (const key of ['extraFiles', 'beforePack', 'sign']) if (Object.hasOwn(value, key)) throw packagingError(`Unsupported platform override: ${platform}.${key}`);
    if (platform === 'mac' ? Object.hasOwn(value, 'extraResources') : !sameMappings(value.extraResources, WINDOWS_RESOURCES)) throw packagingError(`Unsupported platform override: ${platform}.extraResources`);
  }
  if (!config.nsis || config.nsis.include !== NSIS_INCLUDE || config.nsis.perMachine !== false || Object.hasOwn(config.nsis, 'script')) throw packagingError('The NSIS installer must use the reviewed include and stay per-user.');
  if (!sameDmgLayout(config.dmg)) throw packagingError('The DMG must hold exactly the app, the Applications link and the help page.');
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
