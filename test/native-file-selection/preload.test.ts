import { describe, expect, it, vi } from "vitest";
import { createNativeFileSelectionRendererApi } from "../../electron/preload/native-file-selection-api";
import { NATIVE_FILE_SELECTION_INTERNAL_CHANNELS } from "../../src/type/nativeFileSelectionIpc";
import { assertLegacyNativeFileSelectionChannelAllowed } from "../../electron/preload/native-file-selection-channel-policy";

describe("native file selection preload bridge", () => {
  it("keeps the internal resolver out of the generic legacy invoke bridge", () => {
    expect(() => assertLegacyNativeFileSelectionChannelAllowed(
      NATIVE_FILE_SELECTION_INTERNAL_CHANNELS.resolveInputFiles,
    )).toThrow(/fixed electronUtils/);
    expect(() => assertLegacyNativeFileSelectionChannelAllowed(
      "select-output-directory",
    )).not.toThrow();
  });

  it("captures every native path synchronously and resolves the batch once", async () => {
    const first = {} as File;
    const second = {} as File;
    const paths = new Map<File, string>([
      [first, String.raw`C:\Users\example\AppData\Local\Temp\track.vtt`],
      [second, String.raw`C:\Users\example\AppData\Local\Temp\track (1).vtt`],
    ]);
    const getPathForFile = vi.fn((file: File) => paths.get(file) ?? "");
    const invoke = vi.fn(async () => ({
      ok: true,
      data: [
        {
          filePath: String.raw`\\?\H:\long\source\track.vtt`,
          displayName: "track.vtt",
          sourceDirectory: String.raw`\\?\H:\long\source`,
        },
        {
          filePath: String.raw`\\?\H:\long\source\track-two.vtt`,
          displayName: "track-two.vtt",
          sourceDirectory: String.raw`\\?\H:\long\source`,
        },
      ],
    }));
    const api = createNativeFileSelectionRendererApi({
      ipcRenderer: { invoke } as never,
      webUtils: { getPathForFile } as never,
      createCaptureNonce: () => "a".repeat(32),
    });

    const firstCapture = api.captureInputFile(first, undefined, "drop");
    expect(firstCapture.ok).toBe(true);
    if (!firstCapture.ok) throw new Error("Expected first capture.");
    const secondCapture = api.captureInputFile(
      second,
      firstCapture.data.captureRef,
      "drop",
    );
    expect(secondCapture).toEqual({
      ok: true,
      data: {
        captureRef: `native_file_input_${"a".repeat(32)}`,
        fileCount: 2,
      },
    });
    expect(getPathForFile.mock.calls.map(([file]) => file)).toEqual([
      first,
      second,
    ]);
    expect(invoke).not.toHaveBeenCalled();

    if (!secondCapture.ok) throw new Error("Expected complete capture.");
    await expect(
      api.resolveCapturedInputFiles(secondCapture.data.captureRef),
    ).resolves.toMatchObject({
      ok: true,
      data: [
        { displayName: "track.vtt" },
        { displayName: "track-two.vtt" },
      ],
    });
    expect(invoke).toHaveBeenCalledWith(
      NATIVE_FILE_SELECTION_INTERNAL_CHANNELS.resolveInputFiles,
      {
        source: "drop",
        files: [
          { filePath: paths.get(first) },
          { filePath: paths.get(second) },
        ],
      },
    );
  });

  it("expires one-shot captures instead of reusing stale native paths", async () => {
    let now = 1_000;
    const api = createNativeFileSelectionRendererApi({
      ipcRenderer: { invoke: vi.fn() } as never,
      webUtils: { getPathForFile: () => String.raw`C:\source\track.vtt` } as never,
      now: () => now,
      createCaptureNonce: () => "b".repeat(32),
    });
    const capture = api.captureInputFile({} as File, undefined, "picker");
    if (!capture.ok) throw new Error("Expected capture.");
    now += 30_000;

    await expect(
      api.resolveCapturedInputFiles(capture.data.captureRef),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_expired", field: "captureRef" },
    });
  });
});
