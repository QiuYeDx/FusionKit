#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { I18N_USAGE_MANIFEST } from "./i18n-usage-manifest.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_NAMESPACE = "common";
const SOURCE_LANGUAGE = "zh";
const MAX_EXPANSIONS = 512;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function flattenEntries(value, prefix = "", entries = []) {
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      flattenEntries(child, fullKey, entries);
    } else {
      entries.push(fullKey);
    }
  }
  return entries;
}

export function canonicalizeI18nKey(rawKey, defaultNamespace = DEFAULT_NAMESPACE) {
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new Error("translation key must be a non-empty string");
  }

  const parts = rawKey.split(":");
  if (parts.length === 1) {
    if (!defaultNamespace) {
      throw new Error(`relative key has no statically known namespace: ${rawKey}`);
    }
    return `${defaultNamespace}:${rawKey}`;
  }

  const namespace = parts.shift();
  const key = parts.join(".");
  if (!namespace || !key) {
    throw new Error(`invalid namespaced translation key: ${rawKey}`);
  }
  return `${namespace}:${key}`;
}

function discoverLocaleCatalogs(localesDir) {
  const catalogs = new Map();
  const languages = fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      left === SOURCE_LANGUAGE
        ? -1
        : right === SOURCE_LANGUAGE
          ? 1
          : left.localeCompare(right),
    );

  for (const language of languages) {
    const languageDir = path.join(localesDir, language);
    const keys = new Set();
    for (const fileName of fs.readdirSync(languageDir).filter((name) => name.endsWith(".json"))) {
      const namespace = fileName.slice(0, -".json".length);
      const filePath = path.join(languageDir, fileName);
      const resource = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const key of flattenEntries(resource)) {
        keys.add(`${namespace}:${key}`);
      }
    }
    catalogs.set(language, keys);
  }

  return catalogs;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function addCartesian(left, right, join) {
  if (left.length * right.length > MAX_EXPANSIONS) return null;
  const values = [];
  for (const leftValue of left) {
    for (const rightValue of right) {
      values.push(join(leftValue, rightValue));
    }
  }
  return [...new Set(values)];
}

function finiteStringsFromType(type) {
  const parts = type.isUnion() ? type.types : [type];
  const values = [];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.Never) continue;
    if (!(part.flags & ts.TypeFlags.StringLiteral)) return null;
    values.push(part.value);
  }
  return values.length > 0 ? [...new Set(values)] : null;
}

function resolveAliasedSymbol(symbol, checker) {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declarationInitializer(symbol, checker) {
  const resolved = resolveAliasedSymbol(symbol, checker);
  const declaration = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  if (!declaration) return undefined;
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isBindingElement(declaration) ||
    ts.isEnumMember(declaration)
  ) {
    return declaration.initializer;
  }
  return undefined;
}

