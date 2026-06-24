import { describe, expect, it } from "vitest";
import {
  buildMarkdownTargetOnlyTranslationPrompt,
  buildProtectedPlaceholderRetryInstruction,
  formatMarkdownBilingualTranslationResponse,
  formatMarkdownTargetOnlyTranslationResponse,
  formatSequentialTranslationResponse,
  parseMarkdownBilingualTranslationResponse,
  parseMarkdownTargetOnlyTranslationResponse,
  parseSequentialMarkdownTargetOnlyTranslationResponse,
  TranslationProtocolError,
} from "../../../electron/main/text-translation/model/translation-response-protocol";
import {
  applyProtectedPlaceholders,
  type MarkdownProtectedSpan,
  type ProtectedPlaceholder,
} from "../../../electron/main/text-translation/parsing/protected-placeholders";

describe("Markdown translation response protocol", () => {
  it("parses target-only unit translations by expected unit id", () => {
    const placeholders = createPlaceholders("seg_001");
    const text = formatMarkdownTargetOnlyTranslationResponse("seg_001", [
      {
        unitId: "file_md_u_000000",
        translatedText: `第一段保留 ${placeholders[0].token}`,
      },
      {
        unitId: "file_md_u_000001",
        translatedText: "第二段",
      },
    ]);

    const parsed = parseMarkdownTargetOnlyTranslationResponse({
      text,
      finishReason: "stop",
      protocolId: "seg_001",
      expectedUnits: [
        {
          unitId: "file_md_u_000000",
          placeholders: [placeholders[0]],
        },
        {
          unitId: "file_md_u_000001",
        },
      ],
    });

    expect(parsed).toEqual({
      protocol: "markdown_boundary_v1",
      results: [
        {
          unitId: "file_md_u_000000",
          translatedText: `第一段保留 ${placeholders[0].token}`,
          placeholders: [placeholders[0]],
        },
        {
          unitId: "file_md_u_000001",
          translatedText: "第二段",
        },
      ],
    });
  });

  it("parses bilingual block translations by expected block id", () => {
    const text = formatMarkdownBilingualTranslationResponse("seg_002", [
      {
        blockId: "md_block_000000",
        translatedMarkdown: "# 第一章",
      },
      {
        blockId: "md_block_000001",
        translatedMarkdown: "- 第一项\n- 第二项",
      },
    ]);

    const parsed = parseMarkdownBilingualTranslationResponse({
      text,
      finishReason: "stop",
      protocolId: "seg_002",
      expectedBlocks: [
        { blockId: "md_block_000000" },
        { blockId: "md_block_000001" },
      ],
    });

    expect(parsed.translations).toEqual([
      {
        blockId: "md_block_000000",
        translatedMarkdown: "# 第一章",
      },
      {
        blockId: "md_block_000001",
        translatedMarkdown: "- 第一项\n- 第二项",
      },
    ]);
  });

  it("preserves leading and trailing spaces inside Markdown unit translations", () => {
    const text = formatMarkdownTargetOnlyTranslationResponse("seg_spaces", [
      {
        unitId: "unit_1",
        translatedText: " 前后空格 ",
      },
    ]);

    const parsed = parseMarkdownTargetOnlyTranslationResponse({
      text,
      protocolId: "seg_spaces",
      expectedUnits: [{ unitId: "unit_1" }],
    });

    expect(parsed.results[0].translatedText).toBe(" 前后空格 ");
  });

  it("keeps Markdown protocol isolated inside the sequential translation section", () => {
    const markdownProtocol = formatMarkdownTargetOnlyTranslationResponse(
      "seg_seq",
      [
        {
          unitId: "file_md_u_000000",
          translatedText: "连续译文",
        },
      ],
    );
    const text = formatSequentialTranslationResponse("seg_seq", markdownProtocol, {
      currentSceneSummary: "场景仍在车站。",
    });

    const parsed = parseSequentialMarkdownTargetOnlyTranslationResponse({
      text,
      finishReason: "stop",
      sequentialProtocolId: "seg_seq",
      expectedUnits: [{ unitId: "file_md_u_000000" }],
    });

    expect(parsed.protocol).toBe("sequential_markdown_boundary_v1");
    expect(parsed.results).toEqual([
      {
        unitId: "file_md_u_000000",
        translatedText: "连续译文",
      },
    ]);
    expect(parsed.memoryUpdated).toBe(true);
    expect(parsed.memoryPatch).toEqual({
      currentSceneSummary: "场景仍在车站。",
    });
  });

  it("rejects explanations, code fences, missing markers, and truncation", () => {
    const valid = formatMarkdownTargetOnlyTranslationResponse("seg_003", [
      {
        unitId: "unit_1",
        translatedText: "译文",
      },
    ]);

    expect(() =>
      parseMarkdownTargetOnlyTranslationResponse({
        text: `Here is the result:\n${valid}`,
        protocolId: "seg_003",
        expectedUnits: [{ unitId: "unit_1" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "markdown_boundary_invalid",
        retryable: true,
      }),
    );

    expect(() =>
      parseMarkdownTargetOnlyTranslationResponse({
        text: `\`\`\`text\n${valid}\n\`\`\``,
        protocolId: "seg_003",
        expectedUnits: [{ unitId: "unit_1" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "markdown_boundary_invalid",
        retryable: true,
      }),
    );

    expect(() =>
      parseMarkdownTargetOnlyTranslationResponse({
        text: valid,
        finishReason: "length",
        protocolId: "seg_003",
        expectedUnits: [{ unitId: "unit_1" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "response_truncated",
        retryable: true,
      }),
    );
  });

  it("rejects missing, duplicated, unknown, and out-of-order item ids", () => {
    const expectedUnits = [{ unitId: "unit_1" }, { unitId: "unit_2" }];

    expectMarkdownIdError(
      formatMarkdownTargetOnlyTranslationResponse("seg_004", [
        { unitId: "unit_1", translatedText: "一" },
      ]),
      expectedUnits,
      "missing:unit_2",
    );
    expectMarkdownIdError(
      formatMarkdownTargetOnlyTranslationResponse("seg_004", [
        { unitId: "unit_1", translatedText: "一" },
        { unitId: "unit_1", translatedText: "重复" },
      ]),
      expectedUnits,
      "duplicate:unit_1",
    );
    expectMarkdownIdError(
      formatMarkdownTargetOnlyTranslationResponse("seg_004", [
        { unitId: "unit_1", translatedText: "一" },
        { unitId: "unit_x", translatedText: "未知" },
      ]),
      expectedUnits,
      "unknown:unit_x",
    );
    expectMarkdownIdError(
      formatMarkdownTargetOnlyTranslationResponse("seg_004", [
        { unitId: "unit_2", translatedText: "二" },
        { unitId: "unit_1", translatedText: "一" },
      ]),
      expectedUnits,
      "out_of_order",
    );
  });

  it("rejects missing, duplicated, unknown, and reordered protected placeholders", () => {
    const placeholders = createPlaceholders("seg_005");
    const expectedUnits = [
      {
        unitId: "unit_1",
        placeholders,
      },
    ];

    expectPlaceholderError("译文删除了占位符", expectedUnits);
    expectPlaceholderError(
      `${placeholders[0].token} ${placeholders[0].token} ${placeholders[1].token}`,
      expectedUnits,
    );
    expectPlaceholderError(
      `${placeholders[0].token} ${placeholders[1].token} ⟦FKP:alien:0001⟧`,
      expectedUnits,
    );
    expectPlaceholderError(
      `${placeholders[1].token} ${placeholders[0].token}`,
      expectedUnits,
    );
  });

  it("builds prompts with the same dynamic Markdown boundaries the parser expects", () => {
    const placeholders = createPlaceholders("seg_006");
    const prompt = buildMarkdownTargetOnlyTranslationPrompt({
      sourceLang: "EN",
      targetLang: "ZH",
      protocolId: "seg_006",
      units: [
        {
          unitId: "unit_1",
          sourceText: `Keep ${placeholders[0].token}`,
          placeholders: [placeholders[0]],
        },
      ],
      glossaryText: "Alice => 爱丽丝",
    });

    expect(prompt).toContain("<<<FUSIONKIT_MARKDOWN_TARGET_ONLY:seg_006>>>");
    expect(prompt).toContain("<<<FUSIONKIT_MD_UNIT:seg_006:unit_1>>>");
    expect(prompt).toContain("<<<FUSIONKIT_MARKDOWN_END:seg_006>>>");
    expect(prompt).toContain(placeholders[0].token);
    expect(prompt).toContain("Alice => 爱丽丝");
  });
});

function expectMarkdownIdError(
  text: string,
  expectedUnits: { unitId: string }[],
  messagePart: string,
): void {
  expect(() =>
    parseMarkdownTargetOnlyTranslationResponse({
      text,
      protocolId: "seg_004",
      expectedUnits,
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "markdown_id_mismatch",
      message: expect.stringContaining(messagePart),
      retryable: true,
    }),
  );
}

function expectPlaceholderError(
  translatedText: string,
  expectedUnits: { unitId: string; placeholders: ProtectedPlaceholder[] }[],
): void {
  const text = formatMarkdownTargetOnlyTranslationResponse("seg_005", [
    { unitId: "unit_1", translatedText },
  ]);

  expect(() =>
    parseMarkdownTargetOnlyTranslationResponse({
      text,
      protocolId: "seg_005",
      expectedUnits,
    }),
  ).toThrowError(TranslationProtocolError);

  try {
    parseMarkdownTargetOnlyTranslationResponse({
      text,
      protocolId: "seg_005",
      expectedUnits,
    });
  } catch (error) {
    expect(error).toMatchObject({
      code: "placeholder_mismatch",
      retryable: true,
      retryInstruction: buildProtectedPlaceholderRetryInstruction(
        expectedUnits[0].placeholders,
      ),
    });
  }
}

function createPlaceholders(segmentId: string): ProtectedPlaceholder[] {
  const source = "`inline code` and <https://example.org>";
  return applyProtectedPlaceholders({
    source,
    spans: [
      span(source, "inline_code", "`inline code`"),
      span(source, "autolink", "<https://example.org>"),
    ],
    segmentId,
  }).placeholders;
}

function span(
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
