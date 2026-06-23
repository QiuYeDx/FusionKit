import type { Image, ImageReference, Nodes, Parent, Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownSourceSpan {
  start: number;
  end: number;
  source: string;
  kind: "text" | "image_alt";
}

export interface BilingualBlockTranslation {
  nodeType: string;
  occurrence: number;
  translatedMarkdown: string;
  quoteDepth?: number;
}

export interface MarkdownInsertion {
  offset: number;
  markdown: string;
}

const PROTECTED_ANCESTOR_TYPES = new Set([
  "yaml",
  "toml",
  "code",
  "inlineCode",
  "html",
  "definition",
]);

export function createMarkdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml", "toml"]);
}

export function parseMarkdown(source: string): Root {
  return createMarkdownProcessor().parse(source);
}

function hasChildren(node: Nodes): node is Nodes & Parent {
  return "children" in node && Array.isArray(node.children);
}

function isAutolinkText(
  source: string,
  node: Nodes,
  ancestors: Nodes[],
): boolean {
  if (node.type !== "text") return false;
  const parent = ancestors.at(-1);
  if (!parent || parent.type !== "link" || !parent.position) return false;

  const rawLink = source.slice(
    parent.position.start.offset,
    parent.position.end.offset,
  );
  return rawLink.startsWith("<") && rawLink.endsWith(">");
}

function locateImageAltSpan(
  source: string,
  node: Image | ImageReference,
): MarkdownSourceSpan | undefined {
  const startOffset = node.position?.start.offset;
  const endOffset = node.position?.end.offset;
  if (startOffset === undefined || endOffset === undefined) return undefined;

  const raw = source.slice(startOffset, endOffset);
  if (!raw.startsWith("![")) return undefined;

  let bracketDepth = 0;
  let escaped = false;

  for (let index = 2; index < raw.length; index += 1) {
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
      bracketDepth += 1;
      continue;
    }
    if (character === "]") {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
        continue;
      }

      return {
        start: startOffset + 2,
        end: startOffset + index,
        source: raw.slice(2, index),
        kind: "image_alt",
      };
    }
  }

  return undefined;
}

export function collectTranslatableSourceSpans(
  source: string,
  root: Root,
): MarkdownSourceSpan[] {
  const spans: MarkdownSourceSpan[] = [];

  const visit = (node: Nodes, ancestors: Nodes[]) => {
    const isProtected = ancestors.some((ancestor) =>
      PROTECTED_ANCESTOR_TYPES.has(ancestor.type),
    );

    if (
      node.type === "text" &&
      !isProtected &&
      !isAutolinkText(source, node, ancestors) &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    ) {
      spans.push({
        start: node.position.start.offset,
        end: node.position.end.offset,
        source: source.slice(
          node.position.start.offset,
          node.position.end.offset,
        ),
        kind: "text",
      });
    } else if (
      !isProtected &&
      (node.type === "image" || node.type === "imageReference")
    ) {
      const altSpan = locateImageAltSpan(source, node);
      if (altSpan) spans.push(altSpan);
    }

    if (hasChildren(node)) {
      for (const child of node.children as Nodes[]) {
        visit(child, [...ancestors, node]);
      }
    }
  };

  visit(root, []);

  return spans.sort((left, right) => left.start - right.start);
}

function quoteMarkdown(markdown: string, depth: number): string {
  const prefix = Array.from({ length: depth }, () => ">").join(" ");
  return markdown
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix} ${line}` : prefix))
    .join("\n");
}

export function buildBilingualInsertions(
  source: string,
  root: Root,
  translations: BilingualBlockTranslation[],
): MarkdownInsertion[] {
  const translationsByKey = new Map(
    translations.map((translation) => [
      `${translation.nodeType}:${translation.occurrence}`,
      translation,
    ]),
  );
  const occurrences = new Map<string, number>();
  const insertions: MarkdownInsertion[] = [];

  for (const node of root.children) {
    const occurrence = (occurrences.get(node.type) ?? 0) + 1;
    occurrences.set(node.type, occurrence);

    const translation = translationsByKey.get(`${node.type}:${occurrence}`);
    const offset = node.position?.end.offset;
    if (!translation || offset === undefined) continue;

    insertions.push({
      offset,
      markdown: `\n\n${quoteMarkdown(
        translation.translatedMarkdown,
        translation.quoteDepth ?? 1,
      )}`,
    });
  }

  const invalidOffset = insertions.find(
    (insertion) => insertion.offset < 0 || insertion.offset > source.length,
  );
  if (invalidOffset) {
    throw new Error(`Invalid Markdown insertion offset: ${invalidOffset.offset}`);
  }

  return insertions;
}

export function applyMarkdownInsertions(
  source: string,
  insertions: MarkdownInsertion[],
): string {
  let output = source;
  for (const insertion of [...insertions].sort(
    (left, right) => right.offset - left.offset,
  )) {
    output =
      output.slice(0, insertion.offset) +
      insertion.markdown +
      output.slice(insertion.offset);
  }
  return output;
}

export function applySourceSpanReplacements(
  source: string,
  replacements: Array<MarkdownSourceSpan & { replacement: string }>,
): string {
  let output = source;
  for (const span of [...replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, span.start) +
      span.replacement +
      output.slice(span.end);
  }
  return output;
}
