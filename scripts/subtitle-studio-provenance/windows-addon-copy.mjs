import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCopyPlan } from './native-copy.mjs';
import { applyCopyPlan } from './copy.mjs';

export const WINDOWS_ADDON_FORK_PATH = 'resources/subtitle-studio/provenance/transcription-windows-addon-fork.json';
export const WINDOWS_ADDON_RECIPE = JSON.parse(fs.readFileSync(new URL('./windows-addon-copy-recipe.json', import.meta.url), 'utf8'));
const leaves = new Set(['build-addon-windows-x64.mjs', 'build-test-addon-windows-x64.mjs', 'build-addon-windows-x64.test.mjs',
  'run-addon-windows-integration.mjs', 'run-addon-windows-recovery-integration.mjs', 'run-addon-windows-recovery-child.mjs']);

/** T07 owns only new Windows tooling. Frozen C++ and T03 tooling stay external dependencies. */
export function createWindowsAddonCopyPlan(options = {}) {
  const recipe = options.recipe ?? WINDOWS_ADDON_RECIPE;
  if (recipe.files.length !== leaves.size || recipe.files.some(entry =>
    !leaves.has(path.posix.basename(entry.sourcePath)) || entry.sourcePath !== `scripts/local-subtitle/overwrite-native/${path.posix.basename(entry.sourcePath)}`
    || entry.destinationPath !== `scripts/subtitle-studio/transcription/overwrite-native/${path.posix.basename(entry.sourcePath)}`)) {
    throw new Error('Windows addon recipe may own only the six new Windows tooling files');
  }
  const plan = createNativeCopyPlan({ ...options, recipe });
  return { ...plan, provenance: { ...plan.provenance, status: 'windows-addon-source-copy-unregistered',
    historicalNativeForkUnchanged: true, runtimeValidationRequired: ['electron-production-transactions', 'electron-fresh-process-recovery', 'studio-namespace-isolation'] } };
}

export function applyWindowsAddonCopyPlan(plan, options = {}) {
  return applyCopyPlan(plan, { provenancePath: WINDOWS_ADDON_FORK_PATH, ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !['--check', '--write'].includes(args[0])) throw new Error('Usage: node windows-addon-copy.mjs [--check|--write]');
    const plan = createWindowsAddonCopyPlan();
    applyWindowsAddonCopyPlan(plan, { write: args[0] === '--write' });
    console.log(JSON.stringify({ status: 'passed', mode: args[0] === '--write' ? 'write' : 'check', files: plan.files.length,
      dependencies: plan.provenance.dependencies.length, sourceCommit: plan.baseline.sourceCommit }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
