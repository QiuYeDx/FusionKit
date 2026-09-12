import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBaseline, serialize } from './generate.mjs';
import { applyCopyPlan, checkCopyWorktree } from './copy.mjs';

export const NATIVE_FORK_PATH = 'resources/subtitle-studio/provenance/transcription-native-fork.json';
export const NATIVE_RECIPE = JSON.parse(fs.readFileSync(new URL('./native-copy-recipe.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new Error(`Unsafe native copy path: ${value}`);
  return value;
}
function readRegular(root, name) {
  let absolute = root;
  for (const part of relative(name).split('/')) {
    absolute = path.join(absolute, part);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Symlink native dependency: ${name}`);
  }
  if (!fs.statSync(absolute).isFile()) throw new Error(`Native dependency is not a file: ${name}`);
  return fs.readFileSync(absolute);
}

// T01 and T02 stay frozen. This independent recipe owns only the native and
// overwrite tooling files; shared runtime tools are verified against their owner.
export function createNativeCopyPlan({ root = process.cwd(), baseline: suppliedBaseline, recipe = NATIVE_RECIPE } = {}) {
  const baseline = suppliedBaseline ?? checkBaseline({ root });
  if (baseline.sourceCommit !== recipe.sourceCommit) throw new Error('Native source commit differs from the frozen baseline');
  checkCopyWorktree(root, baseline, suppliedBaseline ? { roots: baseline.files.map(file => file.sourcePath) } : undefined);
  const sourceFiles = new Map(baseline.files.map(file => [file.sourcePath, file]));
  const destinations = new Set(), sources = new Set();
  for (const entry of [...recipe.files, ...recipe.dependencies]) {
    relative(entry.sourcePath); relative(entry.destinationPath);
    if (!sourceFiles.has(entry.sourcePath)) throw new Error(`Native source missing from baseline: ${entry.sourcePath}`);
    if (sources.has(entry.sourcePath)) throw new Error(`Duplicate native source: ${entry.sourcePath}`);
    if (destinations.has(entry.destinationPath.toLowerCase())) throw new Error(`Conflicting native destination: ${entry.destinationPath}`);
    sources.add(entry.sourcePath); destinations.add(entry.destinationPath.toLowerCase());
  }
  for (const destination of destinations) if ([...sources].some(source => source.toLowerCase() === destination)) throw new Error(`Native destination overlaps source: ${destination}`);
  for (const edge of baseline.dependencies ?? []) if (sources.has(edge.sourcePath)) {
    for (const target of [...(edge.resolvedPath ? [edge.resolvedPath] : []), ...(edge.auditedTargets ?? [])]) {
      if (!sources.has(target)) throw new Error(`Missing native dependency: ${edge.sourcePath} -> ${target}`);
    }
  }
  const owned = new Set(recipe.files.map(file => file.sourcePath));
  for (const edit of recipe.literalEdits) {
    if (!owned.has(edit.sourcePath)) throw new Error(`Unused native copy audit: ${edit.sourcePath}`);
    if (!edit.fromText || edit.fromText === edit.toText || !Number.isInteger(edit.count) || edit.count < 1 || typeof edit.reason !== 'string') throw new Error(`Invalid native copy audit: ${edit.sourcePath}`);
  }
  function readSource(entry) {
    const source = sourceFiles.get(entry.sourcePath);
    const oid = git(root, ['rev-parse', `${baseline.sourceCommit}:${entry.sourcePath}`]).toString().trim();
    if (oid !== source.blobOid) throw new Error(`Native Git source identity differs: ${entry.sourcePath}`);
    const bytes = git(root, ['cat-file', 'blob', oid]);
    if (bytes.length !== source.byteSize || hash(bytes) !== source.sha256) throw new Error(`Native source content differs: ${entry.sourcePath}`);
    return bytes;
  }
  const files = recipe.files.map(entry => {
    const sourceBytes = readSource(entry);
    let text = sourceBytes.toString('utf8');
    const transforms = [];
    for (const edit of recipe.literalEdits.filter(edit => edit.sourcePath === entry.sourcePath)) {
      const count = text.split(edit.fromText).length - 1;
      if (count !== edit.count) throw new Error(`Native literal count differs: ${entry.sourcePath}: expected ${edit.count}, found ${count}`);
      text = text.split(edit.fromText).join(edit.toText);
      transforms.push({ kind: 'exact-text', from: edit.fromText, to: edit.toText, count, reason: edit.reason });
    }
    return { ...entry, sourceBytes, bytes: Buffer.from(text), transforms };
  });
  const dependencies = recipe.dependencies.map(entry => {
    const sourceBytes = readSource(entry), destinationBytes = readRegular(root, entry.destinationPath);
    const owner = JSON.parse(readRegular(root, entry.provenancePath).toString('utf8'));
    const record = owner.files.find(file => file.sourcePath === entry.sourcePath && file.destinationPath === entry.destinationPath);
    if (owner.sourceCommit !== baseline.sourceCommit || !record || record.sourceSha256 !== hash(sourceBytes) || record.destinationSha256 !== hash(destinationBytes)) throw new Error(`Native dependency provenance differs: ${entry.destinationPath}`);
    return { ...entry, sourceBlobOid: sourceFiles.get(entry.sourcePath).blobOid, sourceSha256: hash(sourceBytes), destinationSha256: hash(destinationBytes), ownership: 'verified-external-tooling-copy' };
  });
  return { baseline, files, provenance: {
    schemaVersion: 1, sourceCommit: baseline.sourceCommit, sourceBaselineSha256: hash(serialize(baseline)),
    recipeSha256: hash(serialize(recipe)), status: 'native-source-copy-unregistered',
    compatibility: { napiVersion: 8, nativeProtocolVersion: 4, journalVersion: 3 },
    files: files.map(file => ({ sourcePath: file.sourcePath, sourceBlobOid: sourceFiles.get(file.sourcePath).blobOid,
      sourceSha256: hash(file.sourceBytes), destinationPath: file.destinationPath, destinationSha256: hash(file.bytes), byteSize: file.bytes.length, transforms: file.transforms })),
    dependencies, deferred: recipe.deferred,
  } };
}
export function applyNativeCopyPlan(plan, options = {}) {
  return applyCopyPlan(plan, { provenancePath: NATIVE_FORK_PATH, ...options });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !['--check', '--write'].includes(args[0])) throw new Error('Usage: node scripts/subtitle-studio-provenance/native-copy.mjs [--check|--write]');
    const plan = createNativeCopyPlan();
    applyNativeCopyPlan(plan, { write: args[0] === '--write' });
    console.log(JSON.stringify({ status: 'passed', mode: args[0] === '--write' ? 'write' : 'check', files: plan.files.length, dependencies: plan.provenance.dependencies.length, sourceCommit: plan.baseline.sourceCommit }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
