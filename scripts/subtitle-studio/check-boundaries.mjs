import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function checkBoundaries(root, extraRoots = []) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
  const errors = [];
  const visited = new Set();
  const code = /\.(?:[cm]?[jt]sx?)$/;
  const forbidden = name => config.forbidden.some(prefix => name.startsWith(prefix));
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
    if (!code.test(name)) return;
    const source = ts.createSourceFile(name, fs.readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    function dependency(specifier) {
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const resolved = localResolve(name, specifier);
        if (!resolved) { errors.push(`Unresolved dependency: ${name} -> ${specifier}`); return; }
        const target = path.relative(root, resolved).replaceAll('\\', '/');
        if (target.startsWith('../')) { errors.push(`Outside repository: ${name} -> ${target}`); return; }
        if (![...config.roots, ...config.infrastructure].some(prefix => target === prefix || target.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) && !forbidden(target)) errors.push(`Unaudited infrastructure: ${name} -> ${target}`);
        visit(target, [...trail, name]);
      } else if (!specifier.startsWith('node:') && !config.packages.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) errors.push(`Unaudited package: ${name} -> ${specifier}`);
    }
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependency(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
        else errors.push(`Non-literal dependency: ${name}`);
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) && config.forbiddenStrings.some(value => node.text.includes(value))) errors.push(`Forbidden runtime string: ${name}: ${node.text}`);
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  [...config.roots, ...extraRoots].forEach(name => visit(name));
  return { files: visited.size, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkBoundaries(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.errors.length ? 1 : 0;
}
