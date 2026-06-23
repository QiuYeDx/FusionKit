import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import {
  applyMarkdownInsertions,
  applySourceSpanReplacements,
  buildBilingualInsertions,
  collectTranslatableSourceSpans,
  parseMarkdown,
} from "./markdownAstProbe";

const fixturesDir = path.join(
  process.cwd(),
  "test/text-translation/markdown/fixtures",
);
const source = fs.readFileSync(
  path.join(fixturesDir, "complex-source.md"),
  "utf-8",
);
const expectedBilingual = fs.readFileSync(
  path.join(fixturesDir, "complex-bilingual-expected.md"),
  "utf-8",
);

const translations = [
  {
    nodeType: "heading",
    occurrence: 1,
    translatedMarkdown: "第一章",
  },
  {
    nodeType: "paragraph",
    occurrence: 1,
    translatedMarkdown:
      "一个包含 **加粗文本**、`行内代码`、[链接](https://example.com/path?q=1) 和 ![封面替代文本](./cover.png) 的段落。",
  },
  {
    nodeType: "list",
    occurrence: 1,
    translatedMarkdown:
      "- 第一项包含 *强调文本*。\n  - 嵌套项包含 `代码`。\n- 第二项。",
  },
  {
    nodeType: "blockquote",
    occurrence: 1,
    translatedMarkdown: "原始引文。\n\n> 嵌套引文。",
    quoteDepth: 2,
  },
  {
    nodeType: "table",
    occurrence: 1,
    translatedMarkdown:
      "| 姓名 | 职业 |\n| :--- | ---: |\n| 爱丽丝 | 工程师 |\n| 鲍勃 | 作家 |",
  },
  {
    nodeType: "paragraph",
    occurrence: 2,
    translatedMarkdown:
      "最后一段 🚉 包含 <https://example.org> 和 ~~删除文本~~。",
  },
];

