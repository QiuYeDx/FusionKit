import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeFileSelectionIpcService } from "../../electron/main/fs/native-file-selection-ipc";
import { resolveLocalSubtitleInputPaths } from "../../electron/main/local-subtitle/windows-explorer-drop-resolver";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("native file selection IPC service", () => {
  it.runIf(process.platform === "win32")(
    "returns the proven original path instead of a Shell temp proxy",
    async () => {
      const proxyRoot = await temporaryDirectory("fusionkit-native-proxy-");
      const sourceRoot = await temporaryDirectory("fusionkit-native-source-");
      const source = path.join(sourceRoot, "超长路径字幕.wav.vtt");
      const proxy = path.join(proxyRoot, "超长路径字幕.wav (1).vtt");
      await Promise.all([
        writeFile(source, "WEBVTT\n\n00:00.000 --> 00:01.000\nsource"),
        writeFile(proxy, "WEBVTT\n\n00:00.000 --> 00:01.000\nsource"),
      ]);
      const service = new NativeFileSelectionIpcService({
        resolveInputPaths: (paths, sourceKind) =>
          resolveLocalSubtitleInputPaths(paths, sourceKind, {
            platform: "win32",
            tempDirectory: proxyRoot,
            querySelections: async () => [{
              windowHandle: "100",
              items: [{ path: source, name: path.basename(source) }],
            }],
          }),
      });

      await expect(service.resolveInputFiles({
        source: "drop",
        files: [{ filePath: proxy }],
      })).resolves.toEqual({
        ok: true,
        data: [{
          filePath: await realpath(source),
          displayName: path.basename(source),
          sourceDirectory: await realpath(sourceRoot),
        }],
      });
    },
  );

  it("rejects renderer-shaped raw path injections before resolution", async () => {
    const service = new NativeFileSelectionIpcService({
      resolveInputPaths: async () => {
        throw new Error("must not run");
      },
    });
    await expect(service.resolveInputFiles({
      source: "drop",
      files: [{ path: String.raw`C:\private\subtitle.vtt` }],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", field: "files" },
    });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
