import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import rawWindowsCudaManifest from "../../../resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu;
const FILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;
const DOWNLOAD_HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const MAX_ARCHIVE_ENTRIES = 128;
const MAX_ENTRY_BYTES = 640 * 1024 * 1024;
const WINDOWS_CUDA_ARCHIVE_ROOT = "Release";

const boundedStringSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const identifierSchema = boundedStringSchema.regex(IDENTIFIER_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const positiveBytesSchema = z.number().int().safe().positive();
const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(FILE_NAME_PATTERN)
  .refine((value) => value !== "." && value !== "..")
  .refine((value) => !isWindowsReservedName(value));
const archivePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
  .refine(isSafeRelativePath);
const downloadHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(DOWNLOAD_HOST_PATTERN);

const artifactSchema = z
  .object({
    id: identifierSchema,
    kind: z.enum(["server", "dynamic_library"]),
    fileName: fileNameSchema,
    relativePath: boundedStringSchema,
    byteSize: positiveBytesSchema,
    sha256: sha256Schema,
    format: z.literal("pe"),
    architecture: z.literal("x64"),
    backend: z.literal("cuda"),
    signatureKind: z.literal("unsigned"),
    licenseRef: identifierSchema,
  })
  .strict();

const acceleratorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    packId: identifierSchema,
    engine: z
      .object({
        id: z.literal("whisper.cpp"),
        version: z.literal("v1.9.1"),
        commit: z.literal("f049fff95a089aa9969deb009cdd4892b3e74916"),
      })
      .strict(),
    target: z
      .object({
        platform: z.literal("win32"),
        arch: z.literal("x64"),
        backend: z.literal("cuda"),
        cudaVersion: z.literal("12.4"),
      })
      .strict(),
    delivery: z
      .object({
        mode: z.literal("on_demand_accelerator_pack"),
        bundledInInstaller: z.literal(false),
        includedInDefaultExtraResources: z.literal(false),
        distributionProfile: z.literal("unsigned_personal_distribution"),
        signatureKind: z.literal("unsigned"),
        selfContained: z.literal(true),
      })
      .strict(),
    sourceArchive: z
      .object({
        fileName: fileNameSchema,
        downloadUrl: z.string().url().refine((value) => value.startsWith("https://")),
        allowedDownloadHosts: z
          .array(downloadHostSchema)
          .min(1)
          .max(8),
        byteSize: positiveBytesSchema,
        sha256: sha256Schema,
        expandedFileCount: z.number().int().safe().positive().max(MAX_ARCHIVE_ENTRIES),
        expandedByteSize: positiveBytesSchema,
      })
      .strict(),
    staging: z
      .object({
        developmentPackRoot: boundedStringSchema,
        baseRuntimeRoot: boundedStringSchema,
        manifestRelativePath: boundedStringSchema,
        artifactRoot: boundedStringSchema,
        publication: z.literal("atomic_directory_rename_no_clobber"),
      })
      .strict(),
    acceptance: z.unknown(),
    licenses: z.array(z.unknown()).min(1).max(16),
    selection: z
      .object({
        selectedArtifactCount: z.number().int().safe().positive().max(MAX_ARCHIVE_ENTRIES),
        selectedArtifactByteSize: positiveBytesSchema,
        excludedArchiveEntries: z
          .array(fileNameSchema)
          .max(MAX_ARCHIVE_ENTRIES),
      })
      .strict(),
    artifacts: z.array(artifactSchema).min(1).max(MAX_ARCHIVE_ENTRIES),
  })
  .strict();

const archiveEntrySchema = z
  .object({
    archiveName: archivePathSchema,
    outputRelativePath: boundedStringSchema,
    byteSize: positiveBytesSchema,
    sha256: sha256Schema,
  })
  .strict();

