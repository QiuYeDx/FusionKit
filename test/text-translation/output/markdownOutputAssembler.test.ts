import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleMarkdownBilingualContent,
  assembleMarkdownTargetOnlyContent,
  collectMarkdownBilingualBlocks,
  writeMarkdownTargetOnlyOutput,
  type MarkdownBlockTranslationResult,
  type MarkdownUnitTranslationResult,
} from "../../../electron/main/text-translation/output/markdown-output-assembler";
import {
  parseMarkdownAst,
  parseMarkdownTranslationUnits,
} from "../../../electron/main/text-translation/parsing/markdown-parser";
import { applyProtectedPlaceholders } from "../../../electron/main/text-translation/parsing/protected-placeholders";
import type { TranslationUnit } from "../../../electron/main/text-translation/types";

const fixturesDir = path.join(
  process.cwd(),
  "test/text-translation/markdown/fixtures",
);
const source = readFileSync(
  path.join(fixturesDir, "complex-source.md"),
  "utf-8",
);
const expectedBilingual = readFileSync(
  path.join(fixturesDir, "complex-bilingual-expected.md"),
  "utf-8",
);
const countCharacters = (text: string) => text.length;

describe("Markdown target-only output assembler", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-md-output-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("replaces translatable ranges while preserving protected Markdown syntax", () => {
    const parsed = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: source,
      countTokens: countCharacters,
    });
    const output = assembleMarkdownTargetOnlyContent({
      sourceText: source,
      units: parsed.units,
      results: createResults(parsed.units),
    });

    expect(output).toContain("title: Original Title");
    expect(output).toContain("# 第一章");
    expect(output).toContain("**加粗文本**");
    expect(output).toContain("`inline code`");
    expect(output).toContain("[一个链接](https://example.com/path?q=1)");
    expect(output).toContain("![封面替代文本](./cover.png)");
    expect(output).toContain("  - 嵌套项包含 `code`.");
    expect(output).toContain("| 姓名 | 职业 |");
    expect(output).toContain("| 爱丽丝 | 工程师 |");
    expect(output).toContain("~~~ts\nconst untouched = \"code\";\n~~~");
    expect(output).toContain(
      '<div data-note="protected">Raw HTML stays untouched.</div>',
    );
    expect(output).toContain("<https://example.org>");
    expect(output).toContain("~~删除文本~~");

    expect(parseMarkdownAst(output).children.map((node) => node.type)).toEqual(
      parsed.ast.children.map((node) => node.type),
    );
  });

  it("applies replacements from the end so later edits do not drift offsets", () => {
    const markdown = "# Title 🚉\n\nA [link](https://example.com).";
    const parsed = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: markdown,
      countTokens: countCharacters,
    });

    const output = assembleMarkdownTargetOnlyContent({
      sourceText: markdown,
      units: parsed.units,
      results: parsed.units.map((unit) => ({
        unitId: unit.unitId,
        translatedText:
          unit.sourceText === "Title 🚉"
            ? "标题 🚉"
            : unit.sourceText === "A "
              ? "一个 "
              : unit.sourceText === "link"
                ? "链接"
                : unit.sourceText,
      })),
    });

    expect(output).toBe("# 标题 🚉\n\n一个 [链接](https://example.com).");
  });

  it("restores protected placeholders before replacing unit text", () => {
    const markdown = "Replace me.";
    const tokenized = applyProtectedPlaceholders({
      source: "`code`",
      spans: [{ kind: "inline_code", start: 0, end: 6, source: "`code`" }],
      segmentId: "segment_001",
    });
    const unit = createUnit({
      unitId: "unit_001",
      sourceStart: 0,
      sourceEnd: "Replace me".length,
      sourceText: "Replace me",
    });

    const output = assembleMarkdownTargetOnlyContent({
      sourceText: markdown,
      units: [unit],
      results: [
        {
          unitId: unit.unitId,
          translatedText: `保留 ${tokenized.text}`,
          placeholders: tokenized.placeholders,
        },
      ],
    });

    expect(output).toBe("保留 `code`.");
  });

  it("rejects missing, stale, and overlapping unit replacements", () => {
    const first = createUnit({
      unitId: "first",
      sourceStart: 0,
      sourceEnd: 5,
      sourceText: "Alpha",
    });
    const overlap = createUnit({
      unitId: "overlap",
      sourceStart: 3,
      sourceEnd: 8,
      sourceText: "ha Be",
    });

    expect(() =>
      assembleMarkdownTargetOnlyContent({
        sourceText: "Alpha Beta",
        units: [first],
        results: [],
      }),
    ).toThrow("Missing Markdown translation result");

    expect(() =>
      assembleMarkdownTargetOnlyContent({
        sourceText: "Alpha Beta",
        units: [first],
        results: [{ unitId: "first", translatedText: "旧译文", stale: true }],
      }),
    ).toThrow("Stale Markdown translation result");

    expect(() =>
      assembleMarkdownTargetOnlyContent({
        sourceText: "Alpha Beta",
        units: [first, overlap],
        results: [
          { unitId: "first", translatedText: "一" },
          { unitId: "overlap", translatedText: "二" },
        ],
      }),
    ).toThrow("Overlapping Markdown replacement range");
  });

  it("writes Markdown target-only output as UTF-8 and preserves extension", async () => {
    const sourcePath = path.join(tempRoot, "chapter.md");
    await writeFile(sourcePath, source, "utf-8");
    const parsed = parseMarkdownTranslationUnits({
      fileId: "file_md",
      text: source,
      countTokens: countCharacters,
    });

    const result = await writeMarkdownTargetOnlyOutput({
      sourcePath,
      targetLang: "ZH",
      outputPathMode: "source",
      conflictPolicy: "index",
      sourceText: source,
      units: parsed.units,
      results: createResults(parsed.units),
    });

    expect(path.basename(result.outputPath)).toBe("chapter.zh.md");
    expect(await readFile(result.outputPath, "utf-8")).toContain("# 第一章");
    expect(result.bytesWritten).toBe(
      Buffer.byteLength(await readFile(result.outputPath, "utf-8"), "utf-8"),
    );
  });
});

