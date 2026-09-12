import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWindowsRecoveryChildEnvironment } from './run-addon-windows-recovery-integration.mjs';

const require = createRequire(import.meta.url);
test('retains the Electron Node-mode flag while excluding arbitrary host environment', () => {
  const environment = createWindowsRecoveryChildEnvironment('crash', 'begin_after_namespace', {
    SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=untrusted.js',
    HTTP_PROXY: 'https://untrusted.invalid', PRIVATE_APP_SECRET: 'must-not-propagate',
  });
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(environment.FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION, 'crash');
  for (const name of ['NODE_OPTIONS', 'HTTP_PROXY', 'PRIVATE_APP_SECRET']) assert.equal(Object.hasOwn(environment, name), false);
  for (const flag of [undefined, '0', 'true']) assert.equal(Object.hasOwn(createWindowsRecoveryChildEnvironment(undefined, undefined,
    { SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: flag }), 'ELECTRON_RUN_AS_NODE'), false);
});

test('the actual Electron executable selects the wrong host mode when the old child environment drops its flag',
  { skip: process.platform !== 'win32' || process.env.FUSIONKIT_STUDIO_WINDOWS_ELECTRON_TEST !== '1', timeout: 30000 }, async () => {
    const electronPath = require('electron');
    const root = await mkdtemp(path.join(os.tmpdir(), 'studio-electron-mode-'));
    try {
      const environment = createWindowsRecoveryChildEnvironment(undefined, undefined, { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' });
      const run = env => spawnSync(electronPath, ['--version', ...(env.ELECTRON_RUN_AS_NODE === '1' ? [] : [`--user-data-dir=${path.join(root, 'profile')}`])],
        { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 });
      const fixed = run(environment), legacy = run(Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE')));
      assert.equal(fixed.status, 0, fixed.stderr); assert.equal(legacy.status, 0, legacy.stderr);
      assert.match(fixed.stdout.trim(), /^v\d+\.\d+\.\d+$/); assert.match(legacy.stdout.trim(), /^v\d+\.\d+\.\d+$/);
      assert.notEqual(fixed.stdout.trim(), legacy.stdout.trim(), 'The missing flag must demonstrably select a different interpreter');
      const expectedElectron = require('electron/package.json').version;
      assert.equal(legacy.stdout.trim(), `v${expectedElectron}`);
      if (process.env.FUSIONKIT_STUDIO_WINDOWS_HOST_REPORT) await writeFile(process.env.FUSIONKIT_STUDIO_WINDOWS_HOST_REPORT,
        JSON.stringify({ schemaVersion: 1, status: 'passed', electronVersion: expectedElectron,
          withoutNodeMode: legacy.stdout.trim(), withNodeMode: fixed.stdout.trim(),
          counterexample: 'The same Electron executable becomes the application interpreter when the recovery child drops ELECTRON_RUN_AS_NODE.',
          noNativeAddonLoaded: true }, null, 2) + '\n', { flag: 'wx' });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
  });
