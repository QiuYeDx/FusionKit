import { createHash } from "node:crypto";
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import rawOverwriteStagingContract from "../../../resources/local-subtitle/manifests/local-subtitle-overwrite-staging.v1.json";
import {
  type LocalSubtitleResourceEnvironment,
  resolveLocalSubtitleRuntimeRoot,
  verifyLocalSubtitleArtifactSignature,
} from "./resource-path";
import {
  inspectLocalSubtitleNativeBinary,
  type LocalSubtitleNativeBinaryIdentity,
} from "./resource-manifest";
import {
  localSubtitleFilesystemObjectIdentityForHandle,
  localSubtitleFilesystemObjectIdentityForPath,
  localSubtitlePosixObjectIdentityFromStats,
  localSubtitleWindowsObjectIdentityFromStats,
  sameLocalSubtitleFilesystemObjectIdentity,
  snapshotLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity,
} from "./filesystem-object-identity";

export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION = 8 as const;
export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION = 4 as const;
export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION = 3 as const;
export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_ROOT_RELATIVE_PATH =
  "overwrite/v1" as const;
export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_LEAF =
  "local-subtitle-overwrite.v1.json" as const;

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_BUILD_RECEIPT_BYTES = 1024 * 1024;
const MAX_ADDON_BYTES = 64 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_NATIVE_HEADER_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const READ_ONLY_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const VERIFIED_ADDON_PROOFS = new WeakSet<object>();
const PROOF_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.verified-overwrite-native-addon",
);

export type LocalSubtitleOverwriteNativePlatform = "darwin" | "win32";
export type LocalSubtitleOverwriteNativeArchitecture = "arm64" | "x64";
export type LocalSubtitleOverwriteNativeSignatureKind =
  | "adhoc"
  | "developer_id"
  | "unsigned";
export type LocalSubtitleOverwriteNativeBinaryFormat = "mach-o" | "pe";

export type LocalSubtitleOverwriteNativeResourceErrorCode =
  | "unsupported_target"
  | "manifest_missing"
  | "invalid_manifest"
  | "artifact_missing"
  | "invalid_artifact"
  | "receipt_missing"
  | "invalid_receipt"
  | "signature_invalid"
  | "proof_invalid"
  | "resource_changed";

export class LocalSubtitleOverwriteNativeResourceError extends Error {
  readonly name = "LocalSubtitleOverwriteNativeResourceError";

