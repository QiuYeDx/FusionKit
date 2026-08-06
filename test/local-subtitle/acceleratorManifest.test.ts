import { describe, expect, it } from "vitest";
import rawManifest from "../../resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json";
import {
  LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT,
  LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST,
  LocalSubtitleAcceleratorManifestError,
  parseLocalSubtitleAcceleratorManifest,
} from "../../electron/main/local-subtitle/accelerator-manifest";

describe("local subtitle accelerator manifest", () => {
  it("freezes the pinned Windows CUDA archive and selected artifacts", () => {
    expect(LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.packId).toBe(
      "local-subtitle-windows-x64-cuda-12.4-v1",
    );
    expect(
      LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.allowedDownloadHosts,
    ).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
    expect(LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.artifacts).toHaveLength(20);
    expect(
      LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.selectedEntries,
    ).toHaveLength(20);
    expect(
      LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.selectedEntries[0]?.archiveName,
    ).toMatch(/^Release\//u);
    expect(
      LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.excludedEntries.every(
        (entry) => entry.startsWith("Release/"),
      ),
    ).toBe(true);
    expect([
      ...LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.selectedEntries,
      ...LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.excludedEntries,
    ]).toHaveLength(44);
    expect(
      LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT.selectedEntries.reduce(
        (total, entry) => total + entry.byteSize,
        0,
      ),
    ).toBe(1_199_083_008);
    expect(Object.isFrozen(LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST)).toBe(true);
  });

  it("rejects source, allowlist, artifact, and excluded-entry drift", () => {
    const cases = [
      {
        ...structuredClone(rawManifest),
        sourceArchive: {
          ...structuredClone(rawManifest.sourceArchive),
          allowedDownloadHosts: ["github.com", "example.com"],
        },
      },
      {
        ...structuredClone(rawManifest),
        artifacts: structuredClone(rawManifest.artifacts).map(
          (artifact, index) => index === 0
            ? { ...artifact, sha256: "0".repeat(64) }
            : artifact,
        ),
      },
      {
        ...structuredClone(rawManifest),
        selection: {
          ...structuredClone(rawManifest.selection),
          excludedArchiveEntries: [
            ...rawManifest.selection.excludedArchiveEntries.slice(0, -1),
            "unexpected.exe",
          ],
        },
      },
    ];

    for (const candidate of cases) {
      expect(() => parseLocalSubtitleAcceleratorManifest(candidate)).toThrow(
        LocalSubtitleAcceleratorManifestError,
      );
    }
  });

  it("rejects unknown fields and unsafe output paths", () => {
    expect(() => parseLocalSubtitleAcceleratorManifest({
      ...structuredClone(rawManifest),
      unknown: true,
    })).toThrow(LocalSubtitleAcceleratorManifestError);

    const changed = structuredClone(rawManifest);
    changed.artifacts[0]!.relativePath = "../whisper-server.exe";
    expect(() => parseLocalSubtitleAcceleratorManifest(changed)).toThrow(
      LocalSubtitleAcceleratorManifestError,
    );
  });
});
