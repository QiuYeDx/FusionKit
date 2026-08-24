import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_TRANSCRIBER_ROUTE,
  ToolNameMap,
} from "@/constants/router";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";

describe("local subtitle transcriber registration", () => {
  it("registers an independent subtitle route and menu label", () => {
    expect(LOCAL_SUBTITLE_TRANSCRIBER_ROUTE).toBe(
      "/tools/subtitle/local-transcriber",
    );
    expect(TOOL_META.localSubtitleTranscriber).toMatchObject({
      category: "subtitle",
      status: "stable",
      route: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE,
    });
    expect(TOOL_META.localSubtitleTranscriber.route).not.toContain("/audio/");
    expect(ToolNameMap[LOCAL_SUBTITLE_TRANSCRIBER_ROUTE]).toBe(
      "menu.subtitle.local_transcriber",
    );
  });
});
