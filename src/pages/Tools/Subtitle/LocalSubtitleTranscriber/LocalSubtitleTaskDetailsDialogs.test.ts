import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS,
  createLocalSubtitleArtifactPreviewPage,
} from "./LocalSubtitleTaskDetailsDialogs";

describe("local subtitle artifact preview pagination", () => {
  it("bounds requested pages without changing the artifact text", () => {
    const rawText = "a".repeat(LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS) + "tail";

    const first = createLocalSubtitleArtifactPreviewPage(rawText, -1);
    const second = createLocalSubtitleArtifactPreviewPage(rawText, 99);

    expect(first).toEqual({
      pageIndex: 0,
      pageCount: 2,
      text: "a".repeat(LOCAL_SUBTITLE_ARTIFACT_PREVIEW_PAGE_CHARS),
    });
    expect(second).toEqual({ pageIndex: 1, pageCount: 2, text: "tail" });
    expect(first.text + second.text).toBe(rawText);
  });

  it("falls back to the bounded default for invalid page sizes", () => {
    expect(createLocalSubtitleArtifactPreviewPage("subtitle", 0, 0)).toEqual({
      pageIndex: 0,
      pageCount: 1,
      text: "subtitle",
    });
  });
});