function propertyNameText(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function resolveObjectLiteral(node, checker) {
  const expression = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const initializer = declarationInitializer(checker.getSymbolAtLocation(expression), checker);
  return initializer ? resolveObjectLiteral(initializer, checker) : undefined;
}

function evaluateStringExpression(node, checker, seen = new Set()) {
  if (!node) return { values: null, reason: "missing expression" };
  const expression = unwrapExpression(node);
  if (seen.has(expression)) return { values: null, reason: "cyclic expression" };
  const nextSeen = new Set(seen).add(expression);

  if (ts.isStringLiteralLike(expression)) {
    return { values: [expression.text] };
  }

  const typeValues = finiteStringsFromType(checker.getTypeAtLocation(expression));
  if (typeValues) return { values: typeValues };

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = evaluateStringExpression(expression.whenTrue, checker, nextSeen);
    const whenFalse = evaluateStringExpression(expression.whenFalse, checker, nextSeen);
    if (!whenTrue.values || !whenFalse.values) {
      return { values: null, reason: whenTrue.reason ?? whenFalse.reason };
    }
    return { values: [...new Set([...whenTrue.values, ...whenFalse.values])] };
  }

  if (ts.isTemplateExpression(expression)) {
    let values = [expression.head.text];
    for (const span of expression.templateSpans) {
      const spanValues = evaluateStringExpression(span.expression, checker, nextSeen);
      if (!spanValues.values) return spanValues;
      const combined = addCartesian(
        values,
        spanValues.values,
        (prefix, value) => `${prefix}${value}${span.literal.text}`,
      );
      if (!combined) {
        return { values: null, reason: `more than ${MAX_EXPANSIONS} expansions` };
      }
      values = combined;
    }
    return { values };
  }

  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const left = evaluateStringExpression(expression.left, checker, nextSeen);
    const right = evaluateStringExpression(expression.right, checker, nextSeen);
    if (!left.values || !right.values) {
      return { values: null, reason: left.reason ?? right.reason };
    }
    if (expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      return { values: [...new Set([...left.values, ...right.values])] };
    }
    const combined = addCartesian(left.values, right.values, (a, b) => a + b);
    return combined
      ? { values: combined }
      : { values: null, reason: `more than ${MAX_EXPANSIONS} expansions` };
  }

  if (ts.isArrayLiteralExpression(expression)) {
    const values = [];
    for (const element of expression.elements) {
      const result = evaluateStringExpression(element, checker, nextSeen);
      if (!result.values) return result;
      values.push(...result.values);
    }
    return { values: [...new Set(values)] };
  }

  if (ts.isElementAccessExpression(expression)) {
    const objectLiteral = resolveObjectLiteral(expression.expression, checker);
    const index = evaluateStringExpression(expression.argumentExpression, checker, nextSeen);
    if (objectLiteral && index.values) {
      const properties = new Map();
      for (const property of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyNameText(property.name);
        if (name !== undefined) properties.set(name, property.initializer);
      }
      const values = [];
      for (const indexValue of index.values) {
        const initializer = properties.get(indexValue);
        if (!initializer) {
          return { values: null, reason: `constant map has no ${indexValue} entry` };
        }
        const result = evaluateStringExpression(initializer, checker, nextSeen);
        if (!result.values) return result;
        values.push(...result.values);
      }
      return { values: [...new Set(values)] };
    }
  }

  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.arguments.length === 0 &&
    (expression.expression.name.text === "toLowerCase" ||
      expression.expression.name.text === "toUpperCase")
  ) {
    const receiver = evaluateStringExpression(expression.expression.expression, checker, nextSeen);
    if (!receiver.values) return receiver;
    return {
      values: receiver.values.map((value) =>
        expression.expression.name.text === "toLowerCase"
          ? value.toLowerCase()
          : value.toUpperCase(),
      ),
    };
  }

  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const initializer = declarationInitializer(checker.getSymbolAtLocation(expression), checker);
    if (initializer) return evaluateStringExpression(initializer, checker, nextSeen);
  }

  return {
    values: null,
    reason: `expression has non-finite type ${checker.typeToString(checker.getTypeAtLocation(expression))}`,
  };
}

function expressionFingerprint(node) {
  return node.getText().replace(/\s+/g, "");
}

function manifestSelector(relativeFile, argument) {
  return `${relativeFile}#${expressionFingerprint(argument)}`;
}

function prepareManifest(entries) {
  const bySelector = new Map();
  const errors = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push({ code: "INVALID_MANIFEST", message: "manifest entry must be an object" });
      continue;
    }
    const { selector, keys } = entry;
    if (typeof selector !== "string" || !selector.includes("#")) {
      errors.push({ code: "INVALID_MANIFEST", message: "manifest selector must be file#expression" });
      continue;
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      errors.push({ code: "INVALID_MANIFEST", message: `${selector} must list exact keys` });
      continue;
    }
    if (bySelector.has(selector)) {
      errors.push({ code: "INVALID_MANIFEST", message: `duplicate selector ${selector}` });
      continue;
    }
    const canonicalKeys = [];
    for (const key of keys) {
      if (typeof key !== "string" || !key.includes(":") || /[*${}]/.test(key)) {
        errors.push({
          code: "INVALID_MANIFEST",
          message: `${selector} contains non-exact key ${String(key)}`,
        });
        continue;
      }
      try {
        canonicalKeys.push(canonicalizeI18nKey(key, null));
      } catch (error) {
        errors.push({ code: "INVALID_MANIFEST", message: `${selector}: ${error.message}` });
      }
    }
    bySelector.set(selector, { ...entry, keys: [...new Set(canonicalKeys)] });
  }
  return { bySelector, errors };
}