  constructor(
    readonly code: LocalSubtitleOverwriteNativeResourceErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

interface LocalSubtitleOverwriteNativeManifestFile {
  readonly relativePath: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface LocalSubtitleOverwriteNativeManifest {
  readonly schemaVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_SCHEMA_VERSION;
  readonly component: "local-subtitle-overwrite";
  readonly target: {
    readonly platform: LocalSubtitleOverwriteNativePlatform;
    readonly arch: LocalSubtitleOverwriteNativeArchitecture;
  };
  readonly compatibility: {
    readonly napiVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION;
    readonly nativeProtocolVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION;
    readonly journalVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION;
  };
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly binaryHashPhase:
      | "after_nested_code_signing_before_outer_bundle_signing"
      | "unsigned_final_bytes_before_outer_packaging";
    readonly signatureKind: LocalSubtitleOverwriteNativeSignatureKind;
  };
  readonly artifact: LocalSubtitleOverwriteNativeManifestFile & {
    readonly format: LocalSubtitleOverwriteNativeBinaryFormat;
    readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
    readonly minimumOsVersion: string | null;
    readonly hasLoadCommandUuid: boolean;
  };
  readonly buildReceipt: LocalSubtitleOverwriteNativeManifestFile & {
    readonly artifactHashPhase: "unsigned_link_output";
  };
}

interface VerifiedFileProof {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly identity: LocalSubtitleFilesystemObjectIdentity;
  readonly parentIdentity: LocalSubtitleFilesystemObjectIdentity;
}

export interface LocalSubtitleVerifiedOverwriteNativeAddon {
  readonly [PROOF_BRAND]: true;
  readonly schemaVersion: 1;
  readonly addonGeneration: string;
  readonly manifestSha256: string;
  readonly rootPath: string;
  readonly rootIdentity: LocalSubtitleFilesystemObjectIdentity;
  readonly target: {
    readonly platform: LocalSubtitleOverwriteNativePlatform;
    readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
  };
  readonly artifact: VerifiedFileProof & {
    readonly format: LocalSubtitleOverwriteNativeBinaryFormat;
    readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
    readonly minimumOsVersion: string | null;
    readonly hasLoadCommandUuid: boolean;
    readonly signatureKind: LocalSubtitleOverwriteNativeSignatureKind;
    readonly napiVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION;
    readonly nativeProtocolVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION;
    readonly journalVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION;
  };
  readonly manifest: VerifiedFileProof;
  readonly buildReceipt: VerifiedFileProof;
  readonly ready: true;
}

export type LocalSubtitleOverwriteNativeSignatureVerifier = (
  absolutePath: string,
  policy: {
    readonly platform: LocalSubtitleOverwriteNativePlatform;
    readonly signatureKind: Exclude<LocalSubtitleOverwriteNativeSignatureKind, "unsigned">;
  },
) => Promise<boolean>;

export interface VerifyLocalSubtitleOverwriteNativeAddonOptions {
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly signatureVerifier?: LocalSubtitleOverwriteNativeSignatureVerifier;
}

interface TargetPolicy {
  readonly id: "darwin-arm64" | "win32-x64";
  readonly platform: LocalSubtitleOverwriteNativePlatform;
  readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
  readonly format: LocalSubtitleOverwriteNativeBinaryFormat;
  readonly minimumOsVersion: string | null;
  readonly requiresLoadCommandUuid: boolean;
  readonly artifactRelativeDirectory: string;
  readonly binaryHashPhase:
    | "after_nested_code_signing_before_outer_bundle_signing"
    | "unsigned_final_bytes_before_outer_packaging";
  readonly signatureKinds: readonly LocalSubtitleOverwriteNativeSignatureKind[];
  readonly build: Readonly<Record<string, unknown>>;
}

interface VerifiedFileRead extends VerifiedFileProof {
  readonly header: Buffer;
}

export async function verifyLocalSubtitleOverwriteNativeAddon(
  options: VerifyLocalSubtitleOverwriteNativeAddonOptions,
): Promise<LocalSubtitleVerifiedOverwriteNativeAddon> {
  if (!options || typeof options !== "object" || !options.environment) {
    throw failure("invalid_manifest", "The overwrite native resource environment is invalid.");
  }
  const platform = options.environment.platform ?? process.platform;
  const architecture = options.environment.arch ?? process.arch;
  const target = targetPolicy(platform, architecture);
  const runtimeRoot = resolveLocalSubtitleRuntimeRoot(options.environment);
  const rootPath = resolveContainedPath(
    runtimeRoot,
    LOCAL_SUBTITLE_OVERWRITE_NATIVE_ROOT_RELATIVE_PATH,
  );
  await assertContainedDirectory(runtimeRoot, rootPath);
  const rootIdentity = await localSubtitleFilesystemObjectIdentityForPath(rootPath);

  const manifestPath = path.join(
    rootPath,
    LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_LEAF,
  );
  const manifestRead = await readVerifiedFile({
    rootPath,
    relativePath: LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_LEAF,
    maximumByteSize: MAX_MANIFEST_BYTES,
    missingCode: "manifest_missing",
    invalidCode: "invalid_manifest",
    captureHeader: false,
  });
  const manifestBytes = await readFileFromVerifiedPath(
    manifestPath,
    MAX_MANIFEST_BYTES,
  );
  if (manifestRead.sha256 !== sha256(manifestBytes)) {
    throw failure("resource_changed", "The overwrite native manifest changed during verification.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (cause) {
    throw failure("invalid_manifest", "The overwrite native manifest is not valid JSON.", cause);
  }
  const manifest = parseLocalSubtitleOverwriteNativeManifest(parsed, target);

  const buildReceipt = await readVerifiedFile({
    rootPath,
    relativePath: manifest.buildReceipt.relativePath,
    expectedByteSize: manifest.buildReceipt.byteSize,
    expectedSha256: manifest.buildReceipt.sha256,
    maximumByteSize: MAX_BUILD_RECEIPT_BYTES,
    missingCode: "receipt_missing",
    invalidCode: "invalid_receipt",
    captureHeader: false,
  });
  await validateBuildReceipt(buildReceipt.absolutePath, manifest, target);
  let artifact = await readVerifiedFile({
    rootPath,
    relativePath: manifest.artifact.relativePath,
    expectedByteSize: manifest.artifact.byteSize,
    expectedSha256: manifest.artifact.sha256,
    maximumByteSize: MAX_ADDON_BYTES,
    missingCode: "artifact_missing",
    invalidCode: "invalid_artifact",
    captureHeader: true,
  });
  assertBinaryIdentity(artifact.header, manifest.artifact.format, target);

  if (manifest.integrity.signatureKind !== "unsigned") {
    const verifier = options.signatureVerifier ?? verifyLocalSubtitleArtifactSignature;
    let valid = false;
    try {
      valid = await verifier(artifact.absolutePath, {
        platform: target.platform,
        signatureKind: manifest.integrity.signatureKind,
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      throw failure("signature_invalid", "The overwrite native addon signature is invalid.");
    }
    artifact = await readVerifiedFile({
      rootPath,
      relativePath: manifest.artifact.relativePath,
      expectedByteSize: manifest.artifact.byteSize,
      expectedSha256: manifest.artifact.sha256,
      maximumByteSize: MAX_ADDON_BYTES,
      missingCode: "artifact_missing",
      invalidCode: "invalid_artifact",
      captureHeader: true,
    });
    assertBinaryIdentity(artifact.header, manifest.artifact.format, target);
  }

  await assertDirectoryIdentity(rootPath, rootIdentity);
  const addonGeneration = sha256(Buffer.from(
    `fusionkit.local-subtitle-overwrite\0${manifestRead.sha256}`,
    "utf8",
  ));
  const proof = {
    schemaVersion: 1,
    addonGeneration,
    manifestSha256: manifestRead.sha256,
    rootPath,
    rootIdentity,
    target: {
      platform: manifest.target.platform,
      architecture: manifest.target.arch,
    },
    artifact: {
      ...withoutHeader(artifact),
      format: manifest.artifact.format,
      architecture: manifest.artifact.architecture,
      minimumOsVersion: manifest.artifact.minimumOsVersion,
      hasLoadCommandUuid: manifest.artifact.hasLoadCommandUuid,
      signatureKind: manifest.integrity.signatureKind,
      napiVersion: manifest.compatibility.napiVersion,
      nativeProtocolVersion: manifest.compatibility.nativeProtocolVersion,
      journalVersion: manifest.compatibility.journalVersion,
    },
    manifest: withoutHeader(manifestRead),
    buildReceipt: withoutHeader(buildReceipt),
    ready: true,
  } as Omit<LocalSubtitleVerifiedOverwriteNativeAddon, typeof PROOF_BRAND>;
  for (const child of Object.values(proof)) deepFreeze(child);
  Object.defineProperty(proof, PROOF_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(proof);
  VERIFIED_ADDON_PROOFS.add(proof);
  return proof as LocalSubtitleVerifiedOverwriteNativeAddon;
}

export function parseLocalSubtitleOverwriteNativeManifest(
  input: unknown,
  target: TargetPolicy = targetPolicy(process.platform, process.arch),
): LocalSubtitleOverwriteNativeManifest {
  if (
    !isExactRecord(input, [
      "schemaVersion",
      "component",
      "target",
      "compatibility",
      "integrity",
      "artifact",
      "buildReceipt",
    ]) ||
    input.schemaVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_SCHEMA_VERSION ||
    input.component !== "local-subtitle-overwrite" ||
    !isExactRecord(input.target, ["platform", "arch"]) ||
    input.target.platform !== target.platform ||
    input.target.arch !== target.architecture ||
    !isExactRecord(input.compatibility, [
      "napiVersion",
      "nativeProtocolVersion",
      "journalVersion",
    ]) ||
    input.compatibility.napiVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION ||
    input.compatibility.nativeProtocolVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION ||
    input.compatibility.journalVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION ||
    !isExactRecord(input.integrity, [
      "algorithm",
      "binaryHashPhase",
      "signatureKind",
    ]) ||
    input.integrity.algorithm !== "sha256" ||
    input.integrity.binaryHashPhase !== target.binaryHashPhase ||
    !target.signatureKinds.includes(
      input.integrity.signatureKind as LocalSubtitleOverwriteNativeSignatureKind,
    ) ||
    !isExactRecord(input.artifact, [
      "relativePath",
      "byteSize",
      "sha256",
      "format",
      "architecture",
      "minimumOsVersion",
      "hasLoadCommandUuid",
    ]) ||
    input.artifact.format !== target.format ||
    input.artifact.architecture !== target.architecture ||
    input.artifact.minimumOsVersion !== target.minimumOsVersion ||
    input.artifact.hasLoadCommandUuid !== target.requiresLoadCommandUuid ||
    !isManifestFile(input.artifact, MAX_ADDON_BYTES) ||
    input.artifact.relativePath !==
      `${target.artifactRelativeDirectory}/local-subtitle-overwrite.${input.artifact.sha256}.node` ||
    !isExactRecord(input.buildReceipt, [
      "relativePath",
      "byteSize",
      "sha256",
      "artifactHashPhase",
    ]) ||
    !isManifestFile(input.buildReceipt, MAX_BUILD_RECEIPT_BYTES) ||
    input.buildReceipt.relativePath !== "build-receipt.v1.json" ||
    input.buildReceipt.artifactHashPhase !== "unsigned_link_output" ||
    typeof process.versions.napi !== "string" ||
    Number(process.versions.napi) < LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION
  ) {
    throw failure("invalid_manifest", "The overwrite native manifest is invalid.");
  }
  const targetValue = input.target as Record<string, unknown>;
  const compatibility = input.compatibility as Record<string, unknown>;
  const integrity = input.integrity as Record<string, unknown>;
  const artifact = input.artifact as Record<string, unknown>;
  const buildReceipt = input.buildReceipt as Record<string, unknown>;
  return deepFreeze({
    schemaVersion: LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_SCHEMA_VERSION,
    component: "local-subtitle-overwrite",
    target: {
      platform: targetValue.platform as LocalSubtitleOverwriteNativePlatform,
      arch: targetValue.arch as LocalSubtitleOverwriteNativeArchitecture,
    },
    compatibility: {
      napiVersion: compatibility.napiVersion as typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION,
      nativeProtocolVersion:
        compatibility.nativeProtocolVersion as typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION,
      journalVersion:
        compatibility.journalVersion as typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION,
    },
    integrity: {
      algorithm: "sha256",
      binaryHashPhase: integrity.binaryHashPhase as LocalSubtitleOverwriteNativeManifest["integrity"]["binaryHashPhase"],
      signatureKind: integrity.signatureKind as LocalSubtitleOverwriteNativeSignatureKind,
    },
    artifact: {
      relativePath: artifact.relativePath as string,
      byteSize: artifact.byteSize as number,
      sha256: artifact.sha256 as string,
      format: artifact.format as LocalSubtitleOverwriteNativeBinaryFormat,
      architecture: artifact.architecture as LocalSubtitleOverwriteNativeArchitecture,
      minimumOsVersion: artifact.minimumOsVersion as string | null,
      hasLoadCommandUuid: artifact.hasLoadCommandUuid as boolean,
    },
    buildReceipt: {
      relativePath: buildReceipt.relativePath as string,
      byteSize: buildReceipt.byteSize as number,
      sha256: buildReceipt.sha256 as string,
      artifactHashPhase: "unsigned_link_output",
    },
  });
}

export function isLocalSubtitleVerifiedOverwriteNativeAddon(
  input: unknown,
): input is LocalSubtitleVerifiedOverwriteNativeAddon {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    VERIFIED_ADDON_PROOFS.has(input) &&
    (input as { readonly [PROOF_BRAND]?: unknown })[PROOF_BRAND] === true
  );
}

export function assertLocalSubtitleVerifiedOverwriteNativeAddonCurrent(
  proof: LocalSubtitleVerifiedOverwriteNativeAddon,
): void {
  if (!isLocalSubtitleVerifiedOverwriteNativeAddon(proof)) {
    throw failure("proof_invalid", "A verified overwrite native addon proof is required.");
  }
  const target = targetPolicy(process.platform, process.arch);
  if (
    proof.target.platform !== target.platform ||
    proof.target.architecture !== target.architecture ||
    proof.artifact.format !== target.format ||
    proof.artifact.nativeProtocolVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION ||
    proof.artifact.journalVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION ||
    proof.artifact.napiVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION
  ) {
    throw failure("proof_invalid", "The overwrite native addon proof target is invalid.");
  }
  assertCurrentDirectory(proof.rootPath, proof.rootIdentity);
  assertCurrentFile(proof.rootPath, proof.manifest, false);
  assertCurrentFile(proof.rootPath, proof.buildReceipt, false);
  const header = assertCurrentFile(proof.rootPath, proof.artifact, true);
  assertBinaryIdentity(header, proof.artifact.format, target);
  assertCurrentDirectory(proof.rootPath, proof.rootIdentity);
}

async function readVerifiedFile(options: {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly expectedByteSize?: number;
  readonly expectedSha256?: string;
  readonly maximumByteSize: number;
  readonly missingCode: LocalSubtitleOverwriteNativeResourceErrorCode;
  readonly invalidCode: LocalSubtitleOverwriteNativeResourceErrorCode;
  readonly captureHeader: boolean;
}): Promise<VerifiedFileRead> {
  const relativePath = normalizeRelativePath(options.relativePath);
  const absolutePath = resolveContainedPath(options.rootPath, relativePath);
  await assertNoSymbolicSegments(options.rootPath, relativePath, options.missingCode, options.invalidCode);
  let pathStat;
  try {
    pathStat = await lstat(absolutePath);
  } catch (cause) {
    throw failure(options.missingCode, "A required overwrite native resource is missing.", cause);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw failure(options.invalidCode, "An overwrite native resource is not a regular file.");
  }
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch (cause) {
    throw failure(options.invalidCode, "An overwrite native resource cannot be opened.", cause);
  }
  try {
    const opened = await handle.stat();
    const identity = await localSubtitleFilesystemObjectIdentityForHandle(handle);
    const pathIdentity = await localSubtitleFilesystemObjectIdentityForPath(absolutePath);
    if (
      !opened.isFile() ||
      !sameLocalSubtitleFilesystemObjectIdentity(identity, pathIdentity) ||
      opened.size < 1 ||
      opened.size > options.maximumByteSize ||
      (options.expectedByteSize !== undefined && opened.size !== options.expectedByteSize)
    ) {
      throw failure(options.invalidCode, "An overwrite native resource failed its identity or size check.");
    }
    const observed = await hashHandle(handle, opened.size, options.captureHeader, options.invalidCode);
    if (options.expectedSha256 !== undefined && observed.sha256 !== options.expectedSha256) {
      throw failure(options.invalidCode, "An overwrite native resource failed its SHA-256 check.");
    }
    const completed = await handle.stat();
    const completedIdentity = await localSubtitleFilesystemObjectIdentityForHandle(handle);
    if (
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs ||
      !sameLocalSubtitleFilesystemObjectIdentity(identity, completedIdentity)
    ) {
      throw failure("resource_changed", "An overwrite native resource changed during verification.");
    }
    await assertNoSymbolicSegments(options.rootPath, relativePath, options.missingCode, options.invalidCode);
    await assertRealPathContained(options.rootPath, absolutePath);
    const completedPathIdentity = await localSubtitleFilesystemObjectIdentityForPath(absolutePath);
    if (!sameLocalSubtitleFilesystemObjectIdentity(identity, completedPathIdentity)) {
      throw failure("resource_changed", "An overwrite native resource path changed during verification.");
    }
    const parentPath = path.dirname(absolutePath);
    const parentIdentity = await localSubtitleFilesystemObjectIdentityForPath(parentPath);
    return {
      absolutePath,
      relativePath,
      byteSize: opened.size,
      sha256: observed.sha256,
      identity,
      parentIdentity,
      header: observed.header,
    };
  } finally {
    await handle.close();
  }
}

async function hashHandle(
  handle: FileHandle,
  byteSize: number,
  captureHeader: boolean,
  invalidCode: LocalSubtitleOverwriteNativeResourceErrorCode,
): Promise<{ readonly sha256: string; readonly header: Buffer }> {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, byteSize));
  const header = Buffer.alloc(captureHeader ? Math.min(MAX_NATIVE_HEADER_BYTES, byteSize) : 0);
  let position = 0;
  try {
    while (position < byteSize) {
      const requested = Math.min(chunk.length, byteSize - position);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead < 1) throw new Error("unexpected end of file");
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (position < header.length) {
        bytes.copy(header, position, 0, Math.min(bytesRead, header.length - position));
      }
      position += bytesRead;
    }
  } catch (cause) {
    throw failure(invalidCode, "An overwrite native resource cannot be hashed.", cause);
  }
  return { sha256: hash.digest("hex"), header };
}

function assertCurrentFile(
  rootPath: string,
  proof: VerifiedFileProof,
  captureHeader: boolean,
): Buffer {
  const relativePath = normalizeRelativePath(proof.relativePath);
  const absolutePath = resolveContainedPath(rootPath, relativePath);
  if (absolutePath !== proof.absolutePath) {
    throw failure("proof_invalid", "The overwrite native resource proof path is invalid.");
  }
  assertNoSymbolicSegmentsSync(rootPath, relativePath);
  assertCurrentDirectory(path.dirname(absolutePath), proof.parentIdentity);
  let descriptor: number;
  try {
    descriptor = openSync(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch (cause) {
    throw failure("resource_changed", "A verified overwrite native resource cannot be opened.", cause);
  }
  try {
    const opened = fstatSync(descriptor);
    const identity = filesystemIdentityForDescriptor(descriptor);
    if (
      !opened.isFile() ||
      opened.size !== proof.byteSize ||
      !sameLocalSubtitleFilesystemObjectIdentity(identity, proof.identity)
    ) {
      throw failure("resource_changed", "A verified overwrite native resource changed before loading.");
    }
    const observed = hashDescriptor(descriptor, proof.byteSize, captureHeader);
    const completed = fstatSync(descriptor);
    const completedIdentity = filesystemIdentityForDescriptor(descriptor);
    if (
      observed.sha256 !== proof.sha256 ||
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs ||
      !sameLocalSubtitleFilesystemObjectIdentity(identity, completedIdentity)
    ) {
      throw failure("resource_changed", "A verified overwrite native resource changed while loading.");
    }
    const pathIdentity = filesystemIdentityForPathSync(absolutePath);
    if (!sameLocalSubtitleFilesystemObjectIdentity(identity, pathIdentity)) {
      throw failure("resource_changed", "A verified overwrite native resource path changed while loading.");
    }
    return observed.header;
  } finally {
    closeSync(descriptor);
  }
}

function hashDescriptor(
  descriptor: number,
  byteSize: number,
  captureHeader: boolean,
): { readonly sha256: string; readonly header: Buffer } {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, byteSize));
  const header = Buffer.alloc(captureHeader ? Math.min(MAX_NATIVE_HEADER_BYTES, byteSize) : 0);
  let position = 0;
  while (position < byteSize) {
    const bytesRead = readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.length, byteSize - position),
      position,
    );
    if (bytesRead < 1) {
      throw failure("resource_changed", "A verified overwrite native resource ended during loading.");
    }
    const bytes = chunk.subarray(0, bytesRead);
    hash.update(bytes);
    if (position < header.length) {
      bytes.copy(header, position, 0, Math.min(bytesRead, header.length - position));
    }
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), header };
}