const archiveContractSchema = z
  .object({
    archive: z
      .object({
        byteSize: positiveBytesSchema,
        sha256: sha256Schema,
        expandedFileCount: z.number().int().safe().positive().max(MAX_ARCHIVE_ENTRIES),
        expandedByteSize: positiveBytesSchema,
      })
      .strict(),
    selectedEntries: z.array(archiveEntrySchema).min(1).max(MAX_ARCHIVE_ENTRIES),
    excludedEntries: z.array(archivePathSchema).max(MAX_ARCHIVE_ENTRIES),
    maxEntryBytes: positiveBytesSchema,
    maxCompressionRatio: z.number().finite().positive().max(10_000),
  })
  .strict();

export type LocalSubtitleAcceleratorManifest = z.infer<
  typeof acceleratorManifestSchema
>;
export type LocalSubtitleAcceleratorArchiveContract = z.infer<
  typeof archiveContractSchema
>;

export class LocalSubtitleAcceleratorManifestError extends Error {
  readonly name = "LocalSubtitleAcceleratorManifestError";
}

const EXPECTED_SOURCE_ARCHIVE = Object.freeze({
  fileName: "whisper-cublas-12.4.0-bin-x64.zip",
  downloadUrl:
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip",
  allowedDownloadHosts: [
    "github.com",
    "release-assets.githubusercontent.com",
  ],
  byteSize: 677_887_125,
  sha256: "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
  expandedFileCount: 44,
  expandedByteSize: 1_209_487_872,
} as const);
const EXPECTED_PACK_ID = "local-subtitle-windows-x64-cuda-12.4-v1";
const EXPECTED_ARTIFACTS_SHA256 =
  "fea869e4baadfc257815b5caba701e3f647f9b290f20084739ac861b780c3f84";
const EXPECTED_EXCLUDED_ENTRIES_SHA256 =
  "6ffaaa9f1de2b3e7ce348c9a42e1553336fcc3e827a58df1f76a278b58b5b6b4";

export function parseLocalSubtitleAcceleratorManifest(
  input: unknown,
): LocalSubtitleAcceleratorManifest {
  const parsed = acceleratorManifestSchema.safeParse(input);
  if (!parsed.success) throw invalidManifest();
  validateManifestSemantics(parsed.data);
  return deepFreeze(parsed.data);
}

export function parseLocalSubtitleAcceleratorArchiveContract(
  input: unknown,
): LocalSubtitleAcceleratorArchiveContract {
  const parsed = archiveContractSchema.safeParse(input);
  if (!parsed.success) throw invalidManifest();
  validateArchiveContractSemantics(parsed.data);
  return deepFreeze(parsed.data);
}

export const LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST =
  parseLocalSubtitleAcceleratorManifest(rawWindowsCudaManifest);

export const LOCAL_SUBTITLE_WINDOWS_CUDA_ARCHIVE_CONTRACT =
  parseLocalSubtitleAcceleratorArchiveContract({
    archive: {
      byteSize: LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.byteSize,
      sha256: LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.sha256,
      expandedFileCount:
        LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.expandedFileCount,
      expandedByteSize:
        LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.sourceArchive.expandedByteSize,
    },
    selectedEntries: LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.artifacts.map(
      (artifact) => ({
        archiveName: `${WINDOWS_CUDA_ARCHIVE_ROOT}/${artifact.fileName}`,
        outputRelativePath: artifact.relativePath,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      }),
    ),
    excludedEntries:
      LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST.selection.excludedArchiveEntries.map(
        (fileName) => `${WINDOWS_CUDA_ARCHIVE_ROOT}/${fileName}`,
      ),
    maxEntryBytes: MAX_ENTRY_BYTES,
    maxCompressionRatio: 200,
  });

