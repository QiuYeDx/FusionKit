import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOLING_COPY_RECIPE, TOOLING_FORK_PATH } from './tooling-copy-recipe.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new Error(`Unsafe tooling path: ${value}`);
  return value;
}

function safePath(root, name) {
  let current = path.resolve(root);
  for (const part of relative(name).split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Tooling path is a symlink: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

export function createToolingCopyPlan({ root = defaultRoot, recipe = TOOLING_COPY_RECIPE } = {}) {
  const baselineBytes = fs.readFileSync(safePath(root, recipe.baselinePath));
  if (hash(baselineBytes) !== recipe.baselineSha256) throw new Error('Tooling baseline hash changed');
  const baseline = JSON.parse(baselineBytes);
  if (baseline.sourceCommit !== recipe.sourceCommit) throw new Error('Tooling source commit differs');
  const destinations = new Set();
  const sources = new Set(recipe.files.map(file => relative(file.sourcePath)));
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const files = recipe.files.map(file => {
    const destinationPath = relative(file.destinationPath);
    if (destinations.has(destinationPath.toLowerCase()) || sources.has(destinationPath)) throw new Error(`Conflicting tooling destination: ${destinationPath}`);
    destinations.add(destinationPath.toLowerCase());
    const record = baseline.files.find(item => item.sourcePath === file.sourcePath);
    if (!record) throw new Error(`Unregistered tooling source: ${file.sourcePath}`);
    const commitOid = git(['rev-parse', `${recipe.sourceCommit}:${file.sourcePath}`]).toString().trim();
    if (commitOid !== record.blobOid) throw new Error(`Tooling source blob differs: ${file.sourcePath}`);
    const bytes = git(['cat-file', 'blob', record.blobOid]);
    if (bytes.length !== record.byteSize || hash(bytes) !== record.sha256) throw new Error(`Tooling source identity differs: ${file.sourcePath}`);
    const currentPath = safePath(root, file.sourcePath);
    const attributes = git(['check-attr', '-z', 'filter', '--', file.sourcePath]).toString().split('\0');
    if (!['unspecified', 'unset'].includes(attributes[2])) throw new Error(`Unsupported tooling clean filter: ${file.sourcePath}`);
    const currentOid = git(['hash-object', `--path=${file.sourcePath}`, '--', currentPath]).toString().trim();
    if (currentOid !== record.blobOid) throw new Error(`Tooling source worktree drift: ${file.sourcePath}`);
    const text = bytes.toString('utf8'), transforms = [];
    for (const edit of file.edits) {
      if (!edit.from || !Number.isSafeInteger(edit.count) || edit.count < 1) throw new Error('Invalid tooling edit');
      let start = 0, count = 0;
      while ((start = text.indexOf(edit.from, start)) !== -1) {
        transforms.push({ start, end: start + edit.from.length, ...edit });
        start += edit.from.length; count++;
      }
      if (count !== edit.count) throw new Error(`Tooling edit count differs: ${file.sourcePath}: ${edit.from}`);
    }
    transforms.sort((a, b) => a.start - b.start);
    for (let index = 1; index < transforms.length; index++) if (transforms[index - 1].end > transforms[index].start) throw new Error(`Overlapping tooling edits: ${file.sourcePath}`);
    let output = text;
    for (const edit of [...transforms].reverse()) output = output.slice(0, edit.start) + edit.to + output.slice(edit.end);
    return { sourcePath: file.sourcePath, sourceBlobOid: record.blobOid, sourceSha256: record.sha256, destinationPath, destinationSha256: hash(output), byteSize: Buffer.byteLength(output), transforms, bytes: Buffer.from(output) };
  });
  return { files, provenance: { schemaVersion: 1, status: 'independent-verifier-sources', sourceCommit: recipe.sourceCommit,
    sourceBaselineSha256: recipe.baselineSha256, recipeSha256: hash(serialize(recipe)),
    files: files.map(({ bytes, ...record }) => record), deferred: recipe.deferred } };
}

export function applyToolingCopyPlan(plan, { root = defaultRoot, write = false, provenancePath = TOOLING_FORK_PATH } = {}) {
  const outputs = [...plan.files.map(file => ({ path: file.destinationPath, bytes: file.bytes })), { path: provenancePath, bytes: Buffer.from(serialize(plan.provenance)) }];
  const pending = [], seen = new Set();
  for (const output of outputs) {
    if (seen.has(output.path.toLowerCase())) throw new Error(`Conflicting tooling output: ${output.path}`);
    seen.add(output.path.toLowerCase());
    const absolute = safePath(root, output.path);
    if (fs.existsSync(absolute)) {
      if (!fs.statSync(absolute).isFile() || !fs.readFileSync(absolute).equals(output.bytes)) throw new Error(`Tooling destination differs: ${output.path}`);
    } else if (!write) throw new Error(`Missing tooling destination: ${output.path}`);
    else pending.push({ ...output, absolute });
  }
  const created = [];
  try {
    for (const output of pending) {
      fs.mkdirSync(path.dirname(output.absolute), { recursive: true });
      fs.writeFileSync(output.absolute, output.bytes, { flag: 'wx' }); created.push(output.absolute);
    }
    for (const output of outputs) if (!fs.readFileSync(safePath(root, output.path)).equals(output.bytes)) throw new Error(`Tooling verification failed: ${output.path}`);
  } catch (error) { for (const absolute of created.reverse()) fs.unlinkSync(absolute); throw error; }
  return plan.provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--write', '--check'].includes(args[0])) throw new Error('Usage: tooling-copy.mjs --write|--check');
    const result = applyToolingCopyPlan(createToolingCopyPlan(), { write: args[0] === '--write' });
    console.log(JSON.stringify({ status: 'passed', mode: args[0], files: result.files.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