function filesystemIdentityForDescriptor(descriptor: number): LocalSubtitleFilesystemObjectIdentity {
  return process.platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(fstatSync(descriptor, { bigint: true }))
    : localSubtitlePosixObjectIdentityFromStats(fstatSync(descriptor));
}

function filesystemIdentityForPathSync(filePath: string): LocalSubtitleFilesystemObjectIdentity {
  return process.platform === "win32"
    ? localSubtitleWindowsObjectIdentityFromStats(lstatSync(filePath, { bigint: true }))
    : localSubtitlePosixObjectIdentityFromStats(lstatSync(filePath));
}

function assertCurrentDirectory(
  directoryPath: string,
  expectedIdentity: LocalSubtitleFilesystemObjectIdentity,
): void {
  let stat;
  let identity;
  try {
    stat = lstatSync(directoryPath);
    identity = filesystemIdentityForPathSync(directoryPath);
  } catch (cause) {
    throw failure("resource_changed", "A verified overwrite native directory is unavailable.", cause);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameLocalSubtitleFilesystemObjectIdentity(identity, expectedIdentity)
  ) {
    throw failure("resource_changed", "A verified overwrite native directory changed.");
  }
}

function assertNoSymbolicSegmentsSync(rootPath: string, relativePath: string): void {
  let current = rootPath;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (cause) {
      throw failure("resource_changed", "A verified overwrite native resource path is unavailable.", cause);
    }
    if (stat.isSymbolicLink()) {
      throw failure("resource_changed", "A verified overwrite native resource path contains a symbolic link.");
    }
  }
}

