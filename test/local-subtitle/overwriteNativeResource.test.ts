import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const moduleLoader = vi.hoisted(() => vi.fn());

vi.mock("node:module", () => ({
  createRequire: () => moduleLoader,
}));

import {
  createLocalSubtitleOverwriteNativeRuntime,
} from "../../electron/main/local-subtitle/overwrite-native-backend";
import {
  LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION,
  LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION,
  LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION,
  isLocalSubtitleVerifiedOverwriteNativeAddon,
  verifyLocalSubtitleOverwriteNativeAddon,
  type LocalSubtitleVerifiedOverwriteNativeAddon,
} from "../../electron/main/local-subtitle/overwrite-native-resource";

const TARGET = process.platform === "darwin" && process.arch === "arm64"
  ? ({
      id: "darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      format: "mach-o",
      minimumOsVersion: "11.0.0",
      hasLoadCommandUuid: true,
      signatureKind: "adhoc",
      binaryHashPhase:
        "after_nested_code_signing_before_outer_bundle_signing",
    } as const)
  : process.platform === "win32" && process.arch === "x64"
    ? ({
        id: "win32-x64",
        platform: "win32",
        arch: "x64",
        format: "pe",
        minimumOsVersion: null,
        hasLoadCommandUuid: false,
        signatureKind: "unsigned",
        binaryHashPhase: "unsigned_final_bytes_before_outer_packaging",
      } as const)
    : undefined;

interface Fixture {
  readonly appRoot: string;
  readonly artifactBytes: Buffer;
  readonly proof: LocalSubtitleVerifiedOverwriteNativeAddon;
}

describe.sequential.runIf(TARGET !== undefined)(
  "local subtitle verified overwrite native resource",
  () => {
    const fixtures: Fixture[] = [];
    let primary: Fixture;
    let postLoadMutation: Fixture;
    let anotherGeneration: Fixture;

    beforeAll(async () => {
      primary = await createFixture(0x11);
      postLoadMutation = await createFixture(0x22);
      anotherGeneration = await createFixture(0x33);
      fixtures.push(primary, postLoadMutation, anotherGeneration);
    });

    afterAll(async () => {
      await Promise.all(fixtures.map(({ appRoot }) =>
        rm(appRoot, { recursive: true, force: true })
      ));
    });

    it("verifies the exact staged manifest, build receipt, target, and signature", () => {
      expect(isLocalSubtitleVerifiedOverwriteNativeAddon(primary.proof)).toBe(true);
      expect(Object.isFrozen(primary.proof)).toBe(true);
      expect(Object.isFrozen(primary.proof.artifact)).toBe(true);
      expect(primary.proof.target).toEqual({
        platform: TARGET!.platform,
        architecture: TARGET!.arch,
      });
      expect(primary.proof.artifact).toMatchObject({
        relativePath: `native/${TARGET!.id}/local-subtitle-overwrite.${primary.proof.artifact.sha256}.node`,
        format: TARGET!.format,
        architecture: TARGET!.arch,
        minimumOsVersion: TARGET!.minimumOsVersion,
        hasLoadCommandUuid: TARGET!.hasLoadCommandUuid,
        napiVersion: LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION,
        nativeProtocolVersion: LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION,
        journalVersion: LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION,
      });
      expect(primary.proof.buildReceipt.relativePath).toBe("build-receipt.v1.json");
      expect(primary.proof.addonGeneration).toMatch(/^[a-f0-9]{64}$/u);
    });

    it("rejects a raw path and an unbranded structural proof before module loading", () => {
      moduleLoader.mockReset();
      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime(
          primary.proof.artifact.absolutePath as never,
        )
      ).toThrowError(expect.objectContaining({ code: "invalid_verification_proof" }));
      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime({ ...primary.proof } as never)
      ).toThrowError(expect.objectContaining({ code: "invalid_verification_proof" }));
      expect(moduleLoader).not.toHaveBeenCalled();
    });

    it("detects artifact mutation after require and poisons that generation", () => {
      moduleLoader.mockReset();
      moduleLoader.mockImplementation(() => {
        const changed = Buffer.from(postLoadMutation.artifactBytes);
        changed[changed.length - 1] ^= 0xff;
        writeFileSync(postLoadMutation.proof.artifact.absolutePath, changed);
        return validRawModule();
      });

      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime(postLoadMutation.proof)
      ).toThrowError(expect.objectContaining({ code: "verified_artifact_changed" }));
      expect(moduleLoader).toHaveBeenCalledOnce();
      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime(postLoadMutation.proof)
      ).toThrowError(expect.objectContaining({ code: "verified_artifact_changed" }));
      expect(moduleLoader).toHaveBeenCalledOnce();
    });

    it("loads once and binds the Node cache to the proof generation and path", () => {
      moduleLoader.mockReset();
      moduleLoader.mockReturnValue(validRawModule());

      const first = createLocalSubtitleOverwriteNativeRuntime(primary.proof);
      const second = createLocalSubtitleOverwriteNativeRuntime(primary.proof);

      expect(second).toBe(first);
      expect(moduleLoader).toHaveBeenCalledOnce();
      expect(moduleLoader).toHaveBeenCalledWith(primary.proof.artifact.absolutePath);
    });

    it("rejects a different verified generation after the process is bound", () => {
      expect(() =>
        createLocalSubtitleOverwriteNativeRuntime(anotherGeneration.proof)
      ).toThrowError(expect.objectContaining({ code: "generation_conflict" }));
      expect(moduleLoader).toHaveBeenCalledOnce();
    });

    it("rejects a validly hashed receipt with incompatible semantics", async () => {
      const appRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-overwrite-receipt-"));
      fixtures.push({ appRoot } as Fixture);
      const staged = await stageFixture(appRoot, 0x44, (receipt) => ({
        ...receipt,
        workPackage: "OTHER-001",
      }));

      await expect(verifyFixture(appRoot)).rejects.toMatchObject({
        code: "invalid_receipt",
      });
      expect(staged.manifest.buildReceipt.sha256).toMatch(/^[a-f0-9]{64}$/u);
    });

    it("rejects a non-content-addressed artifact path", async () => {
      const appRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-overwrite-path-"));
      fixtures.push({ appRoot } as Fixture);
      await stageFixture(appRoot, 0x55, undefined, (manifest) => ({
        ...manifest,
        artifact: {
          ...manifest.artifact,
          relativePath: `native/${TARGET!.id}/local-subtitle-overwrite.node`,
        },
      }));

      await expect(verifyFixture(appRoot)).rejects.toMatchObject({
        code: "invalid_manifest",
      });
    });
  },
);