function symbolForIdentifier(identifier, checker) {
  return identifier && ts.isIdentifier(identifier)
    ? checker.getSymbolAtLocation(identifier)
    : undefined;
}

function literalNamespaceFromTypeNode(typeNode) {
  let namespace;
  function visit(node) {
    if (namespace) return;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
      namespace = node.literal.text;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (typeNode) visit(typeNode);
  return namespace;
}

function hookConfiguration(call) {
  const namespaceNode = call.arguments[0];
  let defaultNamespace = DEFAULT_NAMESPACE;
  if (namespaceNode) {
    if (ts.isStringLiteralLike(namespaceNode)) {
      defaultNamespace = namespaceNode.text;
    } else if (
      ts.isArrayLiteralExpression(namespaceNode) &&
      namespaceNode.elements.length > 0 &&
      ts.isStringLiteralLike(namespaceNode.elements[0])
    ) {
      defaultNamespace = namespaceNode.elements[0].text;
    } else {
      defaultNamespace = null;
    }
  }

  let keyPrefix = "";
  const options = call.arguments[1];
  if (options && ts.isObjectLiteralExpression(options)) {
    const property = options.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === "keyPrefix",
    );
    if (property && ts.isPropertyAssignment(property)) {
      keyPrefix = ts.isStringLiteralLike(property.initializer)
        ? property.initializer.text
        : null;
    }
  }
  return { defaultNamespace, keyPrefix };
}

function collectTranslationBindings(sourceFile, checker) {
  const hookImportSymbols = new Set();
  const transImportSymbols = new Set();
  const i18nImportSymbols = new Set();
  const tBindings = new Map();
  const hookNamespaces = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (moduleName === "react-i18next" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const specifier of statement.importClause.namedBindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        const symbol = checker.getSymbolAtLocation(specifier.name);
        if (importedName === "useTranslation" && symbol) hookImportSymbols.add(symbol);
        if (importedName === "Trans" && symbol) transImportSymbols.add(symbol);
      }
    }
    if (moduleName === "@/i18n" && statement.importClause?.name) {
      const symbol = checker.getSymbolAtLocation(statement.importClause.name);
      if (symbol) i18nImportSymbols.add(symbol);
    }
  }

  function visitHooks(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      hookImportSymbols.has(checker.getSymbolAtLocation(node.initializer.expression))
    ) {
      const config = hookConfiguration(node.initializer);
      if (config.defaultNamespace) hookNamespaces.add(config.defaultNamespace);
      for (const element of node.name.elements) {
        const property = element.propertyName?.getText() ?? element.name.getText();
        if (property !== "t" || !ts.isIdentifier(element.name)) continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) tBindings.set(symbol, config);
      }
    }
    ts.forEachChild(node, visitHooks);
  }
  visitHooks(sourceFile);

  const fileNamespace = hookNamespaces.size === 1 ? [...hookNamespaces][0] : null;
  function visitHelpers(node) {
    if (
      ts.isParameter(node) &&
      node.type &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "t" || /TFunction|Translate/.test(node.type.getText()))
    ) {
      const type = checker.getTypeAtLocation(node);
      if (type.getCallSignatures().length > 0) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) {
          tBindings.set(symbol, {
            defaultNamespace: literalNamespaceFromTypeNode(node.type) ?? fileNamespace,
            keyPrefix: "",
          });
        }
      }
    }
    if (ts.isParameter(node) && node.type && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const property = element.propertyName?.getText() ?? element.name.getText();
        if (property !== "t" || !ts.isIdentifier(element.name)) continue;
        const type = checker.getTypeAtLocation(element.name);
        if (type.getCallSignatures().length === 0) continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) {
          tBindings.set(symbol, {
            defaultNamespace: literalNamespaceFromTypeNode(node.type) ?? fileNamespace,
            keyPrefix: "",
          });
        }
      }
    }
    ts.forEachChild(node, visitHelpers);
  }
  visitHelpers(sourceFile);

  return { i18nImportSymbols, tBindings, transImportSymbols };
}

