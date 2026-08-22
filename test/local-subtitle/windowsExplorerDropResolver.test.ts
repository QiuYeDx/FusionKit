import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseExplorerSelectionGroups,
  resolveLocalSubtitleInputPaths,
} from "../../electron/main/local-subtitle/windows-explorer-drop-resolver";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("Windows Explorer local subtitle drop resolver", () => {
  it("parses bounded Explorer selection groups without exposing extra fields", () => {
    expect(parseExplorerSelectionGroups(JSON.stringify([{
      windowHandle: "123",
      items: [{ path: String.raw`\\?\H:\long\track.mp3`, name: "track.mp3" }],
    }]))).toEqual([{
      windowHandle: "123",
      items: [{ path: String.raw`\\?\H:\long\track.mp3`, name: "track.mp3" }],
    }]);
    expect(() => parseExplorerSelectionGroups(JSON.stringify([{
      windowHandle: "123",
      items: [{ path: "C:\\track.mp3", name: "track.mp3", extra: true }],
    }]))).toThrow("Explorer selection item is invalid");
  });

  it.runIf(process.platform === "win32")(
    "replaces a numbered Shell temp proxy with the unique original selection",
    async () => {
      const proxyRoot = await temporaryDirectory("fusionkit-drop-proxy-");
      const sourceRoot = await temporaryDirectory("fusionkit-drop-source-");
      const source = path.join(sourceRoot, "長い名前の音声♪.mp3");
      const proxy = path.join(proxyRoot, "長い名前の音声♪ (1).mp3");
      await Promise.all([
        writeFile(source, "same-media-bytes"),
        writeFile(proxy, "same-media-bytes"),
      ]);

      await expect(resolveLocalSubtitleInputPaths([proxy], "drop", {
        platform: "win32",
        tempDirectory: proxyRoot,
        querySelections: async () => [{
          windowHandle: "100",
          items: [{ path: source, name: path.basename(source) }],
        }],
      })).resolves.toEqual([await realpath(source)]);
    },
  );

  it.runIf(process.platform === "win32")(
    "never consults Explorer for picker input or a direct drop",
    async () => {
      const proxyRoot = await temporaryDirectory("fusionkit-drop-proxy-");
      const sourceRoot = await temporaryDirectory("fusionkit-drop-source-");
      const proxy = path.join(proxyRoot, "proxy.mp3");
      const direct = path.join(sourceRoot, "direct.mp3");
      await Promise.all([writeFile(proxy, "proxy"), writeFile(direct, "direct")]);
      const querySelections = vi.fn(async () => []);

      await expect(resolveLocalSubtitleInputPaths([proxy], "picker", {
        platform: "win32",
        tempDirectory: proxyRoot,
        querySelections,
      })).resolves.toEqual([proxy]);
      await expect(resolveLocalSubtitleInputPaths([direct], "drop", {
        platform: "win32",
        tempDirectory: proxyRoot,
        querySelections,
      })).resolves.toEqual([direct]);
      expect(querySelections).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when the current Explorer selection is ambiguous or changed",
    async () => {
      const proxyRoot = await temporaryDirectory("fusionkit-drop-proxy-");
      const sourceRoot = await temporaryDirectory("fusionkit-drop-source-");
      const source = path.join(sourceRoot, "track.mp3");
      const proxy = path.join(proxyRoot, "track (1).mp3");
      await Promise.all([writeFile(source, "bytes"), writeFile(proxy, "bytes")]);
      const group = {
        windowHandle: "100",
        items: [{ path: source, name: "track.mp3" }],
      } as const;

      await expect(resolveLocalSubtitleInputPaths([proxy], "drop", {
        platform: "win32",
        tempDirectory: proxyRoot,
        querySelections: async () => [group, { ...group, windowHandle: "101" }],
      })).rejects.toMatchObject({
        code: "authorization_expired",
        field: "files",
      });

      await writeFile(source, "different-size");
      await expect(resolveLocalSubtitleInputPaths([proxy], "drop", {
        platform: "win32",
        tempDirectory: proxyRoot,
        querySelections: async () => [group],
      })).rejects.toMatchObject({ code: "authorization_expired" });
    },
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