describe("PRE-002 Markdown AST and bilingual output probe", () => {
  it("parses GFM and YAML frontmatter with stable source offsets", () => {
    const root = parseMarkdown(source);
    const nodeTypes = root.children.map((node) => node.type);

    expect(nodeTypes).toEqual([
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

    for (const node of root.children) {
      expect(node.position?.start.offset).toBeTypeOf("number");
      expect(node.position?.end.offset).toBeTypeOf("number");
      const start = node.position!.start.offset!;
      const end = node.position!.end.offset!;
      expect(source.slice(start, end).length).toBeGreaterThan(0);
    }

    const finalParagraph = root.children.at(-1)!;
    const start = finalParagraph.position!.start.offset!;
    const end = finalParagraph.position!.end.offset!;
    expect(source.slice(start, end)).toBe(
      "Final paragraph 🚉 with <https://example.org> and ~~deleted text~~.",
    );
  });

  it("recognizes TOML frontmatter without treating it as translatable text", () => {
    const tomlSource =
      '+++\ntitle = "Protected title"\ndraft = true\n+++\n\nVisible paragraph.';
    const root = parseMarkdown(tomlSource);
    const spans = collectTranslatableSourceSpans(tomlSource, root);

    expect(root.children.map((node) => node.type)).toEqual([
      "toml",
      "paragraph",
    ]);
    expect(spans.map((span) => span.source)).toEqual(["Visible paragraph."]);
  });

  it("collects text and image-alt spans while protecting code, URLs, HTML, and frontmatter", () => {
    const root = parseMarkdown(source);
    const spans = collectTranslatableSourceSpans(source, root);
    const spanText = spans.map((span) => span.source);

    expect(spanText).toContain("Chapter One");
    expect(spanText).toContain("a link");
    expect(spanText).toContain("cover alt");
    expect(spanText).toContain("Engineer");
    expect(spanText).toContain("deleted text");

    expect(spanText).not.toContain("inline code");
    expect(spanText).not.toContain("code");
    expect(spanText).not.toContain("https://example.org");
    expect(spanText).not.toContain("const untouched = \"code\";");
    expect(spanText.join("\n")).not.toContain("Original Title");
    expect(spanText.join("\n")).not.toContain("Raw HTML stays untouched");

    const imageAlt = spans.find((span) => span.kind === "image_alt");
    expect(imageAlt).toMatchObject({
      source: "cover alt",
      kind: "image_alt",
    });
    expect(source.slice(imageAlt!.start, imageAlt!.end)).toBe("cover alt");
  });

  it("can replace source-position spans from the end without rewriting protected syntax", () => {
    const root = parseMarkdown(source);
    const spans = collectTranslatableSourceSpans(source, root);
    const output = applySourceSpanReplacements(
      source,
      spans.map((span) => ({
        ...span,
        replacement: `译文${span.source}`,
      })),
    );

    expect(output).toContain("title: Original Title");
    expect(output).toContain("`inline code`");
    expect(output).toContain("(https://example.com/path?q=1)");
    expect(output).toContain("(./cover.png)");
    expect(output).toContain("~~~ts\nconst untouched = \"code\";\n~~~");
    expect(output).toContain(
      '<div data-note="protected">Raw HTML stays untouched.</div>',
    );
    expect(output).toContain("<https://example.org>");
    expect(output).toContain("![译文cover alt](./cover.png)");
    expect(output).toContain("[译文a link](https://example.com/path?q=1)");

    const reparsed = parseMarkdown(output);
    expect(reparsed.children.map((node) => node.type)).toEqual(
      root.children.map((node) => node.type),
    );
  });

  it("generates the agreed bilingual blockquote format without serializing the original AST", () => {
    const root = parseMarkdown(source);
    const output = applyMarkdownInsertions(
      source,
      buildBilingualInsertions(source, root, translations),
    );

    expect(output).toBe(expectedBilingual);

    let cursor = 0;
    for (const block of root.children) {
      const start = block.position!.start.offset!;
      const end = block.position!.end.offset!;
      const rawBlock = source.slice(start, end);
      const foundAt = output.indexOf(rawBlock, cursor);
      expect(foundAt).toBeGreaterThanOrEqual(cursor);
      cursor = foundAt + rawBlock.length;
    }
  });

  it("parses translated lists, nested quotes, and tables into safe blockquote structures", () => {
    const root = parseMarkdown(expectedBilingual);
    expect(root.children.map((node) => node.type)).toEqual([
      "yaml",
      "heading",
      "blockquote",
      "paragraph",
      "blockquote",
      "list",
      "blockquote",
      "blockquote",
      "blockquote",
      "table",
      "blockquote",
      "code",
      "html",
      "thematicBreak",
      "paragraph",
      "blockquote",
    ]);

    const translatedListQuote = root.children[6];
    expect(translatedListQuote.type).toBe("blockquote");
    if (translatedListQuote.type === "blockquote") {
      expect(translatedListQuote.children[0]?.type).toBe("list");
    }

    const translatedOriginalQuote = root.children[8];
    expect(translatedOriginalQuote.type).toBe("blockquote");
    if (translatedOriginalQuote.type === "blockquote") {
      expect(translatedOriginalQuote.children[0]?.type).toBe("blockquote");
    }

    const translatedTableQuote = root.children[10];
    expect(translatedTableQuote.type).toBe("blockquote");
    if (translatedTableQuote.type === "blockquote") {
      expect(translatedTableQuote.children[0]?.type).toBe("table");
    }
  });

  it("renders the bilingual structures with the same ReactMarkdown + GFM engine used by the app", () => {
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm, remarkFrontmatter],
        children: expectedBilingual,
      }),
    );

    expect(html).toContain("<h1>Chapter One</h1>");
    expect(html).toContain("<blockquote>\n<p>第一章</p>");
    expect(html).toContain("<blockquote>\n<ul>");
    expect(html).toContain("<blockquote>\n<blockquote>");
    expect(html).toContain("<blockquote>\n<table>");
    expect(html).toContain("<code>inline code</code>");
    expect(html).toContain('href="https://example.com/path?q=1"');
    expect(html).toContain('src="./cover.png"');
  });
});
