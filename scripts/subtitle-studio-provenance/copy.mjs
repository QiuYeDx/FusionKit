import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BASELINE_PATH, POLICY as BASELINE_POLICY } from './policy.mjs';
import { checkBaseline, serialize } from './generate.mjs';
import { COPY_POLICY, FORK_PATH } from './copy-policy.mjs';
import { readSharedResourceIntegrationAudits } from './shared-resource-integration.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const moduleExtension = /\.[cm]?[jt]sx?$/;
const literalEditsPath = fileURLToPath(new URL('./copy-literals.json', import.meta.url));
const jsonEditsPath = fileURLToPath(new URL('./copy-json.json', import.meta.url));
export const COMPOSITION_AUDIT_PATH = 'scripts/subtitle-studio-provenance/current-composition-audits.json';

function gitRead(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 128 * 1024 * 1024, timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

export function checkCopyWorktree(root, baseline, policy = BASELINE_POLICY) {
  const compositionAudits = readCompositionAudits(root, baseline);
  const sharedIntegrationAudits = readSharedResourceIntegrationAudits(root, baseline);
  const errors = [], registered = new Set(baseline.files.map(file => file.sourcePath));
  const current = gitRead(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  for (const name of new Set(current)) if (!registered.has(name) && !sharedIntegrationAudits.has(name) && policy.roots.some(selection => selection.endsWith('/') ? name.startsWith(selection) : name === selection)) errors.push(`Added selected source: ${name}`);
  for (const file of baseline.files) {
    try {
      let absolute = root;
      for (const part of relativePath(file.sourcePath).split('/')) {
        absolute = path.join(absolute, part);
        if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Worktree symlink: ${file.sourcePath}`);
      }
      if (!fs.statSync(absolute).isFile()) throw new Error(`Worktree source is not a file: ${file.sourcePath}`);
      const attributes = gitRead(root, ['check-attr', '-z', 'filter', '--', file.sourcePath]).toString().split('\0');
      if (!['unspecified', 'unset'].includes(attributes[2])) throw new Error(`Unsupported clean filter on ${file.sourcePath}`);
      // Read directly from the checked file: large spawnSync stdin pipes can hang
      // on this host. Git still owns canonical CRLF/encoding normalization.
      const oid = gitRead(root, ['hash-object', `--path=${file.sourcePath}`, '--', file.sourcePath]).toString().trim();
      const compositionAudit = compositionAudits.get(file.sourcePath) ?? sharedIntegrationAudits.get(file.sourcePath);
      if (compositionAudit ? oid !== compositionAudit.currentBlobOid : oid !== file.blobOid) {
        errors.push(`${compositionAudit ? 'Changed audited composition source' : 'Changed source'}: ${file.sourcePath}`);
      }
    } catch (error) { errors.push(error.code === 'ENOENT' ? `Deleted source: ${file.sourcePath}` : error.message); }
  }
  if (errors.length) throw new Error(`Worktree drift:\n${errors.sort(compare).join('\n')}`);
}

function readCompositionAudits(root, baseline) {
  let absolute = root;
  for (const part of COMPOSITION_AUDIT_PATH.split('/')) {
    absolute = path.join(absolute, part);
    if (!fs.existsSync(absolute)) return new Map();
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Composition audit path is a symlink');
  }
  const document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exactKeys(document, ['schemaVersion', 'sourceCommit', 'entries']) || document.schemaVersion !== 1
    || document.sourceCommit !== baseline.sourceCommit || !Array.isArray(document.entries)) throw new Error('Composition audit header differs');
  const audits = new Map();
  for (const audit of document.entries) {
    if (!exactKeys(audit, ['sourcePath', 'sourceBlobOid', 'sourceSha256', 'currentBlobOid', 'reason'])
      || typeof audit.reason !== 'string' || !audit.reason.trim()
      || !/^[a-f0-9]{40}$/.test(audit.currentBlobOid)) throw new Error('Invalid composition audit entry');
    const sourcePath = relativePath(audit.sourcePath);
    const source = baseline.files.find(file => file.sourcePath === sourcePath);
    // Only explicitly inventoried application-composition evidence can evolve.
    // Copied v1 code, build inputs and the frozen replay graph retain their pins.
    if (!source || source.category !== 'application-composition' || source.disposition !== 'reference-only'
      || source.plannedDestination !== null) throw new Error(`Composition audit is not reference-only application evidence: ${sourcePath}`);
    if (audits.has(sourcePath)) throw new Error(`Duplicate composition audit: ${sourcePath}`);
    if (audit.sourceBlobOid !== source.blobOid || audit.sourceSha256 !== source.sha256
      || audit.currentBlobOid === source.blobOid) throw new Error(`Stale composition audit source identity: ${sourcePath}`);
    audits.set(sourcePath, audit);
  }
  return audits;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value) || path.posix.normalize(value) !== value || value.split('/').includes('..')) throw new Error(`Unsafe copy path: ${value}`);
  return value;
}

export function selectCopySources(baseline, policy = COPY_POLICY) {
  const files = new Map(baseline.files.map(file => [file.sourcePath, file]));
  const selected = new Set(policy.roots);
  for (const file of baseline.files) if (policy.includePrefixes.some(prefix => file.sourcePath.startsWith(prefix))) selected.add(file.sourcePath);
  for (const edge of baseline.dependencies) if (edge.sourcePath === policy.assemblySource && edge.resolvedPath?.startsWith(policy.productionPrefix)) selected.add(edge.resolvedPath);
  const queue = [...selected];
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    if (!files.has(source)) throw new Error(`Selected source missing from baseline: ${source}`);
    if (!files.get(source).plannedDestination) throw new Error(`Reference-only source cannot be copied: ${source}`);
    for (const edge of baseline.dependencies) if (edge.sourcePath === source) {
      const targets = [...(edge.resolvedPath ? [edge.resolvedPath] : []), ...(edge.auditedTargets ?? [])];
      for (const target of targets) if (!selected.has(target)) { selected.add(target); queue.push(target); }
    }
  }
  return [...selected].sort(compare).map(source => files.get(source));
}

function sourceSpecifiers(sourceFile) {
  const result = [];
  const add = node => { if (node && (ts.isStringLiteralLike(node))) result.push(node); else throw new Error(`Unaudited computed module path in ${sourceFile.fileName}`); };
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(sourceFile) === 'import.meta.url') add(node.arguments[0]);
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);
  return [...new Set(result)];
}

function quotedLike(node, value) {
  const quote = node.getText()[0];
  return quote === "'" ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : JSON.stringify(value);
}

function transformCode(file, text, baseline, mapping, literalEdits, textEdits) {
  const sourceFile = ts.createSourceFile(file.sourcePath, text, ts.ScriptTarget.Latest, true);
  if (sourceFile.parseDiagnostics.length) throw new Error(`Invalid source syntax: ${file.sourcePath}`);
  const edits = [];
  const specifiers = sourceSpecifiers(sourceFile);
  for (const node of specifiers) {
    const edge = baseline.dependencies.find(edge => edge.sourcePath === file.sourcePath && edge.specifier === node.text && edge.resolvedPath);
    if (!edge) {
      if (node.text.startsWith('.') || node.text.startsWith('@/')) throw new Error(`Missing dependency edge: ${file.sourcePath} -> ${node.text}`);
      continue;
    }
    const target = mapping.get(edge.resolvedPath);
    if (!target) throw new Error(`Missing destination dependency: ${file.sourcePath} -> ${edge.resolvedPath}`);
    let specifier = path.posix.relative(path.posix.dirname(file.plannedDestination), target);
    if (!path.posix.extname(node.text) && moduleExtension.test(specifier)) specifier = specifier.replace(moduleExtension, '');
    if (!specifier.startsWith('.')) specifier = `./${specifier}`;
    const from = node.getText(sourceFile), to = quotedLike(node, specifier);
    if (from !== to) edits.push({ start: node.getStart(sourceFile), end: node.end, from, to, kind: 'module-path', resolvedSource: edge.resolvedPath, resolvedDestination: target });
  }
  for (const edit of literalEdits.filter(edit => edit.sourcePath === file.sourcePath)) {
    const nodes = [];
    function walk(node) {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.getText(sourceFile) === edit.from) nodes.push(node);
      ts.forEachChild(node, walk);
    }
    walk(sourceFile);
    if (nodes.length !== edit.count) throw new Error(`Literal audit count changed: ${file.sourcePath}: ${edit.from}`);
    for (const node of nodes) edits.push({ start: node.getStart(sourceFile), end: node.end, from: edit.from, to: edit.to, kind: 'audited-identity', reason: edit.reason });
  }
  for (const edit of textEdits.filter(edit => edit.sourcePath === file.sourcePath)) {
    const positions = [...text.matchAll(new RegExp(edit.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(match => match.index);
    if (positions.length !== edit.count) throw new Error(`Text audit count changed: ${file.sourcePath}: ${edit.from}`);
    for (const start of positions) edits.push({ start, end: start + edit.from.length, from: edit.from, to: edit.to, kind: 'audited-test-location', reason: edit.reason });
  }
  edits.sort((a, b) => a.start - b.start);
  for (let index = 0; index < edits.length; index++) {
    if (edits[index].from !== text.slice(edits[index].start, edits[index].end) || index && edits[index - 1].end > edits[index].start) throw new Error(`Overlapping or invalid transformations: ${file.sourcePath}`);
  }
  let result = text;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.to + result.slice(edit.end);
  const parsed = ts.createSourceFile(file.plannedDestination, result, ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length) throw new Error(`Invalid generated syntax: ${file.plannedDestination}`);
  return { bytes: Buffer.from(result), transforms: edits };
}

function transformJson(file, bytes, jsonEdits) {
  const edits = jsonEdits.filter(edit => edit.sourcePath === file.sourcePath);
  if (!edits.length) return { bytes, transforms: [] };
  const value = JSON.parse(bytes.toString('utf8'));
  for (const edit of edits) {
    const segments = edit.pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    let parent = value;
    for (const segment of segments.slice(0, -1)) parent = parent?.[segment];
    const key = segments.at(-1);
    if (!parent || parent[key] !== edit.from) throw new Error(`JSON audit value changed: ${file.sourcePath}#${edit.pointer}`);
    parent[key] = edit.to;
  }
  return { bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), transforms: edits.map(({ pointer, from, to, reason }) => ({ kind: 'audited-manifest-field', pointer, from, to, reason })) };
}

export function createCopyPlan({ root = process.cwd(), baselinePath = BASELINE_PATH, sourceCommit, baselinePolicy, baseline: suppliedBaseline, policy = COPY_POLICY,
  literalEdits = JSON.parse(fs.readFileSync(literalEditsPath, 'utf8')), jsonEdits = JSON.parse(fs.readFileSync(jsonEditsPath, 'utf8')) } = {}) {
  const baseline = suppliedBaseline ?? checkBaseline({ root, baselinePath, sourceCommit, policy: baselinePolicy });
  if (!suppliedBaseline) checkCopyWorktree(root, baseline, baselinePolicy);
  const selected = selectCopySources(baseline, policy);
  const mapping = new Map(selected.map(file => [relativePath(file.sourcePath), relativePath(file.plannedDestination)]));
  const destinationSet = new Set();
  for (const destination of mapping.values()) {
    if (destinationSet.has(destination.toLowerCase())) throw new Error(`Conflicting destination: ${destination}`);
    if (mapping.has(destination)) throw new Error(`Destination overlaps source: ${destination}`);
    destinationSet.add(destination.toLowerCase());
  }
  for (const edit of [...literalEdits, ...jsonEdits, ...policy.textEdits]) if (!mapping.has(edit.sourcePath)) throw new Error(`Unused copy audit: ${edit.sourcePath}`);
  const files = selected.map(file => {
    const sourceBytes = gitRead(root, ['cat-file', 'blob', file.blobOid]);
    if (sourceBytes.length !== file.byteSize || sha256(sourceBytes) !== file.sha256) throw new Error(`Source identity differs: ${file.sourcePath}`);
    const transformed = moduleExtension.test(file.sourcePath)
      ? transformCode(file, sourceBytes.toString('utf8'), baseline, mapping, literalEdits, policy.textEdits)
      : transformJson(file, sourceBytes, jsonEdits);
    return { sourcePath: file.sourcePath, destinationPath: file.plannedDestination, sourceBytes, ...transformed };
  });
  const provenance = {
    schemaVersion: 1, sourceCommit: baseline.sourceCommit, sourceBaselineSha256: sha256(serialize(baseline)),
    copyPolicySha256: sha256(serialize({ policy, literalEdits, jsonEdits })), status: 'source-copy-unregistered',
    files: files.map(file => ({ sourcePath: file.sourcePath, sourceBlobOid: selected.find(source => source.sourcePath === file.sourcePath).blobOid,
      sourceSha256: sha256(file.sourceBytes), destinationPath: file.destinationPath, destinationSha256: sha256(file.bytes), byteSize: file.bytes.length, transforms: file.transforms })),
    deferred: policy.deferred,
    notCopied: baseline.files.filter(file => !mapping.has(file.sourcePath)).map(file => ({ sourcePath: file.sourcePath, disposition: file.disposition === 'reference-only' ? 'reference-only' : 'deferred', reason: file.disposition === 'reference-only' ? file.reason : 'Outside the T02 production/normal-regression closure; retain frozen provenance for the later resource/lifecycle stage.' })),
  };
  return { baseline, files, provenance };
}

function safeDestination(root, name) {
  const pieces = relativePath(name).split('/');
  let current = root;
  for (const piece of pieces) {
    current = path.join(current, piece);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink destination: ${name}`);
  }
  return current;
}

export function applyCopyPlan(plan, { root = process.cwd(), write = false, provenancePath = FORK_PATH } = {}) {
  const outputs = [...plan.files.map(file => ({ path: file.destinationPath, bytes: file.bytes })), { path: provenancePath, bytes: Buffer.from(serialize(plan.provenance)) }];
  const pending = [];
  // Complete preflight before the first write; a conflicting user edit is never reset.
  for (const output of outputs) {
    const absolute = safeDestination(root, output.path);
    if (fs.existsSync(absolute)) {
      if (!fs.statSync(absolute).isFile() || !fs.readFileSync(absolute).equals(output.bytes)) throw new Error(`Destination content differs: ${output.path}`);
    } else if (!write) throw new Error(`Missing destination: ${output.path}`);
    else pending.push({ ...output, absolute });
  }
  const created = [];
  try {
    for (const output of pending) {
      fs.mkdirSync(path.dirname(output.absolute), { recursive: true });
      fs.writeFileSync(output.absolute, output.bytes, { flag: 'wx' });
      created.push(output.absolute);
    }
    for (const output of outputs) if (!fs.readFileSync(safeDestination(root, output.path)).equals(output.bytes)) throw new Error(`Destination verification failed: ${output.path}`);
  } catch (error) {
    for (const absolute of created.reverse()) fs.unlinkSync(absolute);
    throw error;
  }
  return plan.provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !['--write', '--check'].includes(args[0])) throw new Error('Usage: node scripts/subtitle-studio-provenance/copy.mjs [--check|--write]');
    const plan = createCopyPlan();
    applyCopyPlan(plan, { write: args[0] === '--write' });
    console.log(JSON.stringify({ mode: args[0] === '--write' ? 'write' : 'check', files: plan.files.length, sourceCommit: plan.baseline.sourceCommit, status: 'passed' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
