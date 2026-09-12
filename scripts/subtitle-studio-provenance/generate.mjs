import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BASELINE_PATH, POLICY, SOURCE_COMMIT } from './policy.mjs';

const posix = path.posix;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (name, prefix) => prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix;
const codeFile = name => /\.(?:[cm]?[jt]sx?)$/.test(name);

export function serialize(value) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort(cmp).map(key => [key, sorted(value[key])])) : value;
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

function git(root, args, input) {
  const result = spawnSync('git', ['-C', root, ...args], { input, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function safePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || posix.normalize(name) !== name || name.split('/').includes('..')) {
    throw new Error(`Invalid repository path: ${name}`);
  }
  return name;
}

function selectRule(name, policy) {
  const rule = policy.rules.find(rule => rule.source === name)
    ?? policy.rules.filter(rule => rule.prefix && name.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!rule) throw new Error(`Unaudited source classification: ${name}`);
  return rule;
}

function inspectModule(name, sourceText) {
  const source = ts.createSourceFile(name, sourceText, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse source ${name}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')}`);
  const edges = [];
  const loaders = new Set(['require']);
  const createRequireNames = new Set(['createRequire']);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'node:module') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === 'createRequire') createRequireNames.add(item.name.text);
      }
    }
  }
  const isFactory = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && createRequireNames.has(node.expression.text);
  function findLoaders(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFactory(node.initializer)) loaders.add(node.name.text);
    ts.forEachChild(node, findLoaders);
  }
  findLoaders(source);
  function add(node, argument, kind, typeOnly = false) {
    const literal = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
    edges.push({ kind, typeOnly, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      specifier: literal ? argument.text : null, expression: node.getText(source), dynamic: !literal });
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const named = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const allNamedTypes = named && (ts.isNamedImports(named) || ts.isNamedExports(named)) && named.elements.length > 0
        && named.elements.every(item => item.isTypeOnly) && !node.importClause?.name;
      add(node, node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export', Boolean(node.isTypeOnly || node.importClause?.isTypeOnly || allNamedTypes));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, 'import-equals', Boolean(node.isTypeOnly));
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null, 'import-type', true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments.length === 1 ? node.arguments[0] : null, 'dynamic-import');
      else if ((ts.isIdentifier(node.expression) && loaders.has(node.expression.text)) || isFactory(node.expression)) add(node, node.arguments.length === 1 ? node.arguments[0] : null, 'require');
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
      && node.arguments?.length === 2 && node.arguments[1].getText(source) === 'import.meta.url') {
      add(node, node.arguments[0], 'relative-url');
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return { source, edges };
}

function resolveLocal(from, specifier, tree) {
  const base = specifier.startsWith('@/') ? posix.join('src', specifier.slice(2)) : posix.join(posix.dirname(from), specifier);
  safePath(base);
  const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'].map(suffix => base + suffix)];
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.[cm]?js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  const resolved = candidates.find(candidate => tree.has(candidate));
  if (!resolved) throw new Error(`Unresolved relative dependency: ${from} -> ${specifier}`);
  return resolved;
}

function snapshotSymbols(specifications, getModule) {
  const values = new Map();
  const snapshots = [];
  const evaluate = node => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return evaluate(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error('Unsupported snapshot object property');
      return [property.name.text, evaluate(property.initializer)];
    }));
    if (ts.isIdentifier(node) && values.has(node.text)) return values.get(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const object = evaluate(node.expression);
      if (object && Object.hasOwn(object, node.name.text)) return object[node.name.text];
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -evaluate(node.operand);
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left), right = evaluate(node.right);
      if (typeof left !== 'number' || typeof right !== 'number') throw new Error('Non-numeric snapshot expression');
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
      if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    }
    throw new Error(`Unsupported static snapshot expression: ${node.getText()}`);
  };
  for (const specification of specifications) {
    const source = getModule(specification.source).source;
    for (const symbol of specification.symbols) {
      let declaration;
      for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
        declaration ??= statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === symbol);
      }
      if (!declaration?.initializer) throw new Error(`Missing default snapshot: ${specification.source}#${symbol}`);
      const value = evaluate(declaration.initializer);
      values.set(symbol, value);
      snapshots.push({ sourcePath: specification.source, symbol, line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1, expression: declaration.initializer.getText(source), value });
    }
  }
  return snapshots;
}