async function createFixture(marker: number): Promise<Fixture> {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "fusionkit-overwrite-proof-"));
  const staged = await stageFixture(appRoot, marker);
  const proof = await verifyFixture(appRoot);
  return { appRoot, artifactBytes: staged.artifactBytes, proof };
}

async function verifyFixture(
  appRoot: string,
): Promise<LocalSubtitleVerifiedOverwriteNativeAddon> {
  return verifyLocalSubtitleOverwriteNativeAddon({
    environment: {
      mode: "development",
      appRoot,
      platform: TARGET!.platform,
      arch: TARGET!.arch,
    },
    signatureVerifier: async () => true,
  });
}

async function stageFixture(
  appRoot: string,
  marker: number,
  mutateReceipt?: (receipt: Record<string, unknown>) => Record<string, unknown>,
  mutateManifest?: (manifest: Record<string, unknown>) => Record<string, unknown>,
) {
  const root = path.join(
    appRoot,
    "build/local-subtitle-resources/local-subtitle/overwrite/v1",
  );
  const artifactBytes = createNativeBinary(marker);
  const artifactSha256 = sha256(artifactBytes);
  const artifactRelativePath =
    `native/${TARGET!.id}/local-subtitle-overwrite.${artifactSha256}.node`;
  const receiptValue = mutateReceipt?.(createBuildReceipt(artifactBytes)) ??
    createBuildReceipt(artifactBytes);
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptValue, null, 2)}\n`, "utf8");
  const receiptSha256 = sha256(receiptBytes);
  const manifestValue = {
    schemaVersion: 1,
    component: "local-subtitle-overwrite",
    target: { platform: TARGET!.platform, arch: TARGET!.arch },
    compatibility: {
      napiVersion: 8,
      nativeProtocolVersion: 4,
      journalVersion: 3,
    },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase: TARGET!.binaryHashPhase,
      signatureKind: TARGET!.signatureKind,
    },
    artifact: {
      relativePath: artifactRelativePath,
      byteSize: artifactBytes.byteLength,
      sha256: artifactSha256,
      format: TARGET!.format,
      architecture: TARGET!.arch,
      minimumOsVersion: TARGET!.minimumOsVersion,
      hasLoadCommandUuid: TARGET!.hasLoadCommandUuid,
    },
    buildReceipt: {
      relativePath: "build-receipt.v1.json",
      byteSize: receiptBytes.byteLength,
      sha256: receiptSha256,
      artifactHashPhase: "unsigned_link_output",
    },
  };
  const finalManifest = mutateManifest?.(manifestValue) ?? manifestValue;

  await mkdir(path.join(root, path.dirname(artifactRelativePath)), {
    recursive: true,
  });
  await Promise.all([
    writeFile(path.join(root, artifactRelativePath), artifactBytes),
    writeFile(path.join(root, "build-receipt.v1.json"), receiptBytes),
    writeFile(
      path.join(root, "local-subtitle-overwrite.v1.json"),
      `${JSON.stringify(finalManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return { artifactBytes, manifest: finalManifest };
}

function createBuildReceipt(artifactBytes: Buffer): Record<string, unknown> {
  const commonBuild = {
    recipe: TARGET!.platform === "darwin"
      ? "scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs"
      : "scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs",
    source: TARGET!.platform === "darwin"
      ? "native/local-subtitle-overwrite/src/addon.cc"
      : "native/local-subtitle-overwrite/src/addon-win32.cc",
    nodeVersion: process.versions.node,
    napiVersion: 8,
    nativeProtocolVersion: 4,
    journalVersion: 3,
    cxxStandard: "c++17",
  };
  return {
    schemaVersion: 1,
    workPackage: "FS-TXN-001F",
    component: "local-subtitle-overwrite",
    target: { platform: TARGET!.platform, arch: TARGET!.arch },
    build: TARGET!.platform === "darwin"
      ? {
          ...commonBuild,
          deploymentTarget: "11.0",
          sdkVersion: "15.5",
          compiler: "xcrun clang++",
          shell: false,
        }
      : {
          ...commonBuild,
          minimumWindowsVersion: "10.0",
          compiler: "portable llvm-mingw clang++",
          shell: false,
          nodeImportLibrarySha256: "1".repeat(64),
        },
    artifact: {
      logicalFileName: "local-subtitle-overwrite.node",
      byteSize: artifactBytes.byteLength,
      sha256: sha256(artifactBytes),
      format: TARGET!.format,
      architecture: TARGET!.arch,
      ...(TARGET!.platform === "darwin"
        ? { minimumMacosVersion: "11.0.0" }
        : {}),
    },
    privacy: {
      absolutePathsRecorded: false,
      usernameRecorded: false,
      sourceContentRecorded: false,
    },
  };
}

function createNativeBinary(marker: number): Buffer {
  if (TARGET!.platform === "win32") {
    const bytes = Buffer.alloc(128);
    bytes.write("MZ", 0, "binary");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
    bytes[127] = marker;
    return bytes;
  }
  const bytes = Buffer.alloc(104);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(48, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.fill(marker, 40, 56);
  bytes.writeUInt32LE(0x32, 56);
  bytes.writeUInt32LE(24, 60);
  bytes.writeUInt32LE(1, 64);
  bytes.writeUInt32LE(0x000b0000, 68);
  bytes.writeUInt32LE(0x000f0500, 72);
  bytes[103] = marker;
  return bytes;
}

function validRawModule() {
  return {
    protocolVersion: 4,
    platform: TARGET!.platform,
    architecture: TARGET!.arch,
    begin() {
      return {
        expectedFinalIdentity: { dev: 1, ino: 2, birthtimeMs: 3 },
        finalize() {},
        rollback() {},
        acknowledge() {},
      };
    },
    recover() {
      return { state: "not_found" };
    },
    acknowledge() {
      return { state: "not_found" };
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
