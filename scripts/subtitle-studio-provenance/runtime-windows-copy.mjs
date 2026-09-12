import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolingCopyPlan, applyToolingCopyPlan } from './tooling-copy.mjs';
import { RUNTIME_WINDOWS_COPY_RECIPE, RUNTIME_WINDOWS_FORK_PATH } from './runtime-windows-copy-recipe.mjs';

export function createRuntimeWindowsCopyPlan(options = {}) {
  return createToolingCopyPlan({ ...options, recipe: options.recipe ?? RUNTIME_WINDOWS_COPY_RECIPE });
}
export function applyRuntimeWindowsCopyPlan(plan, options = {}) {
  return applyToolingCopyPlan(plan, { ...options, provenancePath: options.provenancePath ?? RUNTIME_WINDOWS_FORK_PATH });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--write', '--check'].includes(args[0])) throw new Error('Usage: runtime-windows-copy.mjs --write|--check');
    const result = applyRuntimeWindowsCopyPlan(createRuntimeWindowsCopyPlan(), { write: args[0] === '--write' });
    console.log(JSON.stringify({ status: 'passed', mode: args[0], files: result.files.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
