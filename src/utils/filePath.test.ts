import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSelectedNativeFiles } from "./filePath";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSelectedNativeFiles", () => {
  it("pairs renderer File objects with main-proven original paths", async () => {
    const first = { name: "proxy.vtt" } as File;
    const second = { name: "proxy (1).vtt" } as File;
    const captureInputFile = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        data: { captureRef: "capture-one", fileCount: 1 },
      })
      .mockReturnValueOnce({
        ok: true,
        data: { captureRef: "capture-one", fileCount: 2 },
      });
    const resolveCapturedInputFiles = vi.fn(async () => ({
      ok: true as const,
      data: [
        {
          filePath: String.raw`\\?\H:\long\original.vtt`,
          displayName: "original.vtt",
          sourceDirectory: String.raw`\\?\H:\long`,
        },
        {
          filePath: String.raw`\\?\H:\long\second.vtt`,
          displayName: "second.vtt",
          sourceDirectory: String.raw`\\?\H:\long`,
        },
      ],
    }));
    vi.stubGlobal("window", {
      electronUtils: {
        bridgeVersion: 1,
        captureInputFile,
        resolveCapturedInputFiles,
        getPathForFile: vi.fn(),
      },
    });

    await expect(resolveSelectedNativeFiles([first, second], "drop"))
      .resolves.toEqual({
        ok: true,
        data: [
          {
            file: first,
            filePath: String.raw`\\?\H:\long\original.vtt`,
            displayName: "original.vtt",
            sourceDirectory: String.raw`\\?\H:\long`,
          },
          {
            file: second,
            filePath: String.raw`\\?\H:\long\second.vtt`,
            displayName: "second.vtt",
            sourceDirectory: String.raw`\\?\H:\long`,
          },
        ],
      });
    expect(captureInputFile).toHaveBeenNthCalledWith(
      1,
      first,
      undefined,
      "drop",
    );
    expect(captureInputFile).toHaveBeenNthCalledWith(
      2,
      second,
      "capture-one",
      "drop",
    );
    expect(resolveCapturedInputFiles).toHaveBeenCalledWith("capture-one");
  });
});