export function generateBaseline({ root = process.cwd(), sourceCommit = SOURCE_COMMIT, policy = POLICY } = {}) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceCommit)) throw new Error('sourceCommit must be a full Git commit object ID');
  const resolvedCommit = git(root, ['rev-parse', '--verify', `${sourceCommit}^{commit}`]).toString().trim();
  if (resolvedCommit !== sourceCommit) throw new Error('sourceCommit must identify a commit, not a tag');
  const tree = new Map(git(root, ['ls-tree', '-r', '-z', sourceCommit]).toString().split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t'), [mode, type, oid] = record.slice(0, tab).split(' '), name = record.slice(tab + 1);
    safePath(name);
    return [name, { mode, type, oid }];
  }));
  const cache = new Map(), modules = new Map();
  const read = name => {
    if (!cache.has(name)) {
      const entry = tree.get(name);
      if (!entry) throw new Error(`Missing source: ${name}`);
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Non-regular source: ${name}`);
      cache.set(name, git(root, ['cat-file', 'blob', entry.oid]));
    }
    return cache.get(name);
  };
  const getModule = name => {
    if (!modules.has(name)) modules.set(name, inspectModule(name, read(name).toString('utf8')));
    return modules.get(name);
  };
  const packageJson = tree.has('package.json') ? JSON.parse(read('package.json')) : {};
  const packages = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {}), ...(policy.externalPackages ?? [])]);
  const included = new Set(), edges = [], destinations = new Map(), files = [];
  const queue = [];
  const enqueue = name => { if (!included.has(name)) { included.add(name); queue.push(name); } };
  for (const selection of policy.roots) {
    const names = [...tree.keys()].filter(name => matches(name, selection));
    if (!names.length) throw new Error(`Missing selected source: ${selection}`);
    names.forEach(enqueue);
  }
  const auditHits = new Set();
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index], rule = selectRule(name, policy), bytes = read(name);
    let destination = rule.destination === null ? null : rule.source ? rule.destination : rule.destination + name.slice(rule.prefix.length);
    if (destination && rule.renameBasename) destination = posix.join(posix.dirname(destination), posix.basename(destination).replace(rule.renameBasename.from, rule.renameBasename.to));
    if (destination !== null) {
      safePath(destination);
      if (destinations.has(destination.toLowerCase())) throw new Error(`Conflicting destination: ${destination} from ${name} and ${destinations.get(destination.toLowerCase())}`);
      destinations.set(destination.toLowerCase(), name);
    }
    files.push({ sourcePath: name, blobOid: tree.get(name).oid, gitMode: tree.get(name).mode, sha256: sha256(bytes), byteSize: bytes.length,
      category: rule.category, disposition: rule.disposition, plannedDestination: destination, reason: rule.reason });
    const follow = rule.follow !== false;
    if (codeFile(name)) for (const edge of getModule(name).edges) {
      const record = { sourcePath: name, ...edge, resolvedPath: null };
      if (edge.dynamic) {
        const auditIndex = (policy.dynamicAudits ?? []).findIndex(audit => audit.source === name && audit.expression === edge.expression);
        if (auditIndex < 0) throw new Error(`Unaudited dynamic dependency: ${name}:${edge.line}: ${edge.expression}`);
        const audit = policy.dynamicAudits[auditIndex];
        if (audit.sourceSha256 !== sha256(bytes)) throw new Error(`Dynamic audit source changed: ${name}; review the loader and its path construction again`);
        auditHits.add(auditIndex);
        record.resolution = 'audited-dynamic'; record.auditReason = audit.reason; record.auditedTargets = audit.targets;
        for (const target of audit.targets) { read(target); if (follow) enqueue(target); }
      } else if (edge.kind === 'relative-url' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(edge.specifier)) {
        record.resolution = 'external-url';
      } else if (edge.kind === 'relative-url' || edge.specifier.startsWith('.') || edge.specifier.startsWith('@/')) {
        record.resolvedPath = resolveLocal(name, edge.specifier, tree);
        record.resolution = follow ? 'tracked-source' : 'reference-boundary';
        if (follow) enqueue(record.resolvedPath);
      } else {
        const packageName = edge.specifier.startsWith('@') ? edge.specifier.split('/').slice(0, 2).join('/') : edge.specifier.split('/')[0];
        if (!isBuiltin(edge.specifier) && !packages.has(packageName)) throw new Error(`Unaudited external package: ${name} -> ${edge.specifier}`);
        record.resolution = isBuiltin(edge.specifier) ? 'node-builtin' : 'external-package';
      }
      edges.push(record);
    }
    for (const reference of policy.runtimeReferences ?? []) if (reference.source === name) {
      const targets = reference.prefix ? [...tree.keys()].filter(target => matches(target, reference.prefix)) : reference.targets;
      if (!targets.length) throw new Error(`Missing audited runtime sources for ${name}`);
      for (const target of targets) {
        read(target); if (follow) enqueue(target);
        edges.push({ sourcePath: name, kind: 'audited-runtime-resource', resolvedPath: target, reason: reference.reason });
      }
    }
  }
  for (let i = 0; i < (policy.dynamicAudits ?? []).length; i++) {
    if (!auditHits.has(i)) throw new Error(`Stale dynamic audit: ${policy.dynamicAudits[i].source}: ${policy.dynamicAudits[i].expression}`);
  }
  for (const audit of policy.manualAudits ?? []) for (const name of audit.sources) {
    if (!included.has(name)) throw new Error(`Manual audit source not included: ${name}`);
  }
  const snapshots = snapshotSymbols(policy.snapshots ?? [], getModule);
  const resourceSnapshots = files.filter(file => file.sourcePath.startsWith('resources/local-subtitle/') && file.sourcePath.endsWith('.json'))
    .map(file => ({ sourcePath: file.sourcePath, blobOid: file.blobOid, sha256: file.sha256, value: JSON.parse(read(file.sourcePath)) }));
  const excludedFiles = [...tree.keys()].filter(name => !included.has(name) && (policy.excludedScopes ?? []).some(scope => matches(name, scope.prefix)))
    .map(sourcePath => ({ sourcePath, plannedDestination: null, reason: policy.excludedScopes.find(scope => matches(sourcePath, scope.prefix)).reason }));
  return {
    schemaVersion: 1, sourceCommit, byteIdentity: 'Git blob bytes (not platform checkout bytes)',
    policy, policySha256: sha256(serialize(policy)), files: files.sort((a, b) => cmp(a.sourcePath, b.sourcePath)),
    dependencies: edges.sort((a, b) => cmp(serialize(a), serialize(b))),
    defaultSnapshots: snapshots, resourceSnapshots: resourceSnapshots.sort((a, b) => cmp(a.sourcePath, b.sourcePath)),
    excludedFiles: excludedFiles.sort((a, b) => cmp(a.sourcePath, b.sourcePath)),
  };
}

export function checkBaseline({ root = process.cwd(), baselinePath = BASELINE_PATH, sourceCommit = SOURCE_COMMIT, policy = POLICY } = {}) {
  const actual = fs.readFileSync(path.resolve(root, baselinePath), 'utf8');
  const manifest = JSON.parse(actual);
  if (manifest.sourceCommit !== sourceCommit) throw new Error('Baseline sourceCommit differs from the explicitly selected fixed commit');
  const expected = generateBaseline({ root, sourceCommit, policy });
  if (actual !== serialize(expected)) throw new Error('Baseline differs from fixed-commit reconstruction (content, selection, policy or formatting was changed)');
  return expected;
}

function assertRegularWorktreePath(root, name) {
  let current = root;
  for (const piece of safePath(name).split('/')) {
    current = path.join(current, piece);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Worktree symlink: ${name}`);
  }
  if (!fs.statSync(current).isFile()) throw new Error(`Worktree source is not a file: ${name}`);
}