function namespaceOverride(call) {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const property = options.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === "ns",
  );
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  const initializer = property.initializer;
  if (ts.isStringLiteralLike(initializer)) return initializer.text;
  if (
    ts.isArrayLiteralExpression(initializer) &&
    initializer.elements.length > 0 &&
    ts.isStringLiteralLike(initializer.elements[0])
  ) {
    return initializer.elements[0].text;
  }
  return null;
}

function locationFor(sourceFile, node, projectRoot) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: toPosix(path.relative(projectRoot, sourceFile.fileName)),
    line: position.line + 1,
    column: position.character + 1,
  };
}

function isTranslationCall(call, bindings, checker) {
  if (ts.isIdentifier(call.expression)) {
    const symbol = checker.getSymbolAtLocation(call.expression);
    const config = bindings.tBindings.get(symbol);
    return config ? { config, kind: "t" } : null;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "t" &&
    ts.isIdentifier(call.expression.expression)
  ) {
    const symbol = checker.getSymbolAtLocation(call.expression.expression);
    if (bindings.i18nImportSymbols.has(symbol)) {
      return { config: { defaultNamespace: DEFAULT_NAMESPACE, keyPrefix: "" }, kind: "i18n.t" };
    }
  }
  return null;
}

function findTransKeyAttribute(element) {
  return element.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "i18nKey",
  );
}

