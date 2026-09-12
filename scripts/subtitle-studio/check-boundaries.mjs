import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

export function checkBoundaries(root, extraRoots = []) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
  const errors = [];
  const visited = new Set();
  const code = /\.(?:[cm]?[jt]sx?)$/;
  const forbidden = name => config.forbidden.some(prefix => name.startsWith(prefix));
  const forbiddenValue = value => [...config.forbiddenStrings, ...config.forbidden].some(part => value.includes(part));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const localResolve = (from, specifier) => {
    const base = specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2)) : path.resolve(path.dirname(path.join(root, from)), specifier);
    return [base, ...['.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx'].map(ext => base + ext)].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  };
  function visit(name, trail = []) {
    name = name.replaceAll('\\', '/');
    if (forbidden(name)) { errors.push(`Forbidden dependency: ${[...trail, name].join(' -> ')}`); return; }
    if (visited.has(name)) return;
    visited.add(name);
    const absolute = path.join(root, name);
    if (!fs.existsSync(absolute)) return;
    if (fs.lstatSync(absolute).isSymbolicLink()) { errors.push(`Symlink: ${name}`); return; }
    if (fs.statSync(absolute).isDirectory()) {
      for (const child of fs.readdirSync(absolute)) visit(`${name.replace(/\/$/, '')}/${child}`, trail);
      return;
    }
    const bytes = fs.readFileSync(absolute);
    const sourceHash = digest(bytes);
    const sourceAudit = (config.auditedSources ?? []).find(audit => audit.source === name);
    if (sourceAudit && sourceAudit.sha256 !== sourceHash) errors.push(`Audited source changed: ${name}`);
    if (name.startsWith('native/') && /\.(?:cc|cpp|c|h|hpp|gyp)$/.test(name)) {
      if (!sourceAudit) errors.push(`Unaudited native source: ${name}`);
      return;
    }
    if (name.endsWith('.json') && name !== 'scripts/subtitle-studio/boundaries.json') {
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); }
      catch { errors.push(`Invalid JSON: ${name}`); return; }
      const evidence = (config.immutableEvidence ?? []).find(audit => audit.source === name);
      if (evidence) {
        if (evidence.sha256 !== sourceHash) errors.push(`Immutable evidence changed: ${name}`);
        return;
      }
      function inspect(value) {
        if (typeof value === 'string' && forbiddenValue(value)) errors.push(`Forbidden resource string: ${name}: ${value}`);
        else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
      }
      inspect(value);
      return;
    }
    if (!code.test(name)) return;
    const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const factories = new Set();
    const moduleNamespaces = new Set();
    const loaders = new Set(['require']);
    const loaderAudits = (config.dynamicAudits ?? []).filter(audit => audit.source === name);
    const auditCounts = new Map(loaderAudits.map(audit => [audit, 0]));
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !['node:module', 'module'].includes(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) if ((binding.propertyName ?? binding.name).text === 'createRequire') factories.add(binding.name.text);
      } else if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text);
      if (statement.importClause?.name) moduleNamespaces.add(statement.importClause.name.text);
    }
    function unwrap(node) {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
      return node;
    }
    const factory = value => {
      const node = unwrap(value);
      return (ts.isIdentifier(node) && factories.has(node.text)) || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && moduleNamespaces.has(node.expression.text) && node.name.text === 'createRequire');
    };
    const loader = value => {
      const node = unwrap(value);
      return (ts.isIdentifier(node) && loaders.has(node.text)) || (ts.isCallExpression(node) && factory(node.expression)) || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ['module', 'globalThis'].includes(node.expression.text) && node.name.text === 'require');
    };
    // Track named createRequire results and simple aliases, including aliases
    // declared before their target. Access to node:module also requires a
    // source-hash audit, so unsupported factory syntax cannot bypass review.
    let changed = true;
    while (changed) {
      changed = false;
      function collect(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          for (const [predicate, set] of [[factory, factories], [loader, loaders]]) {
            if (predicate(node.initializer) && !set.has(node.name.text)) { set.add(node.name.text); changed = true; }
          }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
          for (const [predicate, set] of [[factory, factories], [loader, loaders]]) {
            if (predicate(node.right) && !set.has(node.left.text)) { set.add(node.left.text); changed = true; }
          }
        }
        ts.forEachChild(node, collect);
      }
      collect(source);
    }
    function dependency(specifier) {
      if (['node:module', 'module'].includes(specifier) && sourceAudit?.sha256 !== sourceHash && !loaderAudits.some(audit => audit.sha256 === sourceHash)) errors.push(`Unaudited module loader factory: ${name}`);
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const resolved = localResolve(name, specifier);
        if (!resolved) { errors.push(`Unresolved dependency: ${name} -> ${specifier}`); return; }
        const target = path.relative(root, resolved).replaceAll('\\', '/');
        if (target.startsWith('../')) { errors.push(`Outside repository: ${name} -> ${target}`); return; }
        if (![...config.roots, ...config.infrastructure].some(prefix => target === prefix || target.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) && !forbidden(target)) errors.push(`Unaudited infrastructure: ${name} -> ${target}`);
        visit(target, [...trail, name]);
      } else if (!specifier.startsWith('node:') && !config.packages.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))
        && !(config.scopedPackages ?? []).some(audit => audit.source === name && audit.package === specifier)) errors.push(`Unaudited package: ${name} -> ${specifier}`);
    }
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || loader(node.expression))) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
        else {
          const audit = loaderAudits.find(item => item.expression === node.getText(source));
          if (!audit || audit.sha256 !== sourceHash) errors.push(`Non-literal dependency: ${name}`);
          if (audit) auditCounts.set(audit, auditCounts.get(audit) + 1);
        }
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) && forbiddenValue(node.text)) errors.push(`Forbidden runtime string: ${name}: ${node.text}`);
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const [audit, count] of auditCounts) {
      if (audit.sha256 !== sourceHash || count !== audit.count) errors.push(`Dynamic dependency audit changed: ${name}`);
    }
  }
  [...config.roots, ...extraRoots].forEach(name => visit(name));
  return { files: visited.size, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkBoundaries(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.errors.length ? 1 : 0;
}