async function assertContainedDirectory(runtimeRoot: string, rootPath: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(rootPath);
  } catch (cause) {
    throw failure("manifest_missing", "The overwrite native staged root is missing.", cause);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw failure("invalid_manifest", "The overwrite native staged root is invalid.");
  }
  await assertRealPathContained(runtimeRoot, rootPath);
}

async function assertNoSymbolicSegments(
  rootPath: string,
  relativePath: string,
  missingCode: LocalSubtitleOverwriteNativeResourceErrorCode,
  invalidCode: LocalSubtitleOverwriteNativeResourceErrorCode,
): Promise<void> {
  let current = rootPath;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let stat;
    try {
      stat = await lstat(current);
    } catch (cause) {
      throw failure(missingCode, "A required overwrite native resource is missing.", cause);
    }
    const leaf = index === segments.length - 1;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
      throw failure(invalidCode, "An overwrite native resource path is invalid.");
    }
  }
}

async function assertRealPathContained(rootPath: string, absolutePath: string): Promise<void> {
  let canonicalRoot;
  let canonicalPath;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(rootPath),
      realpath(absolutePath),
    ]);
  } catch (cause) {
    throw failure("resource_changed", "An overwrite native resource cannot be resolved.", cause);
  }
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (!isContainedRelativePath(relative)) {
    throw failure("invalid_manifest", "An overwrite native resource escapes its staged root.");
  }
}

