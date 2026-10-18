import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { APPLICATION_RESOURCES, assertPackagingConfig, DMG_CONTENTS, DMG_HELP_FILE, DMG_HELP_NAME, DMG_WINDOW, NSIS_INCLUDE, resolvePackagingTarget, verifyPackagingContributions, loadContributionVerifiers, RESOURCE_CONTRIBUTIONS, WINDOWS_RESOURCES } from './subtitle-studio-contract.mjs';
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

test('the default build resolves the complete dual-resource configuration and never publishes', async () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const stages = scripts.build.split('&&').map(value => value.trim());
  assert.deepEqual(stages.slice(0, -1), ['tsc', 'vite build', 'node scripts/check-preload-bundle.mjs']);
  const args = stages.at(-1).split(/\s+/u);
  assert.equal(args[0], 'electron-builder');
  assert.deepEqual(args.slice(1), ['--config', 'electron-builder.subtitle-studio.json', '--publish', 'never']);
  const config = await getConfig(projectRoot, path.join(projectRoot, args[2]));
  await validateConfig(config);
  assert.equal(assertPackagingConfig(config), true);
});

test('validates the real electron-builder resolved configuration without modifying the old entry', async () => {
  const config = await getConfig(projectRoot, path.join(projectRoot, 'electron-builder.subtitle-studio.json'));
  await validateConfig(config);
  assert.equal(assertPackagingConfig(config), true);
  const old = JSON.parse(fs.readFileSync(path.join(projectRoot, 'electron-builder.json'), 'utf8'));
  const expected = structuredClone(old);
  expected.beforePack = 'scripts/packaging/subtitle-studio-before-pack.cjs';
  expected.extraResources.push({ from: RESOURCE_CONTRIBUTIONS.studio.from, to: RESOURCE_CONTRIBUTIONS.studio.to, filter: ['**/*'] });
  for (const item of APPLICATION_RESOURCES) expected.extraResources.push({ from: item.from, to: item.to, filter: ['**/*'] });
  expected.mac.signIgnore.push('Contents/Resources/subtitle-studio/transcription/');
  // Windows only: the VC++ redistributable and the NSIS include that installs it.
  expected.win.extraResources = WINDOWS_RESOURCES.map(item => ({ from: item.from, to: item.to, filter: [...item.filter] }));
  expected.nsis.include = NSIS_INCLUDE;
  // macOS only: the DMG also holds the help page on opening an unsigned app.
  expected.dmg.window = { ...DMG_WINDOW };
  expected.dmg.contents = DMG_CONTENTS.map(entry => ({ ...entry }));
  assert.deepEqual(readConfig(), expected);
  assert.equal(fs.existsSync(path.join(projectRoot, NSIS_INCLUDE)), true);
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
    value => { value.extraResources.splice(2, 1); },
    value => { value.extraResources[2].from = 'resources'; },
    value => { value.mac.signIgnore.pop(); },
    value => { value.mac.signIgnore[1] = 'Contents/Resources/'; },
    value => { value.mac.target[0].arch = ['x64']; },
    value => { value.win.target[0].target = 'zip'; },
    value => { value.mac.artifactName = '${productName}.${ext}'; },
    value => { value.mac.extraResources = []; },
    value => { value.mac.extraResources = structuredClone(value.win.extraResources); },
    value => { delete value.win.extraResources; },
    value => { value.win.extraResources = []; },
    value => { value.win.extraResources[0].from = 'build'; },
    value => { value.win.extraResources[0].to = 'resources'; },
    value => { value.win.extraResources[0].filter = ['**/*']; },
    value => { value.win.extraResources[0].filter.push('vc-redist-version.nsh'); },
    value => { value.win.extraResources.push({ from: 'build', to: 'extra', filter: ['**/*'] }); },
    value => { value.win.extraFiles = []; },
    value => { delete value.nsis.include; },
    value => { value.nsis.include = 'build/other.nsh'; },
    value => { value.nsis.perMachine = true; },
    value => { value.nsis.script = 'build/custom.nsi'; },
    value => { value.afterSign = 'unreviewed.cjs'; },
    value => { delete value.dmg.contents; },
    value => { value.dmg.contents.pop(); },
    value => { value.dmg.contents[2].path = 'build/dmg/other.html'; },
    value => { value.dmg.contents[2].type = 'dir'; },
    value => { value.dmg.contents[2].name = '打不开请看这里.html'; },
    value => { delete value.dmg.contents[2].name; },
    value => { value.dmg.contents[0].path = 'FusionKit.app'; },
    value => { value.dmg.contents[1].path = '/Users'; },
    value => { value.dmg.contents.push({ x: 1, y: 1, type: 'file', path: 'package.json' }); },
    value => { value.dmg.window.height = 300; },
    value => { delete value.dmg.window; },
  ];
  let loads = 0;
  const hook = createBeforePackHook({ host: { platform: 'darwin', arch: 'arm64' }, loadVerifiers: () => { loads++; throw new Error('must not load'); } });
  for (const mutate of mutations) {
    const config = readConfig(); mutate(config);
    await assert.rejects(hook(context(projectRoot, config)), error => error.code === 'runtime_staging_invalid');
  }
  assert.equal(loads, 0);
});

