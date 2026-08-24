import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_LIMITS } from "../../src/type/localSubtitle";
import {
  LocalSubtitleResourceError,
} from "../../electron/main/local-subtitle/resource-manifest";
import {
  loadLocalSubtitleRuntimeManifest,
  isLocalSubtitleVerifiedRuntimeBundle,
  resolveLocalSubtitleResourcePath,
  resolveLocalSubtitleRuntimeRoot,
  resolveVerifiedLocalSubtitleArtifact,
  selectLocalSubtitleCpuServerArtifactId,
  verifyLocalSubtitleRuntimeBundle,
} from "../../electron/main/local-subtitle/resource-path";
import {
  createMachO,
  createRuntimeFixture,
  sha256,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const fixtures: LocalSubtitleRuntimeFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("local subtitle resource roots", () => {
  it("uses only the explicit app root in development", () => {
    const appRoot = path.join(os.tmpdir(), "fusionkit-app-root");
    const environment = {
      mode: "development",
      appRoot,
      platform: "darwin",
      arch: "arm64",
    } as const;
    expect(resolveLocalSubtitleRuntimeRoot(environment)).toBe(
      path.join(
        appRoot,
        "build",
        "local-subtitle-resources",
        "local-subtitle",
      ),
    );
  });

  it("uses only resourcesPath in packaged mode", () => {
    const resourcesPath = path.join(os.tmpdir(), "FusionKit.app", "Resources");
    const environment = {
      mode: "packaged",
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
    } as const;
    expect(resolveLocalSubtitleRuntimeRoot(environment)).toBe(
      path.join(resourcesPath, "local-subtitle"),
    );
    expect(() =>
      resolveLocalSubtitleRuntimeRoot({
        mode: "packaged",
        resourcesPath: "relative/resources",
        platform: "darwin",
        arch: "arm64",
      })
    ).toThrowError(LocalSubtitleResourceError);
  });

  it("rejects macOS x64 before reading a root or manifest", async () => {
    await expect(
      loadLocalSubtitleRuntimeManifest({
        mode: "packaged",
        resourcesPath: "/path/that/does/not/exist",
        platform: "darwin",
        arch: "x64",
      }),
    ).rejects.toMatchObject({ code: "unsupported_architecture" });
  });
});

describe("local subtitle runtime verification", () => {
  it("verifies a complete development bundle and returns immutable ID paths", async () => {
    const fixture = await trackedFixture();
    const signaturePaths: string[] = [];
    const bundle = await verifyLocalSubtitleRuntimeBundle({
      environment: fixture.environment,
      signatureVerifier: async (absolutePath) => {
        signaturePaths.push(absolutePath);
        return true;
      },
    });

    expect(bundle.ready).toBe(true);
    expect(bundle.noPathFallback).toBe(true);
    expect(bundle.runtimeGeneration).toBe(bundle.manifestSha256);
    expect(bundle.integrityProfile).toBe(
      "macos_nested_signed_final_bytes_sha256",
    );
    expect(Object.keys(bundle.artifactPaths)).toHaveLength(3);
    expect(Object.isFrozen(bundle.artifactPaths)).toBe(true);
    expect(signaturePaths).toHaveLength(3);
    expect(
      signaturePaths.every((absolutePath) =>
        absolutePath.startsWith(`${fixture.runtimeRoot}${path.sep}`)
      ),
    ).toBe(true);

    const ffmpeg = resolveVerifiedLocalSubtitleArtifact(
      bundle,
      "ffmpeg-mac-arm64",
    );
    expect(ffmpeg.absolutePath).toBe(
      fixture.artifactPaths["ffmpeg-mac-arm64"],
    );
    expect(resolveLocalSubtitleResourcePath(bundle, "ffmpeg-mac-arm64")).toBe(
      ffmpeg.absolutePath,
    );
    expect(selectLocalSubtitleCpuServerArtifactId(bundle)).toBe(
      "whisper-server-mac-arm64-metal-cpu",
    );
    const forged = { ...bundle } as typeof bundle;
    for (const symbol of Object.getOwnPropertySymbols(bundle)) {
      Object.defineProperty(forged, symbol, {
        value: Reflect.get(bundle, symbol),
      });
    }
    Object.freeze(forged);
    expect(isLocalSubtitleVerifiedRuntimeBundle(forged)).toBe(false);
    expect(() =>
      resolveVerifiedLocalSubtitleArtifact(forged, "ffmpeg-mac-arm64")
    ).toThrowError(LocalSubtitleResourceError);
    expect(() => selectLocalSubtitleCpuServerArtifactId(forged)).toThrowError(
      expect.objectContaining({ code: "runtime_protocol_mismatch" }),
    );
    expect(() =>
      resolveVerifiedLocalSubtitleArtifact(bundle, "not-in-manifest")
    ).toThrowError(LocalSubtitleResourceError);
  });

  it("verifies the complete unsigned Windows packaged profile", async () => {
    const fixture = await trackedFixture({
      platform: "win32",
      arch: "x64",
      mode: "packaged",
    });
    let signatureCalls = 0;
    const bundle = await verifyLocalSubtitleRuntimeBundle({
      environment: fixture.environment,
      signatureVerifier: async () => {
        signatureCalls += 1;
        return false;
      },
    });

    expect(bundle.integrityProfile).toBe(
      "windows_unsigned_personal_final_bytes_sha256",
    );
    expect(Object.keys(bundle.artifactPaths)).toHaveLength(15);
    expect(signatureCalls).toBe(0);
    expect(selectLocalSubtitleCpuServerArtifactId(bundle)).toBe(
      "whisper-server-win-x64-cpu",
    );
  });

  it("rejects a verified scope without a CPU-capable server", async () => {
    const fixture = await trackedFixture();
    const media = await verifyLocalSubtitleRuntimeBundle({
      environment: fixture.environment,
      scope: "media",
      signatureVerifier: async () => true,
    });

    expect(() => selectLocalSubtitleCpuServerArtifactId(media)).toThrowError(
      expect.objectContaining({
        code: "runtime_missing",
        stage: "static_verification",
      }),
    );
  });

  it("does not fall back to a development root or PATH in packaged mode", async () => {
    const fixture = await trackedFixture();
    const maliciousBin = path.join(fixture.tempRoot, "malicious-bin");
    await mkdir(maliciousBin, { recursive: true });
    await writeFile(path.join(maliciousBin, "ffmpeg"), "malicious", {
      mode: 0o755,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = maliciousBin;
    try {
      await expect(
        verifyLocalSubtitleRuntimeBundle({
          environment: {
            mode: "packaged",
            resourcesPath: path.join(fixture.tempRoot, "empty-resources"),
            platform: "darwin",
            arch: "arm64",
          },
          signatureVerifier: async () => true,
        }),
      ).rejects.toMatchObject({ code: "media_runtime_missing" });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("classifies missing media and server artifacts separately", async () => {
    const mediaFixture = await trackedFixture();
    await rm(mediaFixture.artifactPaths["ffmpeg-mac-arm64"]!);
    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: mediaFixture.environment,
        scope: "media",
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_missing" });

    const serverFixture = await trackedFixture();
    await rm(
      serverFixture.artifactPaths[
        "whisper-server-mac-arm64-metal-cpu"
      ]!,
    );
    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: serverFixture.environment,
        scope: "server",
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "runtime_missing" });
  });

  it("rejects same-size content changes instead of trusting byteSize", async () => {
    const fixture = await trackedFixture();
    await verifyLocalSubtitleRuntimeBundle({
      environment: fixture.environment,
      scope: "media",
      signatureVerifier: async () => true,
    });
    const ffmpegPath = fixture.artifactPaths["ffmpeg-mac-arm64"]!;
    const content = await readFile(ffmpegPath);
    content[content.length - 1] ^= 0xff;
    await writeFile(ffmpegPath, content);
    await chmod(ffmpegPath, 0o755);

    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        scope: "media",
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects a wrong architecture even when size and hash are updated", async () => {
    const fixture = await trackedFixture();
    const ffmpeg = fixture.manifest.artifacts.find(
      (artifact) => artifact.id === "ffmpeg-mac-arm64",
    )!;
    const ffmpegPath = fixture.artifactPaths[ffmpeg.id]!;
    const x64 = createMachO("x64");
    await writeFile(ffmpegPath, x64);
    await chmod(ffmpegPath, 0o755);
    ffmpeg.byteSize = x64.length;
    ffmpeg.sha256 = sha256(x64);
    await fixture.rewriteManifest();

    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        scope: "media",
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects a non-executable macOS program", async () => {
    const fixture = await trackedFixture();
    await chmod(fixture.artifactPaths["ffprobe-mac-arm64"]!, 0o644);
    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        scope: "media",
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects parent symlinks even when evidence hashes still match", async () => {
    const fixture = await trackedFixture();
    const evidenceDirectory = path.join(fixture.runtimeRoot, "licenses");
    const outsideDirectory = path.join(fixture.tempRoot, "outside-licenses");
    await rename(evidenceDirectory, outsideDirectory);
    await symlink(outsideDirectory, evidenceDirectory, directoryLinkType());

    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        signatureVerifier: async () => true,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects a symlink in the development staging root", async () => {
    const fixture = await trackedFixture();
    const buildDirectory = path.join(fixture.tempRoot, "build");
    const outsideBuild = path.join(fixture.tempRoot, "outside-build");
    await rename(buildDirectory, outsideBuild);
    await symlink(outsideBuild, buildDirectory, directoryLinkType());

    await expect(
      loadLocalSubtitleRuntimeManifest(fixture.environment),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects a declared signature when verification fails", async () => {
    const fixture = await trackedFixture();
    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        scope: "media",
        signatureVerifier: async () => false,
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rechecks static bytes after an external signature verifier", async () => {
    const fixture = await trackedFixture();
    let mutated = false;
    await expect(
      verifyLocalSubtitleRuntimeBundle({
        environment: fixture.environment,
        scope: "media",
        signatureVerifier: async (absolutePath) => {
          if (!mutated) {
            const bytes = await readFile(absolutePath);
            bytes[bytes.length - 1] ^= 0xff;
            await writeFile(absolutePath, bytes);
            await chmod(absolutePath, 0o755);
            mutated = true;
          }
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it("rejects oversized manifests before JSON parsing", async () => {
    const oversized = await trackedFixture();
    await writeFile(
      oversized.manifestPath,
      Buffer.alloc(LOCAL_SUBTITLE_LIMITS.maxRuntimeManifestBytes + 1),
    );
    await expect(
      loadLocalSubtitleRuntimeManifest(oversized.environment),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link manifests before JSON parsing",
    async () => {
    const symbolic = await trackedFixture();
    const realManifest = path.join(symbolic.tempRoot, "manifest.json");
    await rename(symbolic.manifestPath, realManifest);
    await symlink(realManifest, symbolic.manifestPath);
    await expect(
      loadLocalSubtitleRuntimeManifest(symbolic.environment),
    ).rejects.toMatchObject({ code: "media_runtime_invalid" });
    },
  );
});

async function trackedFixture(
  options?: Parameters<typeof createRuntimeFixture>[0],
): Promise<LocalSubtitleRuntimeFixture> {
  const fixture = await createRuntimeFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function directoryLinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}