export function checkWorktree({ root = process.cwd(), baselinePath = BASELINE_PATH, sourceCommit = SOURCE_COMMIT, policy = POLICY } = {}) {
  const manifest = checkBaseline({ root, baselinePath, sourceCommit, policy });
  const errors = [];
  const registered = new Set(manifest.files.map(file => file.sourcePath));
  const currentPaths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  for (const name of new Set(currentPaths)) if (!registered.has(name) && policy.roots.some(selection => matches(name, selection))) errors.push(`Added selected source: ${name}`);
  for (const file of manifest.files) {
    try {
      assertRegularWorktreePath(root, file.sourcePath);
      // Git performs its own CRLF/encoding normalization. Refuse external clean
      // filters first so this read-only check cannot execute repository filters.
      const attributes = git(root, ['check-attr', '-z', 'filter', '--', file.sourcePath]).toString().split('\0');
      if (!['unspecified', 'unset'].includes(attributes[2])) throw new Error(`Unsupported clean filter on ${file.sourcePath}`);
      const oid = git(root, ['hash-object', `--path=${file.sourcePath}`, '--stdin'], fs.readFileSync(path.join(root, file.sourcePath))).toString().trim();
      if (oid !== file.blobOid) errors.push(`Changed source: ${file.sourcePath}`);
    } catch (error) {
      errors.push(error.code === 'ENOENT' ? `Deleted source: ${file.sourcePath}` : error.message);
    }
  }
  if (errors.length) throw new Error(`Worktree drift:\n${errors.sort(cmp).join('\n')}`);
  return manifest;
}

function main(args) {
  let mode = 'check', baselinePath = BASELINE_PATH, sourceCommit = SOURCE_COMMIT, root = process.cwd();
  let selectedMode = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (['--write', '--check', '--check-worktree'].includes(argument)) {
      if (selectedMode) throw new Error('Choose exactly one of --write, --check, --check-worktree');
      selectedMode = true; mode = argument.slice(2);
      if (args[i + 1] && !args[i + 1].startsWith('--')) baselinePath = args[++i];
      else if (mode === 'write') throw new Error('--write requires an explicit output path');
    } else if (argument === '--source-commit' || argument === '--root') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--source-commit') sourceCommit = args[++i]; else root = path.resolve(args[++i]);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  let manifest;
  if (mode === 'write') {
    manifest = generateBaseline({ root, sourceCommit });
    const output = path.resolve(root, baselinePath);
    if (manifest.files.some(file => path.resolve(root, file.sourcePath) === output)) throw new Error('Refusing to overwrite an inventoried source file');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialize(manifest));
  } else manifest = (mode === 'check-worktree' ? checkWorktree : checkBaseline)({ root, baselinePath, sourceCommit });
  console.log(JSON.stringify({ mode, sourceCommit: manifest.sourceCommit, files: manifest.files.length, dependencies: manifest.dependencies.length, status: 'passed' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