async function assertDirectoryIdentity(
  directoryPath: string,
  expectedIdentity: LocalSubtitleFilesystemObjectIdentity,
): Promise<void> {
  const identity = await localSubtitleFilesystemObjectIdentityForPath(directoryPath);
  if (!sameLocalSubtitleFilesystemObjectIdentity(identity, expectedIdentity)) {
    throw failure("resource_changed", "The overwrite native staged root changed during verification.");
  }
}

async function readFileFromVerifiedPath(
  absolutePath: string,
  maximumByteSize: number,
): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch (cause) {
    throw failure("resource_changed", "A verified overwrite native resource cannot be reopened.", cause);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumByteSize) {
      throw failure("resource_changed", "A verified overwrite native resource changed.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function validateBuildReceipt(
  absolutePath: string,
  manifest: LocalSubtitleOverwriteNativeManifest,
  target: TargetPolicy,
): Promise<void> {
  let value: unknown;
  try {
    const bytes = await readFileFromVerifiedPath(
      absolutePath,
      MAX_BUILD_RECEIPT_BYTES,
    );
    if (sha256(bytes) !== manifest.buildReceipt.sha256) {
      throw new Error("build receipt changed");
    }
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw failure("invalid_receipt", "The overwrite native build receipt is invalid.", cause);
  }
  if (
    !isExactRecord(value, [
      "schemaVersion",
      "workPackage",
      "component",
      "target",
      "build",
      "artifact",
      "privacy",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.workPackage !== "string" ||
    !/^FS-TXN-001[A-Z]$/u.test(value.workPackage) ||
    value.component !== "local-subtitle-overwrite" ||
    !isExactRecord(value.target, ["platform", "arch"]) ||
    value.target.platform !== target.platform ||
    value.target.arch !== target.architecture ||
    !isReceiptBuild(value.build, target) ||
    !isReceiptArtifact(value.artifact, target) ||
    !receiptArtifactMatchesFinal(value.artifact, manifest, target) ||
    !isExactRecord(value.privacy, [
      "absolutePathsRecorded",
      "usernameRecorded",
      "sourceContentRecorded",
    ]) ||
    value.privacy.absolutePathsRecorded !== false ||
    value.privacy.usernameRecorded !== false ||
    value.privacy.sourceContentRecorded !== false ||
    manifest.buildReceipt.artifactHashPhase !== "unsigned_link_output"
  ) {
    throw failure("invalid_receipt", "The overwrite native build receipt does not match its contract.");
  }
}

function isReceiptBuild(value: unknown, target: TargetPolicy): boolean {
  const keys = target.platform === "darwin"
    ? [
        "recipe",
        "source",
        "nodeVersion",
        "napiVersion",
        "nativeProtocolVersion",
        "journalVersion",
        "cxxStandard",
        "deploymentTarget",
        "sdkVersion",
        "compiler",
        "shell",
      ]
    : [
        "recipe",
        "source",
        "delayLoadHook",
        "nodeImportMode",
        "delayedHostBinary",
        "nodeVersion",
        "napiVersion",
        "nativeProtocolVersion",
        "journalVersion",
        "cxxStandard",
        "minimumWindowsVersion",
        "compiler",
        "shell",
        "nodeImportLibrarySha256",
        "delayLoadHookSha256",
      ];
  if (!isExactRecord(value, keys)) return false;
  if (
    value.recipe !== target.build.recipe ||
    value.source !== target.build.source ||
    value.cxxStandard !== target.build.cxxStandard ||
    value.napiVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION ||
    value.nativeProtocolVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION ||
    value.journalVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION ||
    value.shell !== false ||
    typeof value.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.nodeVersion)
  ) {
    return false;
  }
  if (target.platform === "darwin") {
    return value.deploymentTarget === target.build.deploymentTarget &&
      value.compiler === "xcrun clang++" &&
      typeof value.sdkVersion === "string" &&
      /^\d+(?:\.\d+){1,2}$/u.test(value.sdkVersion);
  }
  return value.minimumWindowsVersion === target.build.minimumWindowsVersion &&
    value.delayLoadHook === target.build.delayLoadHook &&
    value.nodeImportMode === target.build.nodeImportMode &&
    value.delayedHostBinary === target.build.delayedHostBinary &&
    value.compiler === "portable llvm-mingw clang++" &&
    typeof value.nodeImportLibrarySha256 === "string" &&
    SHA256_PATTERN.test(value.nodeImportLibrarySha256) &&
    typeof value.delayLoadHookSha256 === "string" &&
    SHA256_PATTERN.test(value.delayLoadHookSha256);
}

function isReceiptArtifact(value: unknown, target: TargetPolicy): boolean {
  const keys = target.platform === "darwin"
    ? [
        "logicalFileName",
        "byteSize",
        "sha256",
        "format",
        "architecture",
        "minimumMacosVersion",
      ]
    : ["logicalFileName", "byteSize", "sha256", "format", "architecture"];
  if (!isExactRecord(value, keys)) return false;
  if (
    value.logicalFileName !== "local-subtitle-overwrite.node" ||
    !Number.isSafeInteger(value.byteSize) ||
    Number(value.byteSize) < 1 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    value.format !== target.format ||
    value.architecture !== target.architecture
  ) {
    return false;
  }
  return target.platform !== "darwin" ||
    value.minimumMacosVersion === target.minimumOsVersion;
}

function receiptArtifactMatchesFinal(
  value: unknown,
  manifest: LocalSubtitleOverwriteNativeManifest,
  target: TargetPolicy,
): boolean {
  if (target.platform === "darwin") return true;
  return isExactRecord(value, [
    "logicalFileName",
    "byteSize",
    "sha256",
    "format",
    "architecture",
  ]) &&
    value.byteSize === manifest.artifact.byteSize &&
    value.sha256 === manifest.artifact.sha256;
}

function assertBinaryIdentity(
  header: Buffer,
  expectedFormat: LocalSubtitleOverwriteNativeBinaryFormat,
  target: TargetPolicy,
): void {
  const identity: LocalSubtitleNativeBinaryIdentity = inspectLocalSubtitleNativeBinary(header);
  if (
    identity.format !== expectedFormat ||
    identity.architectures.length !== 1 ||
    identity.architectures[0] !== target.architecture ||
    identity.minimumOsVersion !== target.minimumOsVersion ||
    hasMachLoadCommand(header, 0x1b) !== target.requiresLoadCommandUuid
  ) {
    throw failure("invalid_artifact", "The overwrite native addon binary target is invalid.");
  }
}

function targetPolicy(platform: string, architecture: string): TargetPolicy {
  const target = OVERWRITE_TARGET_POLICIES.find(
    (candidate) =>
      candidate.platform === platform && candidate.architecture === architecture,
  );
  if (target) return target;
  throw failure("unsupported_target", "The overwrite native addon target is unsupported.");
}

const OVERWRITE_TARGET_POLICIES = parseOverwriteStagingContract(
  rawOverwriteStagingContract,
);

function parseOverwriteStagingContract(input: unknown): readonly TargetPolicy[] {
  if (
    !isExactRecord(input, [
      "schemaVersion",
      "component",
      "developmentRuntimeRoot",
      "packagedRuntimeRoot",
      "stagingSubtree",
      "manifestRelativePath",
      "buildReceiptRelativePath",
      "artifactLeafPattern",
      "targets",
    ]) ||
    input.schemaVersion !== 1 ||
    input.component !== "local-subtitle-overwrite" ||
    input.developmentRuntimeRoot !== "build/local-subtitle-resources/local-subtitle" ||
    input.packagedRuntimeRoot !== "local-subtitle" ||
    input.stagingSubtree !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_ROOT_RELATIVE_PATH ||
    input.manifestRelativePath !==
      `${LOCAL_SUBTITLE_OVERWRITE_NATIVE_ROOT_RELATIVE_PATH}/${LOCAL_SUBTITLE_OVERWRITE_NATIVE_MANIFEST_LEAF}` ||
    input.buildReceiptRelativePath !== "build-receipt.v1.json" ||
    input.artifactLeafPattern !== "local-subtitle-overwrite.<sha256>.node" ||
    !Array.isArray(input.targets) ||
    input.targets.length !== 2
  ) {
    throw failure("invalid_manifest", "The overwrite native staging contract is invalid.");
  }
  const policies = input.targets.map((value): TargetPolicy => {
    if (
      !isExactRecord(value, [
        "id",
        "platform",
        "arch",
        "compatibility",
        "build",
        "artifact",
        "integrity",
      ]) ||
      !isExactRecord(value.compatibility, [
        "napiVersion",
        "nativeProtocolVersion",
        "journalVersion",
      ]) ||
      value.compatibility.napiVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_NAPI_VERSION ||
      value.compatibility.nativeProtocolVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION ||
      value.compatibility.journalVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_JOURNAL_VERSION ||
      !isExactRecord(value.artifact, [
        "relativeDirectory",
        "format",
        "architecture",
        "minimumOsVersion",
        "requiresLoadCommandUuid",
      ]) ||
      !isExactRecord(value.integrity, [
        "algorithm",
        "binaryHashPhase",
        "allowedSignatureKinds",
      ]) ||
      value.integrity.algorithm !== "sha256" ||
      !Array.isArray(value.integrity.allowedSignatureKinds) ||
      !isExactBuildPolicy(value.build, value.platform)
    ) {
      throw failure("invalid_manifest", "An overwrite native staging target is invalid.");
    }
    const supported =
      value.id === "darwin-arm64" &&
        value.platform === "darwin" &&
        value.arch === "arm64" &&
        value.artifact.relativeDirectory === "native/darwin-arm64" &&
        value.artifact.format === "mach-o" &&
        value.artifact.architecture === "arm64" &&
        value.artifact.minimumOsVersion === "11.0.0" &&
        value.artifact.requiresLoadCommandUuid === true &&
        value.integrity.binaryHashPhase ===
          "after_nested_code_signing_before_outer_bundle_signing" &&
        sameStrings(value.integrity.allowedSignatureKinds, ["adhoc", "developer_id"])
      || value.id === "win32-x64" &&
        value.platform === "win32" &&
        value.arch === "x64" &&
        value.artifact.relativeDirectory === "native/win32-x64" &&
        value.artifact.format === "pe" &&
        value.artifact.architecture === "x64" &&
        value.artifact.minimumOsVersion === null &&
        value.artifact.requiresLoadCommandUuid === false &&
        value.integrity.binaryHashPhase ===
          "unsigned_final_bytes_before_outer_packaging" &&
        sameStrings(value.integrity.allowedSignatureKinds, ["unsigned"]);
    if (!supported) {
      throw failure("invalid_manifest", "An overwrite native staging target is unsupported.");
    }
    return deepFreeze({
      id: value.id as TargetPolicy["id"],
      platform: value.platform as LocalSubtitleOverwriteNativePlatform,
      architecture: value.arch as LocalSubtitleOverwriteNativeArchitecture,
      format: value.artifact.format as LocalSubtitleOverwriteNativeBinaryFormat,
      minimumOsVersion: value.artifact.minimumOsVersion as string | null,
      requiresLoadCommandUuid: value.artifact.requiresLoadCommandUuid as boolean,
      artifactRelativeDirectory: value.artifact.relativeDirectory as string,
      binaryHashPhase:
        value.integrity.binaryHashPhase as TargetPolicy["binaryHashPhase"],
      signatureKinds:
        value.integrity.allowedSignatureKinds as LocalSubtitleOverwriteNativeSignatureKind[],
      build: { ...(value.build as Record<string, unknown>) },
    });
  });
  if (new Set(policies.map(({ id }) => id)).size !== 2) {
    throw failure("invalid_manifest", "The overwrite native staging target set is invalid.");
  }
  return Object.freeze(policies);
}

function isExactBuildPolicy(value: unknown, platform: unknown): value is Record<string, unknown> {
  return platform === "darwin"
    ? isExactRecord(value, ["recipe", "source", "cxxStandard", "deploymentTarget"])
    : platform === "win32" &&
      isExactRecord(value, [
        "recipe",
        "source",
        "delayLoadHook",
        "nodeImportMode",
        "delayedHostBinary",
        "cxxStandard",
        "minimumWindowsVersion",
      ]);
}

function sameStrings(value: readonly unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function hasMachLoadCommand(header: Buffer, expectedCommand: number): boolean {
  if (header.length < 32) return false;
  const magicLe = header.readUInt32LE(0);
  const magicBe = header.readUInt32BE(0);
  if (magicLe !== 0xfeedfacf && magicBe !== 0xfeedfacf) return false;
  const read32 = magicLe === 0xfeedfacf
    ? (offset: number) => header.readUInt32LE(offset)
    : (offset: number) => header.readUInt32BE(offset);
  const commandCount = read32(16);
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > header.length) return false;
    const command = read32(offset);
    const commandSize = read32(offset + 4);
    if (commandSize < 8 || offset + commandSize > header.length) return false;
    if (command === expectedCommand) return true;
    offset += commandSize;
  }
  return false;
}

function isManifestFile(value: Record<PropertyKey, unknown>, maximumByteSize: number): boolean {
  return (
    typeof value.relativePath === "string" &&
    normalizeRelativePathOrUndefined(value.relativePath) !== undefined &&
    Number.isSafeInteger(value.byteSize) &&
    Number(value.byteSize) > 0 &&
    Number(value.byteSize) <= maximumByteSize &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256)
  );
}