function analyzeSourceFile({
  sourceFile,
  checker,
  projectRoot,
  catalogs,
  manifestBySelector,
  usedManifest,
  errors,
  stats,
}) {
  const bindings = collectTranslationBindings(sourceFile, checker);
  const relativeFile = toPosix(path.relative(projectRoot, sourceFile.fileName));

  function resolveKeys(argument, config, node) {
    stats.translationCalls += 1;
    const evaluation = evaluateStringExpression(argument, checker);
    let rawKeys = evaluation.values;
    if (!rawKeys) {
      const selector = manifestSelector(relativeFile, argument);
      const manifestEntry = manifestBySelector.get(selector);
      if (!manifestEntry) {
        errors.push({
          code: "DYNAMIC_KEY",
          ...locationFor(sourceFile, node, projectRoot),
          message: `${argument.getText(sourceFile)} is not finite (${evaluation.reason}); add an exact manifest entry with selector ${selector}`,
        });
        return;
      }
      usedManifest.add(selector);
      rawKeys = manifestEntry.keys;
      stats.manifestCalls += 1;
    } else {
      stats.staticCalls += 1;
    }

    const override = ts.isCallExpression(node) ? namespaceOverride(node) : undefined;
    if (override === null) {
      errors.push({
        code: "DYNAMIC_NAMESPACE",
        ...locationFor(sourceFile, node, projectRoot),
        message: "translation call has a dynamic ns option",
      });
      return;
    }

    for (const rawKey of rawKeys) {
      let candidate = rawKey;
      if (!candidate.includes(":") && config.keyPrefix) {
        candidate = `${config.keyPrefix}.${candidate}`;
      }
      let canonicalKey;
      try {
        canonicalKey = candidate.includes(":") && manifestBySelector.has(manifestSelector(relativeFile, argument))
          ? canonicalizeI18nKey(candidate, null)
          : canonicalizeI18nKey(candidate, override ?? config.defaultNamespace);
      } catch (error) {
        errors.push({
          code: "INVALID_KEY",
          ...locationFor(sourceFile, node, projectRoot),
          message: error.message,
        });
        continue;
      }
      stats.resolvedKeys.add(canonicalKey);
      for (const [language, keys] of catalogs) {
        if (!keys.has(canonicalKey)) {
          errors.push({
            code: "MISSING_KEY",
            ...locationFor(sourceFile, node, projectRoot),
            key: canonicalKey,
            language,
            message: `${language} does not define ${canonicalKey}`,
          });
        }
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const translation = isTranslationCall(node, bindings, checker);
      if (translation) {
        const argument = node.arguments[0];
        if (!argument) {
          errors.push({
            code: "INVALID_CALL",
            ...locationFor(sourceFile, node, projectRoot),
            message: `${translation.kind} requires a translation key`,
          });
        } else {
          resolveKeys(argument, translation.config, node);
        }
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && bindings.transImportSymbols.has(checker.getSymbolAtLocation(tag))) {
        const attribute = findTransKeyAttribute(node);
        if (!attribute?.initializer) {
          errors.push({
            code: "INVALID_TRANS",
            ...locationFor(sourceFile, node, projectRoot),
            message: "Trans must declare an i18nKey for static usage checking",
          });
        } else if (ts.isStringLiteral(attribute.initializer)) {
          resolveKeys(attribute.initializer, { defaultNamespace: DEFAULT_NAMESPACE, keyPrefix: "" }, node);
        } else if (
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression
        ) {
          resolveKeys(
            attribute.initializer.expression,
            { defaultNamespace: DEFAULT_NAMESPACE, keyPrefix: "" },
            node,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export function checkI18nUsage(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const sourceDir = path.resolve(projectRoot, options.sourceDir ?? "src");
  const localesDir = path.resolve(projectRoot, options.localesDir ?? "src/locales");
  const tsconfigPath = path.resolve(projectRoot, options.tsconfigPath ?? "tsconfig.json");
  const manifest = options.manifest ?? I18N_USAGE_MANIFEST;
  const catalogs = discoverLocaleCatalogs(localesDir);
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  const checker = program.getTypeChecker();
  const preparedManifest = prepareManifest(manifest);
  const errors = [...preparedManifest.errors];
  const usedManifest = new Set();
  const stats = {
    translationCalls: 0,
    staticCalls: 0,
    manifestCalls: 0,
    resolvedKeys: new Set(),
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const relative = path.relative(sourceDir, sourceFile.fileName);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!/\.[cm]?[jt]sx?$/.test(sourceFile.fileName)) continue;
    analyzeSourceFile({
      sourceFile,
      checker,
      projectRoot,
      catalogs,
      manifestBySelector: preparedManifest.bySelector,
      usedManifest,
      errors,
      stats,
    });
  }

  for (const selector of preparedManifest.bySelector.keys()) {
    if (!usedManifest.has(selector)) {
      errors.push({
        code: "STALE_MANIFEST",
        message: `${selector} no longer matches an unresolved translation call`,
      });
    }
  }

  const uniqueErrors = [];
  const seenErrors = new Set();
  for (const error of errors) {
    const identity = JSON.stringify(error);
    if (!seenErrors.has(identity)) {
      seenErrors.add(identity);
      uniqueErrors.push(error);
    }
  }

  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    languages: [...catalogs.keys()],
    stats: {
      translationCalls: stats.translationCalls,
      staticCalls: stats.staticCalls,
      manifestCalls: stats.manifestCalls,
      resolvedKeys: stats.resolvedKeys.size,
    },
  };
}

export function formatI18nUsageReport(report) {
  const lines = [
    "i18n source usage check",
    `  Languages       : ${report.languages.join(", ")}`,
    `  Calls scanned   : ${report.stats.translationCalls}`,
    `  Static/finite   : ${report.stats.staticCalls}`,
    `  Manifest-backed : ${report.stats.manifestCalls}`,
    `  Resolved keys   : ${report.stats.resolvedKeys}`,
  ];
  if (report.ok) {
    lines.push("", "All source translation keys resolve.");
    return lines.join("\n");
  }
  lines.push("", `${report.errors.length} error(s):`);
  for (const error of report.errors) {
    const location = error.file
      ? `${error.file}:${error.line ?? 1}:${error.column ?? 1} `
      : "";
    lines.push(`  [${error.code}] ${location}${error.message}`);
  }
  return lines.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const report = checkI18nUsage();
    console.log(formatI18nUsageReport(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`i18n source usage check failed: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
