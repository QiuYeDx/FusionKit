import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixtures from "../encoding/fixtures/encoding-fixtures.json";
import {
  detectTextEncoding,
  type SupportedTextEncoding,
} from "../../../electron/main/text-translation/input/encoding-detector";
import {
  TextTranslationInputFileError,
  detectTextTranslationFileFormat,
  readAndDecodeTextTranslationInputFile,
} from "../../../electron/main/text-translation/input/file-reader";

type Fixture = {
  id: string;
  expectedEncoding: SupportedTextEncoding;
  hasBom: boolean;
  text: string;
  base64: string;
};

describe("text translation input file reader", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-text-input-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each(fixtures as Fixture[])(
    "detects and decodes $id as $expectedEncoding",
    (fixture) => {
      const result = detectTextEncoding(Buffer.from(fixture.base64, "base64"));

      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") return;

      expect(result.encoding).toBe(fixture.expectedEncoding);
      expect(result.hasBom).toBe(fixture.hasBom);
      expect(result.text).toBe(fixture.text);
    },
  );

  it("reads a UTF-8 txt file into metadata, fingerprint, and normalized text", async () => {
    const sourcePath = path.join(tempRoot, "chapter.txt");
    await writeFile(sourcePath, "Line 1\r\nLine 2", "utf-8");

    const result = await readAndDecodeTextTranslationInputFile({
      sourcePath,
      order: 0,
    });

    expect(result.file).toMatchObject({
      sourcePath,
      fileName: "chapter.txt",
      format: "txt",
      order: 0,
    });
    expect(result.file.fileId).toMatch(/^file_0000_[a-f0-9]{12}$/);
    expect(result.fingerprint.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.encoding).toMatchObject({
      encoding: "utf-8",
      source: "strict_utf8",
      manualOverride: false,
    });
    expect(result.text).toBe("Line 1\nLine 2");
    expect(result.newlineNormalized).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("supports manual override for known legacy encodings", async () => {
    const fixture = (fixtures as Fixture[]).find(
      (item) => item.id === "windows_1252",
    );
    expect(fixture).toBeDefined();

    const sourcePath = path.join(tempRoot, "legacy.txt");
    await writeFile(sourcePath, Buffer.from(fixture!.base64, "base64"));

    const result = await readAndDecodeTextTranslationInputFile({
      sourcePath,
      order: 0,
      manualEncoding: "windows-1252",
    });

    expect(result.encoding).toMatchObject({
      encoding: "windows-1252",
      source: "manual_override",
      manualOverride: true,
    });
    expect(result.text).toContain("—");
    expect(result.text).toContain("€");
  });

  it("rejects binary-like input before any model request can be made", async () => {
    const sourcePath = path.join(tempRoot, "binary.txt");
    await writeFile(
      sourcePath,
      Buffer.from(Array.from({ length: 512 }, (_, index) => index % 32)),
    );

    await expect(
      readAndDecodeTextTranslationInputFile({ sourcePath, order: 0 }),
    ).rejects.toMatchObject({
      code: "encoding_detection_failed",
      phase: "detecting_encoding",
    });
  });

  it("returns structured errors for unsupported extensions and missing files", async () => {
    expect(() => detectTextTranslationFileFormat("/tmp/book.pdf")).toThrow(
      TextTranslationInputFileError,
    );

    await expect(
      readAndDecodeTextTranslationInputFile({
        sourcePath: path.join(tempRoot, "missing.txt"),
        order: 0,
      }),
    ).rejects.toMatchObject({
      code: "file_not_found",
      phase: "inspecting_files",
    });
  });
});