function validateManifestSemantics(
  manifest: LocalSubtitleAcceleratorManifest,
): void {
  if (
    manifest.packId !== EXPECTED_PACK_ID ||
    !sameJson(manifest.sourceArchive, EXPECTED_SOURCE_ARCHIVE)
  ) {
    throw invalidManifest();
  }
  assertUniqueCaseInsensitive(
    manifest.sourceArchive.allowedDownloadHosts,
  );
  if (
    !downloadHostAllowed(
      new URL(manifest.sourceArchive.downloadUrl).hostname,
      manifest.sourceArchive.allowedDownloadHosts,
    )
  ) {
    throw invalidManifest();
  }
  if (
    manifest.staging.artifactRoot !== "win-x64/cuda" ||
    manifest.staging.manifestRelativePath !==
      "manifests/local-subtitle-windows-cuda-pack.v1.json" ||
    manifest.artifacts.length !== manifest.selection.selectedArtifactCount ||
    manifest.artifacts.reduce((total, artifact) => total + artifact.byteSize, 0) !==
      manifest.selection.selectedArtifactByteSize
  ) {
    throw invalidManifest();
  }
  assertUniqueCaseInsensitive(manifest.artifacts.map((artifact) => artifact.id));
  assertUniqueCaseInsensitive(
    manifest.artifacts.map((artifact) => artifact.fileName),
  );
  assertUniqueCaseInsensitive(
    manifest.artifacts.map((artifact) => artifact.relativePath),
  );
  assertUniqueCaseInsensitive(manifest.selection.excludedArchiveEntries);
  for (const artifact of manifest.artifacts) {
    const expectedRelativePath = `${manifest.staging.artifactRoot}/${artifact.fileName}`;
    if (
      artifact.relativePath !== expectedRelativePath ||
      !isSafeRelativePath(artifact.relativePath)
    ) {
      throw invalidManifest();
    }
  }
  const allArchiveEntries = [
    ...manifest.artifacts.map((artifact) => artifact.fileName),
    ...manifest.selection.excludedArchiveEntries,
  ];
  assertUniqueCaseInsensitive(allArchiveEntries);
  if (allArchiveEntries.length !== manifest.sourceArchive.expandedFileCount) {
    throw invalidManifest();
  }
  if (
    digestJson(manifest.artifacts) !== EXPECTED_ARTIFACTS_SHA256 ||
    digestJson(manifest.selection.excludedArchiveEntries) !==
      EXPECTED_EXCLUDED_ENTRIES_SHA256
  ) {
    throw invalidManifest();
  }
}

function validateArchiveContractSemantics(
  contract: LocalSubtitleAcceleratorArchiveContract,
): void {
  const archiveNames = [
    ...contract.selectedEntries.map((entry) => entry.archiveName),
    ...contract.excludedEntries,
  ];
  assertUniqueCaseInsensitive(archiveNames);
  assertUniqueCaseInsensitive(
    contract.selectedEntries.map((entry) => entry.outputRelativePath),
  );
  if (archiveNames.length !== contract.archive.expandedFileCount) {
    throw invalidManifest();
  }
  for (const entry of contract.selectedEntries) {
    if (
      entry.byteSize > contract.maxEntryBytes ||
      !isSafeRelativePath(entry.outputRelativePath)
    ) {
      throw invalidManifest();
    }
  }
  const outputPaths = contract.selectedEntries.map(
    (entry) => entry.outputRelativePath,
  );
  for (const candidate of outputPaths) {
    if (
      outputPaths.some(
        (other) =>
          other !== candidate &&
          other.toLowerCase().startsWith(`${candidate.toLowerCase()}/`),
      )
    ) {
      throw invalidManifest();
    }
  }
  const selectedBytes = contract.selectedEntries.reduce(
    (total, entry) => total + entry.byteSize,
    0,
  );
  if (selectedBytes > contract.archive.expandedByteSize) {
    throw invalidManifest();
  }
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !isWindowsReservedName(segment),
  );
}

function downloadHostAllowed(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const candidate = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith("*.")
      ? candidate.endsWith(allowed.slice(1)) && candidate !== allowed.slice(2)
      : candidate === allowed;
  });
}

function assertUniqueCaseInsensitive(values: readonly string[]): void {
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw invalidManifest();
}

function isWindowsReservedName(value: string): boolean {
  const base = value.split(".", 1)[0]!.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidManifest(): LocalSubtitleAcceleratorManifestError {
  return new LocalSubtitleAcceleratorManifestError(
    "The local subtitle accelerator manifest is invalid.",
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
