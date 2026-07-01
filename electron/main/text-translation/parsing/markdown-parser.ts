import type {
  Image,
  ImageReference,
  Link,
  LinkReference,
  Nodes,
  Parent,
  Root,
} from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type {
  CountTextTokens,
  TranslationUnit,
  TranslationUnitKind,
} from "../types";
import { countTextTokens } from "../planning/token-counter";
import type { MarkdownProtectedSpan } from "./protected-placeholders";

export interface ParseMarkdownTranslationUnitsOptions {
  fileId: string;
  text: string;
  countTokens?: CountTextTokens;
}

export interface MarkdownTranslatableSpan {
  kind: TranslationUnitKind;
  start: number;
  end: number;
  source: string;
  structuralContext?: TranslationUnit["structuralContext"];
}

export interface ParseMarkdownTranslationUnitsResult {
  units: TranslationUnit[];
  protectedSpans: MarkdownProtectedSpan[];
  ast: Root;
}

const PROTECTED_NODE_TYPES = new Set([
  "yaml",
  "toml",
  "code",
  "inlineCode",
  "html",
  "definition",
  "thematicBreak",
  "math",
  "inlineMath",
]);

export function createMarkdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml", "toml"]);
}

export function parseMarkdownAst(source: string): Root {
  return createMarkdownProcessor().parse(source);
}

export function parseMarkdownTranslationUnits(
  options: ParseMarkdownTranslationUnitsOptions,
): ParseMarkdownTranslationUnitsResult {
  const ast = parseMarkdownAst(options.text);
  const countTokens = options.countTokens ?? countTextTokens;
  const spans = collectMarkdownTranslatableSpans(options.text, ast);
  const units = spans
    .filter((span) => span.source.trim().length > 0)
    .map((span, index): TranslationUnit => ({
      unitId: createUnitId(options.fileId, index),
      fileId: options.fileId,
      order: index,
      kind: span.kind,
      sourceStart: span.start,
      sourceEnd: span.end,
      sourceText: span.source,
      translatable: true,
      tokenCount: countTokens(span.source),
      structuralContext: span.structuralContext,
    }));

  return {
    units,
    protectedSpans: collectMarkdownProtectedSpans(options.text, ast),
    ast,
  };
}

export function collectMarkdownTranslatableSpans(
  source: string,
  ast: Root,
): MarkdownTranslatableSpan[] {
  const spans: MarkdownTranslatableSpan[] = [];

  const visit = (node: Nodes, ancestors: Nodes[]) => {
    if (
      node.type === "text" &&
      !isInsideProtectedAncestor(ancestors) &&
      !isAutolinkText(source, ancestors)
    ) {
      const range = getNodeRange(source, node);
      if (range) {
        spans.push({
          kind: resolveTranslationKind(ancestors),
          start: range.start,
          end: range.end,
          source: range.source,
          structuralContext: resolveStructuralContext(ancestors),
        });
      }
    } else if (
      !isInsideProtectedAncestor(ancestors) &&
      (node.type === "image" || node.type === "imageReference")
    ) {
      const range = locateImageAltSpan(source, node);
      if (range) {
        spans.push({
          kind: "paragraph",
          start: range.start,
          end: range.end,
          source: range.source,
          structuralContext: resolveStructuralContext(ancestors),
        });
      }
    }

    if (hasChildren(node)) {
      for (const child of node.children as Nodes[]) {
        visit(child, [...ancestors, node]);
      }
    }
  };

  visit(ast, []);
  return spans.sort((left, right) => left.start - right.start);
}

export function collectMarkdownProtectedSpans(
  source: string,
  ast: Root,
): MarkdownProtectedSpan[] {
  const spans: MarkdownProtectedSpan[] = [];

  const visit = (node: Nodes, ancestors: Nodes[]) => {
    const range = getNodeRange(source, node);
    if (range && PROTECTED_NODE_TYPES.has(node.type)) {
      spans.push({
        kind: protectedKindForNode(node.type),
        start: range.start,
        end: range.end,
        source: range.source,
      });
      return;
    }

    if (range && node.type === "link" && isAutolinkNode(range.source)) {
      spans.push({
        kind: "autolink",
        start: range.start,
        end: range.end,
        source: range.source,
      });
      return;
    }

    if (node.type === "link" || node.type === "image") {
      const destination = locateLinkDestinationSpan(source, node);
      if (destination) {
        spans.push({
          kind: node.type === "image" ? "image_destination" : "link_destination",
          ...destination,
        });
      }
    } else if (node.type === "linkReference" || node.type === "imageReference") {
      const identifier = locateReferenceIdentifierSpan(source, node);
      if (identifier) {
        spans.push({
          kind:
            node.type === "imageReference"
              ? "image_destination"
              : "link_destination",
          ...identifier,
        });
      }
    }

    if (!isInsideProtectedAncestor(ancestors) && hasChildren(node)) {
      for (const child of node.children as Nodes[]) {
        visit(child, [...ancestors, node]);
      }
    }
  };

  visit(ast, []);
  return spans.sort((left, right) => left.start - right.start);
}

function getNodeRange(
  source: string,
  node: Nodes,
): { start: number; end: number; source: string } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || start >= end) return undefined;
  return {
    start,
    end,
    source: source.slice(start, end),
  };
}

function hasChildren(node: Nodes): node is Nodes & Parent {
  return "children" in node && Array.isArray(node.children);
}

function isInsideProtectedAncestor(ancestors: Nodes[]): boolean {
  return ancestors.some((ancestor) => PROTECTED_NODE_TYPES.has(ancestor.type));
}

