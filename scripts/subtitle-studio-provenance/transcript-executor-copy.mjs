import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { applyCopyPlan, createCopyPlan } from './copy.mjs';
import { serialize } from './generate.mjs';

export const TRANSCRIPT_EXECUTOR_PROVENANCE_PATH = 'resources/subtitle-studio/provenance/transcription-executor-fork.json';
export const TRANSCRIPT_EXECUTOR_RECIPE = JSON.parse(fs.readFileSync(new URL('./transcript-executor-recipe.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new Error(`Unsafe derived executor path: ${value}`);
  return value;
}

/** Pure, exact derivation. Every surviving relative import still names its T02 target. */
export function deriveTranscriptExecutor({ sourceBytes, recipe = TRANSCRIPT_EXECUTOR_RECIPE, availableDestinations }) {
  safeRelative(recipe.sourcePath); safeRelative(recipe.destinationPath);
  if (recipe.sourcePath.toLowerCase() === recipe.destinationPath.toLowerCase()) throw new Error('Derived executor cannot replace its frozen source');
  if (hash(sourceBytes) !== recipe.sourceSha256) throw new Error('Derived executor source hash differs');
  let text = sourceBytes.toString('utf8');
  const transforms = [];
  for (const edit of recipe.literalEdits) {
    if (!edit.fromText || typeof edit.toText !== 'string' || edit.fromText === edit.toText || !Number.isInteger(edit.count) || edit.count < 1 || !edit.reason) throw new Error('Invalid derived executor transformation');
    const count = text.split(edit.fromText).length - 1;
    if (count !== edit.count) throw new Error(`Derived executor exact text differs: ${edit.reason}`);
    text = text.split(edit.fromText).join(edit.toText);
    transforms.push({ kind: 'exact-text', ...edit });
  }
  const ast = ts.createSourceFile(recipe.sourcePath, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error('Derived executor is not valid TypeScript');
  const available = new Set(availableDestinations), imports = [], dependencies = [];
  for (const statement of ast.statements) if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) throw new Error('Computed derived executor import');
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(recipe.sourcePath), specifier));
    const target = [base, base + '.ts', base + '.tsx', base + '.json', base + '/index.ts'].find(value => available.has(value));
    if (!target) throw new Error(`Unrecorded derived executor dependency: ${specifier}`);
    let replacement = path.posix.relative(path.posix.dirname(recipe.destinationPath), base);
    if (!replacement.startsWith('.')) replacement = './' + replacement;
    imports.push({ start: statement.moduleSpecifier.getStart(ast), end: statement.moduleSpecifier.end, text: JSON.stringify(replacement) });
    dependencies.push({ destinationPath: target, specifier: replacement, typeOnly: ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly === true });
    transforms.push({ kind: 'relative-import', from: specifier, to: replacement, destinationPath: target });
  }
  for (const edit of imports.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { bytes: Buffer.from(text), transforms, dependencies };
}

export function createTranscriptExecutorPlan({ root = process.cwd() } = {}) {
  const copy = createCopyPlan({ root });
  // The entire T02 output, provenance and source worktree remain exact; do not
  // accept a hand-edited executor merely because a new recipe hash matches it.
  applyCopyPlan(copy, { root });
  const recipe = TRANSCRIPT_EXECUTOR_RECIPE;
  if (recipe.sourceCommit !== copy.baseline.sourceCommit) throw new Error('Derived executor source commit differs');
  const source = copy.files.find(file => file.destinationPath === recipe.sourcePath);
  if (!source) throw new Error('Derived executor source is absent from T02');
  const derived = deriveTranscriptExecutor({ sourceBytes: source.bytes, recipe, availableDestinations: copy.files.map(file => file.destinationPath) });
  const t02 = copy.provenance.files.find(file => file.destinationPath === recipe.sourcePath);
  const file = { sourcePath: recipe.sourcePath, destinationPath: recipe.destinationPath, sourceBytes: source.bytes, bytes: derived.bytes, transforms: derived.transforms };
  return { baseline: copy.baseline, files: [file], provenance: {
    schemaVersion: 1, status: 'transcript-executor-derived-unregistered', sourceCommit: copy.baseline.sourceCommit,
    sourceProvenancePath: recipe.sourceProvenancePath, sourceProvenanceSha256: hash(serialize(copy.provenance)),
    recipeSha256: hash(serialize(recipe)), files: [{ sourcePath: source.sourcePath, sourceBlobOid: t02.sourceBlobOid,
      sourceSha256: t02.sourceSha256, intermediatePath: recipe.sourcePath, intermediateSha256: hash(source.bytes),
      destinationPath: recipe.destinationPath, destinationSha256: hash(derived.bytes), byteSize: derived.bytes.length, transforms: derived.transforms }],
    dependencies: derived.dependencies.map(dependency => ({ ...dependency, destinationSha256: copy.provenance.files.find(file => file.destinationPath === dependency.destinationPath).destinationSha256 })),
    scope: { inferenceChanged: false, fileExportEnabled: false, documentPersistenceEnabled: false, taskAdmissionEnabled: false },
  } };
}
export function applyTranscriptExecutorPlan(plan, options = {}) {
  return applyCopyPlan(plan, { provenancePath: TRANSCRIPT_EXECUTOR_PROVENANCE_PATH, ...options });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !['--write', '--check'].includes(args[0])) throw new Error('Usage: node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs [--check|--write]');
    const plan = createTranscriptExecutorPlan();
    applyTranscriptExecutorPlan(plan, { write: args[0] === '--write' });
    console.log(JSON.stringify({ status: 'passed', files: plan.files.length, dependencies: plan.provenance.dependencies.length, sourceCommit: plan.baseline.sourceCommit }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