describe("Markdown bilingual output assembler", () => {
  it("inserts translated blockquotes after translatable top-level blocks", () => {
    const blocks = collectMarkdownBilingualBlocks(source);
    const output = assembleMarkdownBilingualContent({
      sourceText: source,
      translations: createBlockTranslations(blocks),
    });

    expect(blocks.map((block) => [block.nodeType, block.occurrence])).toEqual([
      ["heading", 1],
      ["paragraph", 1],
      ["list", 1],
      ["blockquote", 1],
      ["table", 1],
      ["paragraph", 2],
    ]);
    expect(output).toBe(expectedBilingual);
  });

  it("keeps protected top-level blocks from receiving empty translations", () => {
    const protectedOnly = [
      "---",
      "title: Protected",
      "---",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "<div>raw</div>",
      "",
      "---",
    ].join("\n");

    const blocks = collectMarkdownBilingualBlocks(protectedOnly);
    const output = assembleMarkdownBilingualContent({
      sourceText: protectedOnly,
      translations: [],
    });

    expect(blocks).toEqual([]);
    expect(output).toBe(protectedOnly);
  });

  it("uses one deeper quote depth for original blockquotes", () => {
    const markdown = "> Quote\n>\n> > Nested quote";
    const blocks = collectMarkdownBilingualBlocks(markdown);
    const output = assembleMarkdownBilingualContent({
      sourceText: markdown,
      translations: [
        {
          blockId: blocks[0].blockId,
          translatedMarkdown: "译文\n\n> 嵌套译文",
        },
      ],
    });

    expect(blocks[0]).toMatchObject({
      nodeType: "blockquote",
      quoteDepth: 2,
    });
    expect(output).toBe(
      "> Quote\n>\n> > Nested quote\n\n> > 译文\n> >\n> > > 嵌套译文",
    );
  });

  it("rejects missing and stale block translations", () => {
    const blocks = collectMarkdownBilingualBlocks("# Title");

    expect(() =>
      assembleMarkdownBilingualContent({
        sourceText: "# Title",
        translations: [],
      }),
    ).toThrow("Missing Markdown block translation");

    expect(() =>
      assembleMarkdownBilingualContent({
        sourceText: "# Title",
        translations: [
          {
            blockId: blocks[0].blockId,
            translatedMarkdown: "旧译文",
            stale: true,
          },
        ],
      }),
    ).toThrow("Stale Markdown block translation");
  });
});

function createResults(
  units: TranslationUnit[],
): MarkdownUnitTranslationResult[] {
  return units.map((unit) => ({
    unitId: unit.unitId,
    translatedText: translate(unit.sourceText),
  }));
}

function createBlockTranslations(
  blocks: ReturnType<typeof collectMarkdownBilingualBlocks>,
): MarkdownBlockTranslationResult[] {
  const translations: Record<string, string> = {
    "heading:1": "第一章",
    "paragraph:1":
      "一个包含 **加粗文本**、`行内代码`、[链接](https://example.com/path?q=1) 和 ![封面替代文本](./cover.png) 的段落。",
    "list:1": "- 第一项包含 *强调文本*。\n  - 嵌套项包含 `代码`。\n- 第二项。",
    "blockquote:1": "原始引文。\n\n> 嵌套引文。",
    "table:1":
      "| 姓名 | 职业 |\n| :--- | ---: |\n| 爱丽丝 | 工程师 |\n| 鲍勃 | 作家 |",
    "paragraph:2": "最后一段 🚉 包含 <https://example.org> 和 ~~删除文本~~。",
  };
  return blocks.map((block) => ({
    blockId: block.blockId,
    translatedMarkdown: translations[`${block.nodeType}:${block.occurrence}`],
  }));
}

function translate(text: string): string {
  const translations: Record<string, string> = {
    "Chapter One": "第一章",
    "A paragraph with ": "一个段落包含 ",
    "strong text": "加粗文本",
    "a link": "一个链接",
    "cover alt": "封面替代文本",
    "First item with ": "第一项包含 ",
    "emphasis": "强调",
    "Nested item with ": "嵌套项包含 ",
    "Second item.": "第二项。",
    "Original quotation.": "原始引文。",
    "Nested quotation.": "嵌套引文。",
    Name: "姓名",
    Role: "职业",
    Alice: "爱丽丝",
    Engineer: "工程师",
    Bob: "鲍勃",
    Writer: "作家",
    "Final paragraph 🚉 with ": "最后一段 🚉 包含 ",
    " and ": " 和 ",
    "deleted text": "删除文本",
  };
  return translations[text] ?? text;
}

function createUnit(overrides: Partial<TranslationUnit>): TranslationUnit {
  return {
    unitId: "unit",
    fileId: "file_md",
    order: 0,
    kind: "paragraph",
    sourceStart: 0,
    sourceEnd: 1,
    sourceText: "x",
    translatable: true,
    tokenCount: 1,
    ...overrides,
  };
}
