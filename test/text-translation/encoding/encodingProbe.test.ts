import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/encoding-fixtures.json";
import {
  probeTextEncoding,
  type SupportedTextEncoding,
} from "./encodingProbe";

type Fixture = {
  id: string;
  expectedEncoding: SupportedTextEncoding;
  hasBom: boolean;
  text: string;
  base64: string;
};

describe("PRE-001 encoding dependency probe", () => {
  it.each(fixtures as Fixture[])(
    "detects and decodes $id as $expectedEncoding",
    (fixture) => {
      const result = probeTextEncoding(Buffer.from(fixture.base64, "base64"));

      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") return;

      expect(result.encoding).toBe(fixture.expectedEncoding);
      expect(result.hasBom).toBe(fixture.hasBom);
      expect(result.text).toBe(fixture.text);
      expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    },
  );

  it("accepts plain ASCII through the strict UTF-8 fast path", () => {
    const result = probeTextEncoding(
      Buffer.from(
        "A plain ASCII chapter remains valid UTF-8 and needs no statistical guess.",
        "ascii",
      ),
    );

    expect(result).toMatchObject({
      status: "accepted",
      encoding: "utf-8",
      source: "strict_utf8",
      confidence: 1,
    });
  });

  it("detects BOM-less UTF-16 with a strong byte-position pattern", () => {
    const text =
      "Chapter 01: UTF-16 without BOM.\nThis sample has enough ASCII structure.";
    const buffer = Buffer.from(text, "utf16le");
    const result = probeTextEncoding(buffer);

    expect(result).toMatchObject({
      status: "accepted",
      encoding: "utf-16le",
      source: "utf16_heuristic",
    });
    if (result.status === "accepted") {
      expect(result.text).toBe(text);
    }
  });

  it("detects BOM-less UTF-16BE with a strong byte-position pattern", () => {
    const text =
      "Chapter 02: UTF-16BE without BOM.\nThis sample also has clear ASCII structure.";
    const buffer = Buffer.from(text, "utf16le").swap16();
    const result = probeTextEncoding(buffer);

    expect(result).toMatchObject({
      status: "accepted",
      encoding: "utf-16be",
      source: "utf16_heuristic",
    });
    if (result.status === "accepted") {
      expect(result.text).toBe(text);
    }
  });

  it("rejects control-heavy binary data instead of guessing a text encoding", () => {
    const binary = Buffer.from(
      Array.from({ length: 512 }, (_, index) => index % 32),
    );
    const result = probeTextEncoding(binary);

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.manualOverrideOptions).toContain("gb18030");
      expect(result.manualOverrideOptions).toContain("shift_jis");
    }
  });

  it("rejects an empty input so the caller can apply the empty-file policy", () => {
    expect(probeTextEncoding(Buffer.alloc(0))).toMatchObject({
      status: "rejected",
      reason: "empty_input",
    });
  });

  it("proves iconv-lite applies Windows-1252 punctuation mappings", () => {
    const fixture = (fixtures as Fixture[]).find(
      (item) => item.id === "windows_1252",
    );
    expect(fixture).toBeDefined();

    const result = probeTextEncoding(
      Buffer.from(fixture!.base64, "base64"),
    );

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.text).toContain("—");
      expect(result.text).toContain("“It’s déjà vu,”");
      expect(result.text).toContain("€");
      expect(result.text).not.toMatch(/[\u0080-\u009F]/);
    }
  });
});