function normalizeRelativePathOrUndefined(value: string): string | undefined {
  try {
    return normalizeRelativePath(value);
  } catch {
    return undefined;
  }
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw failure("invalid_manifest", "An overwrite native resource path is invalid.");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length < 1 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    )
  ) {
    throw failure("invalid_manifest", "An overwrite native resource path is invalid.");
  }
  return value;
}

function resolveContainedPath(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!isContainedRelativePath(path.relative(root, resolved))) {
    throw failure("invalid_manifest", "An overwrite native resource escapes its staged root.");
  }
  return resolved;
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const observed = Reflect.ownKeys(value);
  return observed.length === keys.length && keys.every((key) => observed.includes(key));
}

function withoutHeader(value: VerifiedFileRead): VerifiedFileProof {
  return {
    absolutePath: value.absolutePath,
    relativePath: value.relativePath,
    byteSize: value.byteSize,
    sha256: value.sha256,
    identity: snapshotIdentity(value.identity),
    parentIdentity: snapshotIdentity(value.parentIdentity),
  };
}

function snapshotIdentity(
  value: LocalSubtitleFilesystemObjectIdentity,
): LocalSubtitleFilesystemObjectIdentity {
  const snapshot = snapshotLocalSubtitleFilesystemObjectIdentity(value);
  if (!snapshot) throw failure("proof_invalid", "A filesystem identity proof is invalid.");
  return snapshot;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(
  code: LocalSubtitleOverwriteNativeResourceErrorCode,
  message: string,
  cause?: unknown,
): LocalSubtitleOverwriteNativeResourceError {
  return new LocalSubtitleOverwriteNativeResourceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