test('the DMG help page exists, is self-contained and gives the same steps in Chinese and English', () => {
  const html = fs.readFileSync(path.join(projectRoot, DMG_HELP_FILE), 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8">/i);
  // Opened from the DMG without a network: nothing is loaded from elsewhere.
  for (const external of [/<script[^>]+src=/i, /<link\b/i, /<img\b/i, /<iframe\b/i, /@import/i, /url\(/i, /\bsrc="https?:/i]) assert.doesNotMatch(html, external);
  const command = 'xattr -dr com.apple.quarantine /Applications/FusionKit.app';
  assert.equal(html.split(command).length - 1, 2);
  for (const text of ['隐私与安全性', '仍要打开', '已损坏', '应用程序', 'macOS 12', 'Privacy &amp; Security', 'Open Anyway', 'is damaged', 'Applications', 'Apple silicon']) assert.ok(html.includes(text), text);
  // In the DMG it is named in Chinese and English, so either reader knows what it is (dmg-builder
  // escapes the quote for dmgbuild; the file in the repository keeps its Chinese name).
  assert.equal(path.basename(DMG_HELP_FILE), '打不开请看这里.html');
  assert.equal(DMG_HELP_NAME, "打不开请看这里 Can't open.html");
  assert.deepEqual(DMG_CONTENTS.filter(entry => entry.type === 'file').map(entry => entry.name), [DMG_HELP_NAME]);
});

/** Width and height of the first image in a TIFF file (dmg-builder's background is one). */
function tiffSize(bytes) {
  const littleEndian = bytes.toString('latin1', 0, 2) === 'II';
  const u16 = offset => (littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
  const u32 = offset => (littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  const directory = u32(4);
  const tags = {};
  for (let index = 0; index < u16(directory); index++) {
    const entry = directory + 2 + index * 12;
    tags[u16(entry)] = u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8);
  }
  return { width: tags[256], height: tags[257] };
}

test('the DMG layout fits the background dmg-builder draws behind it', () => {
  const config = readConfig();
  // No picture or colour of our own and none in build/: dmg-builder uses its template background.
  assert.equal(Object.hasOwn(config.dmg, 'background') || Object.hasOwn(config.dmg, 'backgroundColor'), false);
  for (const name of ['background.tiff', 'background.png']) assert.equal(fs.existsSync(path.join(projectRoot, 'build', name)), false, name);
  const background = tiffSize(fs.readFileSync(require.resolve('dmg-builder/templates/background.tiff')));
  assert.deepEqual(DMG_WINDOW, background);
  // The app and the Applications link stay where electron-builder puts them by default, at both
  // ends of the template's arrow (positions are icon centres).
  const [app, applications, help] = DMG_CONTENTS;
  assert.deepEqual([app, applications].map(({ x, y }) => [x, y]), [[130, 220], [410, 220]]);
  // The help page's icon (80 px, the default size) and a two-line label fit in the band above them.
  const iconHalf = 40, label = 32;
  assert.ok(help.y - iconHalf >= 0 && help.y + iconHalf + label <= app.y - iconHalf, `help page at y=${help.y}`);
  assert.ok(help.x - iconHalf >= 0 && help.x + iconHalf <= DMG_WINDOW.width);
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

test('stages the VC++ redistributable for Windows only, after both contributions, and refuses an unverified one', async () => {
  const f = fixture();
  try {
    const calls = [];
    const loadVerifiers = async id => ({
      verifyRuntimeBundle: async () => { calls.push(`runtime:${id}`); return { ready: true }; },
      verifyStagedOverwriteNativeAddon: async () => { calls.push(`overwrite:${id}`); return { ready: true, moduleExportsVerified: true }; },
    });
    const record = { schemaVersion: 1, fileName: 'vc_redist.x64.exe', version: '14.52.36500.0', sha256: 'a'.repeat(64), byteSize: 25_000_000, signer: 'O=Microsoft Corporation', source: 'cache' };
    const prepareVcRedist = async options => { calls.push(`vc-redist:${options.projectRoot}`); return record; };
    const windows = await createBeforePackHook({ host: { platform: 'win32', arch: 'x64' }, loadVerifiers, prepareVcRedist })(context(f.root, readConfig(), 'win32', 1));
    assert.deepEqual(calls, ['runtime:legacy', 'overwrite:legacy', 'runtime:studio', 'overwrite:studio', `vc-redist:${f.root}`]);
    assert.deepEqual(windows.vcRedist, record);
    assert.equal(windows.ready, true);

    calls.length = 0;
    const mac = await createBeforePackHook({ host: { platform: 'darwin', arch: 'arm64' }, loadVerifiers, prepareVcRedist })(context(f.root));
    assert.equal(calls.some(call => call.startsWith('vc-redist')), false);
    assert.equal(Object.hasOwn(mac, 'vcRedist'), false);

    const refused = createBeforePackHook({ host: { platform: 'win32', arch: 'x64' }, loadVerifiers, prepareVcRedist: async () => {
      throw Object.assign(new Error('The VC++ redistributable is not signed by Microsoft Corporation.'), { code: 'vc_redist_invalid' });
    } });
    await assert.rejects(refused(context(f.root, readConfig(), 'win32', 1)), error => error.code === 'vc_redist_invalid' && error.contribution === 'vc-redist'
      && /failed verification/.test(error.message) && /Microsoft Corporation/.test(error.cause.message));
  } finally { f.cleanup(); }
});

test('the NSIS include installs the redistributable only below the runtime the programs need, without failing the installation', () => {
  const script = fs.readFileSync(path.join(projectRoot, NSIS_INCLUDE), 'utf8');
  const lines = script.split(/\r?\n/u).map(line => line.trim());
  const has = line => assert.ok(lines.includes(line), `missing: ${line}`);
  const install = script.slice(script.indexOf('!macro customInstall'), script.indexOf('!macroend'));
  has(String.raw`!include "vc-redist\vc-redist-version.nsh"`);
  assert.ok(script.indexOf('!macro customInstall') < script.indexOf('!macroend'));
  assert.ok(script.indexOf('SetRegView 64') < script.indexOf('SetRegView lastused'));
  for (const [register, value] of [['$0', 'Installed'], ['$1', 'Major'], ['$2', 'Minor'], ['$3', 'Bld']]) {
    has(String.raw`ReadRegDWORD ${register} HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "${value}"`);
  }
  // Compared with the minimum, not the bundled build: a working runtime is never upgraded by an update.
  has('StrCmp $0 "1" 0 fusionkit_vc_install');
  has('IntCmp $1 ${VC_RUNTIME_MIN_MAJOR} 0 fusionkit_vc_install fusionkit_vc_done');
  has('IntCmp $2 ${VC_RUNTIME_MIN_MINOR} 0 fusionkit_vc_install fusionkit_vc_done');
  has('IntCmp $3 ${VC_RUNTIME_MIN_BUILD} fusionkit_vc_done fusionkit_vc_install fusionkit_vc_done');
  assert.doesNotMatch(install, /IntCmp \$\d \$\{VC_REDIST_/u);
  has(String.raw`IfFileExists "$INSTDIR\resources\vc-redist\vc_redist.x64.exe" 0 fusionkit_vc_done`);
  // An update after a declined confirmation skips it; a decline is remembered, a success forgets it.
  has('${If} ${isUpdated}');
  has('ReadRegStr $1 HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined"');
  has('StrCmp $1 "" 0 fusionkit_vc_done');
  assert.ok(install.indexOf('${If} ${isUpdated}') < install.indexOf('ExecWait'));
  has(String.raw`ExecWait '"$INSTDIR\resources\vc-redist\vc_redist.x64.exe" /install /quiet /norestart' $0`);
  for (const code of ['0', '1638', '3010']) has(`StrCmp $0 "${code}" fusionkit_vc_installed`);
  for (const code of ['1602', '1223']) has(`StrCmp $0 "${code}" fusionkit_vc_declined`);
  has('WriteRegStr HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined" "${VC_REDIST_VERSION}"');
  has('DeleteRegValue HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined"');
  // The status line before Windows asks is in the installer's language (Simplified, Traditional Chinese, Japanese, else English).
  for (const language of ['2052', '1028', '1041']) assert.match(install, new RegExp(String.raw`\$LANGUAGE == ${language}\n\s*DetailPrint "[^"]+"`, 'u'));
  // Only a real uninstall forgets the decline.
  assert.match(script, /!macro customUnInstall\n\s*\$\{IfNot\} \$\{isUpdated\}\n\s*DeleteRegKey HKCU "\$\{FUSIONKIT_SETUP_KEY\}"/u);
  // Declining the confirmation or a failure must never stop FusionKit's own installation.
  assert.doesNotMatch(script, /\b(?:Abort|Quit|MessageBox|SetErrorLevel)\b/u);
  assert.equal(script.match(/^\s*Push \$\d$/gmu).length, 4);
  assert.equal(script.match(/^\s*Pop \$\d$/gmu).length, 4);
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
