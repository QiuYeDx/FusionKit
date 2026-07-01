import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleTxtBilingualContent,
  assembleTxtTargetOnlyContent,
  writeTxtOutput,
  writeTxtTargetOnlyOutput,
} from "../../../electron/main/text-translation/output/text-output-assembler";
import type { TranslationSegment } from "../../../electron/main/text-translation/types";

describe("TXT target-only output assembler", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-output-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("joins hard-cut segment results without extra blank lines", () => {
    const content = assembleTxtTargetOnlyContent({
      segments: [
        createSegment("s1", 0, { endsMidUnit: true }),
        createSegment("s2", 1, { startsMidUnit: true }),
        createSegment("s3", 2),
      ],
      results: [
        { segmentId: "s1", translatedText: "上半段" },
        { segmentId: "s2", translatedText: "下半段" },
        { segmentId: "s3", translatedText: "下一段" },
      ],
    });

    expect(content).toBe("上半段下半段\n\n下一段");
  });

  it("rejects missing and stale segment results", () => {
    expect(() =>
      assembleTxtTargetOnlyContent({
        segments: [createSegment("s1", 0)],
        results: [],
      }),
    ).toThrow("Missing translation result");

    expect(() =>
      assembleTxtTargetOnlyContent({
        segments: [createSegment("s1", 0)],
        results: [{ segmentId: "s1", translatedText: "旧译文", stale: true }],
      }),
    ).toThrow("Stale translation result");
  });

  it("writes UTF-8 without BOM and indexes conflicting output names", async () => {
    const sourcePath = path.join(tempRoot, "chapter.txt");
    const existingOutputPath = path.join(tempRoot, "chapter.zh.txt");
    await writeFile(sourcePath, "source", "utf-8");
    await writeFile(existingOutputPath, "existing", "utf-8");

    const result = await writeTxtTargetOnlyOutput({
      sourcePath,
      targetLang: "ZH",
      outputPathMode: "source",
      conflictPolicy: "index",
      segments: [createSegment("s1", 0), createSegment("s2", 1)],
      results: [
        { segmentId: "s1", translatedText: "第一段" },
        { segmentId: "s2", translatedText: "第二段" },
      ],
    });

    expect(path.basename(result.outputPath)).toBe("chapter.zh (1).txt");
    expect(await readFile(result.outputPath, "utf-8")).toBe("第一段\n\n第二段");

    const bytes = await readFile(result.outputPath);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(result.bytesWritten).toBe(Buffer.byteLength("第一段\n\n第二段", "utf-8"));
  });

  it("supports custom output directories and overwrite policy", async () => {
    const outputDir = path.join(tempRoot, "out");
    const sourcePath = path.join(tempRoot, "chapter.txt");
    await writeFile(sourcePath, "source", "utf-8");

    const first = await writeTxtTargetOnlyOutput({
      sourcePath,
      targetLang: "EN",
      outputPathMode: "custom",
      outputDir,
      conflictPolicy: "overwrite",
      segments: [createSegment("s1", 0)],
      results: [{ segmentId: "s1", translatedText: "First" }],
    });
    const second = await writeTxtTargetOnlyOutput({
      sourcePath,
      targetLang: "EN",
      outputPathMode: "custom",
      outputDir,
      conflictPolicy: "overwrite",
      segments: [createSegment("s1", 0)],
      results: [{ segmentId: "s1", translatedText: "Second" }],
    });

    expect(first.outputPath).toBe(second.outputPath);
    expect(await readFile(second.outputPath, "utf-8")).toBe("Second");
  });
});

describe("TXT bilingual output assembler", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-output-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("places each original block next to its translated block in simple mode", () => {
    const content = assembleTxtBilingualContent({
      segments: [
        createSegment("s1", 0, { sourceText: "Hello" }),
        createSegment("s2", 1, { sourceText: "World" }),
      ],
      results: [
        { segmentId: "s1", translatedText: "你好" },
        { segmentId: "s2", translatedText: "世界" },
      ],
    });

    expect(content).toBe("Hello\n你好\n\nWorld\n世界");
  });

  it("supports explicit original and translation labels", () => {
    const content = assembleTxtBilingualContent({
      labelMode: "labels",
      segments: [createSegment("s1", 0, { sourceText: "Hello" })],
      results: [{ segmentId: "s1", translatedText: "你好" }],
    });

    expect(content).toBe("[Original]\nHello\n[Translation]\n你好");
  });

  it("keeps hard-cut segments inside one natural bilingual block", () => {
    const content = assembleTxtBilingualContent({
      segments: [
        createSegment("s1", 0, {
          sourceText: "Long ",
          endsMidUnit: true,
        }),
        createSegment("s2", 1, {
          sourceText: "paragraph",
          startsMidUnit: true,
        }),
        createSegment("s3", 2, { sourceText: "Next" }),
      ],
      results: [
        { segmentId: "s1", translatedText: "长" },
        { segmentId: "s2", translatedText: "段" },
        { segmentId: "s3", translatedText: "下一段" },
      ],
    });

    expect(content).toBe("Long paragraph\n长段\n\nNext\n下一段");
  });

  it("does not emit labels for empty protected blocks", () => {
    const content = assembleTxtBilingualContent({
      labelMode: "labels",
      segments: [
        createSegment("empty", 0, { sourceText: "" }),
        createSegment("s1", 1, { sourceText: "Hello" }),
      ],
      results: [
        { segmentId: "empty", translatedText: "" },
        { segmentId: "s1", translatedText: "你好" },
      ],
    });

    expect(content).toBe("[Original]\nHello\n[Translation]\n你好");
  });

  it("writes bilingual TXT output through the shared writer", async () => {
    const sourcePath = path.join(tempRoot, "chapter.txt");
    await writeFile(sourcePath, "source", "utf-8");

    const result = await writeTxtOutput({
      sourcePath,
      targetLang: "ZH",
      outputMode: "bilingual",
      labelMode: "labels",
      outputPathMode: "source",
      conflictPolicy: "index",
      segments: [createSegment("s1", 0, { sourceText: "Hello" })],
      results: [{ segmentId: "s1", translatedText: "你好" }],
    });

    expect(path.basename(result.outputPath)).toBe("chapter.zh.txt");
    expect(await readFile(result.outputPath, "utf-8")).toBe(
      "[Original]\nHello\n[Translation]\n你好",
    );
  });
});

function createSegment(
  segmentId: string,
  globalIndex: number,
  overrides: Partial<TranslationSegment> = {},
): TranslationSegment {
  return {
    segmentId,
    fileId: "file_001",
    indexInFile: globalIndex,
    globalIndex,
    unitIds: [`unit_${globalIndex}`],
    sourceTokenCount: 1,
    sourceTextSnapshotPath: `segments/source/${String(globalIndex).padStart(8, "0")}.txt`,
    sourceText: `source ${globalIndex}`,
    startsMidUnit: false,
    endsMidUnit: false,
    ...overrides,
  };
}