function isAutolinkText(source: string, ancestors: Nodes[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent || parent.type !== "link") return false;
  const range = getNodeRange(source, parent);
  return Boolean(range && isAutolinkNode(range.source));
}

function isAutolinkNode(raw: string): boolean {
  return raw.startsWith("<") && raw.endsWith(">");
}

function resolveTranslationKind(ancestors: Nodes[]): TranslationUnitKind {
  if (ancestors.some((ancestor) => ancestor.type === "heading")) return "heading";
  if (ancestors.some((ancestor) => ancestor.type === "tableCell")) {
    return "table_cell";
  }
  if (ancestors.some((ancestor) => ancestor.type === "listItem")) {
    return "list_item";
  }
  if (ancestors.some((ancestor) => ancestor.type === "blockquote")) {
    return "blockquote";
  }
  if (ancestors.some((ancestor) => ancestor.type === "paragraph")) {
    return "paragraph";
  }
  return "plain_text";
}

function resolveStructuralContext(
  ancestors: Nodes[],
): TranslationUnit["structuralContext"] | undefined {
  const listDepth = ancestors.filter(
    (ancestor) => ancestor.type === "listItem",
  ).length;
  const quoteDepth = ancestors.filter(
    (ancestor) => ancestor.type === "blockquote",
  ).length;
  const tableAncestor = ancestors.find((ancestor) => ancestor.type === "table");

  const context: NonNullable<TranslationUnit["structuralContext"]> = {};
  if (listDepth > 0) context.listDepth = listDepth;
  if (quoteDepth > 0) context.quoteDepth = quoteDepth;
  if (tableAncestor?.position?.start.offset !== undefined) {
    context.tableId = `table_${tableAncestor.position.start.offset}`;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

function locateImageAltSpan(
  source: string,
  node: Image | ImageReference,
): { start: number; end: number; source: string } | undefined {
  const range = getNodeRange(source, node);
  if (!range || !range.source.startsWith("![")) return undefined;

  const closeIndex = findClosingBracket(range.source, 2);
  if (closeIndex === -1) return undefined;

  return {
    start: range.start + 2,
    end: range.start + closeIndex,
    source: range.source.slice(2, closeIndex),
  };
}

function locateLinkDestinationSpan(
  source: string,
  node: Link | Image,
): { start: number; end: number; source: string } | undefined {
  const range = getNodeRange(source, node);
  if (!range) return undefined;

  const labelStart = range.source.startsWith("![") ? 2 : 1;
  const labelEnd = findClosingBracket(range.source, labelStart);
  if (labelEnd === -1) return undefined;

  const openParen = range.source.indexOf("(", labelEnd + 1);
  if (openParen === -1) return undefined;

  let destinationStart = openParen + 1;
  while (/\s/.test(range.source[destinationStart] ?? "")) destinationStart += 1;
  if (destinationStart >= range.source.length) return undefined;

  let destinationEnd: number;
  if (range.source[destinationStart] === "<") {
    destinationStart += 1;
    destinationEnd = findUnescapedCharacter(range.source, ">", destinationStart);
  } else {
    destinationEnd = destinationStart;
    while (
      destinationEnd < range.source.length &&
      !/\s|\)/.test(range.source[destinationEnd])
    ) {
      destinationEnd += 1;
    }
  }

  if (destinationEnd === -1 || destinationEnd <= destinationStart) {
    return undefined;
  }

  return {
    start: range.start + destinationStart,
    end: range.start + destinationEnd,
    source: range.source.slice(destinationStart, destinationEnd),
  };
}

function locateReferenceIdentifierSpan(
  source: string,
  node: LinkReference | ImageReference,
): { start: number; end: number; source: string } | undefined {
  const range = getNodeRange(source, node);
  if (!range) return undefined;

  const labelStart = range.source.startsWith("![") ? 2 : 1;
  const labelEnd = findClosingBracket(range.source, labelStart);
  if (labelEnd === -1) return undefined;

  const referenceStart = range.source.indexOf("[", labelEnd + 1);
  if (referenceStart === -1) return undefined;
  const referenceEnd = findClosingBracket(range.source, referenceStart + 1);
  if (referenceEnd === -1 || referenceEnd <= referenceStart + 1) {
    return undefined;
  }

  return {
    start: range.start + referenceStart + 1,
    end: range.start + referenceEnd,
    source: range.source.slice(referenceStart + 1, referenceEnd),
  };
}

function findClosingBracket(raw: string, startIndex: number): number {
  let depth = 0;
  let escaped = false;

  for (let index = startIndex; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character === "]") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      return index;
    }
  }

  return -1;
}

function findUnescapedCharacter(
  raw: string,
  target: string,
  startIndex: number,
): number {
  let escaped = false;
  for (let index = startIndex; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === target) return index;
  }
  return -1;
}

function protectedKindForNode(
  nodeType: string,
): MarkdownProtectedSpan["kind"] {
  switch (nodeType) {
    case "yaml":
    case "toml":
      return "frontmatter";
    case "code":
      return "code";
    case "inlineCode":
      return "inline_code";
    case "html":
      return "html";
    case "definition":
      return "definition";
    case "thematicBreak":
      return "thematic_break";
    case "math":
    case "inlineMath":
      return "math";
    default:
      return "structure";
  }
}

function createUnitId(fileId: string, order: number): string {
  return `${fileId}_u_${String(order).padStart(6, "0")}`;
}
