import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  collectMarkdownProtectedSpans,
  parseMarkdownAst,
  parseMarkdownTranslationUnits,
} from "../../../electron/main/text-translation/parsing/markdown-parser";
import {
  applyProtectedPlaceholders,
  restoreProtectedPlaceholders,
  validateProtectedPlaceholders,
  type MarkdownProtectedSpan,
} from "../../../electron/main/text-translation/parsing/protected-placeholders";

const fixturesDir = path.join(
  process.cwd(),
  "test/text-translation/markdown/fixtures",
);
const source = readFileSync(
  path.join(fixturesDir, "complex-source.md"),
  "utf-8",
);

const countCharacters = (text: string) => text.length;

describe("Markdown parser and protected placeholders", () => {
  it("creates translatable units with stable source offsets", () => {
    const result = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: source,
      countTokens: countCharacters,
    });
    const unitText = result.units.map((unit) => unit.sourceText);

    expect(result.ast.children.map((node) => node.type)).toEqual([
      "yaml",
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "table",
      "code",
      "html",
      "thematicBreak",
      "paragraph",
    ]);
    expect(unitText).toEqual(
      expect.arrayContaining([
        "Chapter One",
        "A paragraph with ",
        "strong text",
        "a link",
        "cover alt",
        "First item with ",
        "Nested item with ",
        "Original quotation.",
        "Engineer",
        "deleted text",
      ]),
    );
    expect(unitText).not.toContain("inline code");
    expect(unitText).not.toContain("code");
    expect(unitText).not.toContain("https://example.org");
    expect(unitText.join("\n")).not.toContain("Original Title");
    expect(unitText.join("\n")).not.toContain("Raw HTML stays untouched");

    for (const unit of result.units) {
      expect(source.slice(unit.sourceStart, unit.sourceEnd)).toBe(
        unit.sourceText,
      );
      expect(unit.unitId).toMatch(/^file_md_u_\d{6}$/);
      expect(unit.tokenCount).toBe(unit.sourceText.length);
    }
  });

  it("classifies list, blockquote, table cell, and image alt contexts", () => {
    const { units } = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: source,
      countTokens: countCharacters,
    });

    const firstItem = units.find((unit) => unit.sourceText === "First item with ");
    const nestedItem = units.find((unit) => unit.sourceText === "Nested item with ");
    const quotation = units.find((unit) => unit.sourceText === "Original quotation.");
    const tableCell = units.find((unit) => unit.sourceText === "Engineer");
    const imageAlt = units.find((unit) => unit.sourceText === "cover alt");

    expect(firstItem).toMatchObject({
      kind: "list_item",
      structuralContext: { listDepth: 1 },
    });
    expect(nestedItem).toMatchObject({
      kind: "list_item",
      structuralContext: { listDepth: 2 },
    });
    expect(quotation).toMatchObject({
      kind: "blockquote",
      structuralContext: { quoteDepth: 1 },
    });
    expect(tableCell?.kind).toBe("table_cell");
    expect(tableCell?.structuralContext?.tableId).toMatch(/^table_\d+$/);
    expect(imageAlt?.kind).toBe("paragraph");
    expect(source.slice(imageAlt!.sourceStart, imageAlt!.sourceEnd)).toBe(
      "cover alt",
    );
  });

  it("collects protected Markdown spans without overlapping translatable labels", () => {
    const ast = parseMarkdownAst(source);
    const spans = collectMarkdownProtectedSpans(source, ast);
    const byKind = groupSourcesByKind(spans);

    expect(byKind.frontmatter.join("\n")).toContain("title: Original Title");
    expect(byKind.inline_code).toEqual(
      expect.arrayContaining(["`inline code`", "`code`"]),
    );
    expect(byKind.link_destination).toContain("https://example.com/path?q=1");
    expect(byKind.image_destination).toContain("./cover.png");
    expect(byKind.autolink).toContain("<https://example.org>");
    expect(byKind.code.join("\n")).toContain('const untouched = "code";');
    expect(byKind.html.join("\n")).toContain("Raw HTML stays untouched");
    expect(byKind.thematic_break).toContain("---");

    for (const span of spans) {
      expect(source.slice(span.start, span.end)).toBe(span.source);
    }

    expect(spans.some((span) => span.source === "a link")).toBe(false);
    expect(spans.some((span) => span.source === "cover alt")).toBe(false);
  });

  it("locates image alt spans with escaped and nested brackets", () => {
    const markdown = "![cover [draft\\] alt]](./cover.png)\n\nVisible text.";
    const { units, protectedSpans } = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: markdown,
      countTokens: countCharacters,
    });

    const alt = units.find((unit) => unit.sourceText.includes("cover"));
    expect(alt?.sourceText).toBe("cover [draft\\] alt]");
    expect(markdown.slice(alt!.sourceStart, alt!.sourceEnd)).toBe(
      "cover [draft\\] alt]",
    );
    expect(protectedSpans).toContainEqual({
      kind: "image_destination",
      start: markdown.indexOf("./cover.png"),
      end: markdown.indexOf("./cover.png") + "./cover.png".length,
      source: "./cover.png",
    });
  });

  it("applies, validates, and restores protected placeholders", () => {
    const ast = parseMarkdownAst(source);
    const spans = collectMarkdownProtectedSpans(source, ast);
    const { text, placeholders } = applyProtectedPlaceholders({
      source,
      spans,
      segmentId: "segment:01",
    });

    expect(text).toContain("⟦FKP:segment_01:0001⟧");
    expect(text).not.toContain("https://example.com/path?q=1");
    expect(text).not.toContain("`inline code`");
    expect(validateProtectedPlaceholders(text, placeholders).ok).toBe(true);
    expect(restoreProtectedPlaceholders(text, placeholders)).toBe(source);
  });

  it("rejects missing, duplicate, unknown, and reordered placeholders", () => {
    const placeholders = applyProtectedPlaceholders({
      source: "A `code` and <https://example.org>",
      spans: [
        protectedSpan("A `code` and <https://example.org>", "inline_code", "`code`"),
        protectedSpan(
          "A `code` and <https://example.org>",
          "autolink",
          "<https://example.org>",
        ),
      ],
      segmentId: "segment_001",
    }).placeholders;

    expect(
      validateProtectedPlaceholders(
        `${placeholders[0].token} ${placeholders[0].token}`,
        placeholders,
      ).ok,
    ).toBe(false);
    expect(
      validateProtectedPlaceholders(
        `${placeholders[1].token} ${placeholders[0].token}`,
        placeholders,
      ).errors,
    ).toContain("Protected placeholders are not in the expected order.");
    expect(
      validateProtectedPlaceholders(
        `${placeholders[0].token} ${placeholders[1].token} ⟦FKP:bad:0001⟧`,
        placeholders,
      ).errors,
    ).toContain("Unknown placeholder ⟦FKP:bad:0001⟧.");
  });

  it("rejects overlapping protected spans before replacement", () => {
    expect(() =>
      applyProtectedPlaceholders({
        source: "abcdef",
        spans: [
          { kind: "structure", start: 1, end: 4, source: "bcd" },
          { kind: "structure", start: 3, end: 5, source: "de" },
        ],
        segmentId: "segment_001",
      }),
    ).toThrow("Overlapping protected span");
  });
});

function groupSourcesByKind(spans: MarkdownProtectedSpan[]) {
  return spans.reduce<Record<string, string[]>>((groups, span) => {
    groups[span.kind] ??= [];
    groups[span.kind].push(span.source);
    return groups;
  }, {});
}

function protectedSpan(
  sourceText: string,
  kind: MarkdownProtectedSpan["kind"],
  source: string,
): MarkdownProtectedSpan {
  const start = sourceText.indexOf(source);
  return {
    kind,
    start,
    end: start + source.length,
    source,
  };
}
