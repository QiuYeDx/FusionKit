import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
  assertSupportedLocalSubtitleRuntimeTarget,
  type LocalSubtitleRuntimeManifest,
} from "../../electron/main/local-subtitle/resource-manifest";
import {
  resolveLocalSubtitleRuntimeRoot,
  type LocalSubtitleResourceEnvironment,
} from "../../electron/main/local-subtitle/resource-path";

const EVIDENCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../resources/local-subtitle/licenses",
);

export interface LocalSubtitleRuntimeFixture {
  readonly tempRoot: string;
  readonly runtimeRoot: string;
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly manifestPath: string;
  readonly manifest: LocalSubtitleRuntimeManifest;
  readonly artifactPaths: Readonly<Record<string, string>>;
  rewriteManifest(): Promise<void>;
  cleanup(): Promise<void>;
}

export function createRuntimeManifest(
  platform: "darwin" | "win32" = "darwin",
  arch: "arm64" | "x64" = platform === "darwin" ? "arm64" : "x64",
): LocalSubtitleRuntimeManifest {
  const target = assertSupportedLocalSubtitleRuntimeTarget(platform, arch);
  const placeholderHash = "0".repeat(64);
  return {
    schemaVersion: 1,
    runtimeContractVersion: 1,
    manifestId: `local-subtitle-runtime-${target.id}-fixture`,
    target: { platform, arch },
    integrityProfile: target.integrityProfile,
    integrity: { ...target.integrity },
    artifacts: target.requiredArtifacts.map((artifact, index) => ({
      ...artifact,
      platform,
      arch,
      byteSize: index + 1,
      sha256: placeholderHash,
      version: artifact.kind === "ffmpeg" || artifact.kind === "ffprobe"
        ? target.artifactVersions.media
        : target.artifactVersions.runner,
      signatureKind: target.allowedSignatureKinds[0]!,
    })),
    licenses: structuredClone(target.requiredLicenses),
    sources: structuredClone(target.requiredSources),
  };
}

export async function createRuntimeFixture(options: {
  readonly platform?: "darwin" | "win32";
  readonly arch?: "arm64" | "x64";
  readonly mode?: "development" | "packaged";
} = {}): Promise<LocalSubtitleRuntimeFixture> {
  const platform = options.platform ?? "darwin";
  const arch = options.arch ?? (platform === "darwin" ? "arm64" : "x64");
  const mode = options.mode ?? "development";
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-local-subtitle-runtime-"),
  );
  const environment: LocalSubtitleResourceEnvironment = mode === "development"
    ? { mode, appRoot: tempRoot, platform, arch }
    : {
        mode,
        resourcesPath: path.join(tempRoot, "resources"),
        platform,
        arch,
      };
  const runtimeRoot = resolveLocalSubtitleRuntimeRoot(environment);
  const manifest = createRuntimeManifest(platform, arch);
  const artifactPaths: Record<string, string> = {};
  const binary = platform === "darwin"
    ? createMachO(arch)
    : createPe(arch);

  for (const artifact of manifest.artifacts) {
    const absolutePath = path.join(
      runtimeRoot,
      ...artifact.relativePath.split("/"),
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, binary, {
      mode: artifact.executable && platform === "darwin" ? 0o755 : 0o644,
    });
    artifact.byteSize = binary.length;
    artifact.sha256 = sha256(binary);
    artifactPaths[artifact.id] = absolutePath;
  }

  for (const license of manifest.licenses) {
    for (const evidence of [...license.licenseFiles, ...license.noticeFiles]) {
      await copyEvidence(runtimeRoot, evidence.relativePath);
    }
  }
  for (const source of manifest.sources) {
    await copyEvidence(runtimeRoot, source.evidenceFile.relativePath);
  }

  const manifestPath = path.join(
    runtimeRoot,
    ...LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH.split("/"),
  );
  const rewriteManifest = async () => {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await chmod(manifestPath, 0o644);
  };
  await rewriteManifest();

  return {
    tempRoot,
    runtimeRoot,
    environment,
    manifestPath,
    manifest,
    artifactPaths: Object.freeze(artifactPaths),
    rewriteManifest,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

async function copyEvidence(
  runtimeRoot: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = path.join(
    runtimeRoot,
    ...relativePath.split("/"),
  );
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await copyFile(path.join(EVIDENCE_ROOT, path.basename(relativePath)), absolutePath);
  await chmod(absolutePath, 0o644);
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createMachO(arch: "arm64" | "x64"): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(0, 16);
  return buffer;
}

export function createPe(arch: "arm64" | "x64"): Buffer {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "binary");
  buffer.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
  return buffer;
}
