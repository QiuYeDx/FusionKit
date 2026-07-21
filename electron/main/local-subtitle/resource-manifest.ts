import { z } from "zod";
import rawStagingContract from "../../../resources/local-subtitle/manifests/local-subtitle-staging.v1.json";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_RUNTIME_MANIFEST_SCHEMA_VERSION,
  LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
  type LocalSubtitleErrorCode,
} from "@/type/localSubtitle";

export const LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH =
  "manifests/local-subtitle-runtime.v1.json" as const;

export const LOCAL_SUBTITLE_RUNTIME_ARTIFACT_KINDS = [
  "server",
  "dynamic_library",
  "ffmpeg",
  "ffprobe",
] as const;
export type LocalSubtitleRuntimeArtifactKind =
  (typeof LOCAL_SUBTITLE_RUNTIME_ARTIFACT_KINDS)[number];

export const LOCAL_SUBTITLE_RUNTIME_ARTIFACT_BACKENDS = [
  "cpu",
  "cuda",
  "metal_cpu",
  "media",
] as const;
export type LocalSubtitleRuntimeArtifactBackend =
  (typeof LOCAL_SUBTITLE_RUNTIME_ARTIFACT_BACKENDS)[number];

export const LOCAL_SUBTITLE_RUNTIME_SIGNATURE_KINDS = [
  "adhoc",
  "developer_id",
  "authenticode",
  "unsigned",
] as const;
export type LocalSubtitleRuntimeSignatureKind =
  (typeof LOCAL_SUBTITLE_RUNTIME_SIGNATURE_KINDS)[number];

export const LOCAL_SUBTITLE_RUNTIME_INTEGRITY_PROFILES = [
  "macos_nested_signed_final_bytes_sha256",
  "windows_unsigned_personal_final_bytes_sha256",
] as const;
export type LocalSubtitleRuntimeIntegrityProfile =
  (typeof LOCAL_SUBTITLE_RUNTIME_INTEGRITY_PROFILES)[number];

export type LocalSubtitleRuntimePlatform = "darwin" | "win32";
export type LocalSubtitleRuntimeArchitecture = "arm64" | "x64";

export type LocalSubtitleResourceErrorCode = Extract<
  LocalSubtitleErrorCode,
  | "unsupported_platform"
  | "unsupported_architecture"
  | "runtime_missing"
  | "runtime_protocol_mismatch"
  | "media_runtime_missing"
  | "media_runtime_invalid"
>;

export type LocalSubtitleResourceErrorStage =
  | "target"
  | "manifest"
  | "static_verification";

export class LocalSubtitleResourceError extends Error {
  readonly code: LocalSubtitleResourceErrorCode;
  readonly stage: LocalSubtitleResourceErrorStage;

  constructor(
    code: LocalSubtitleResourceErrorCode,
    stage: LocalSubtitleResourceErrorStage,
    message: string,
  ) {
    super(message);
    this.name = "LocalSubtitleResourceError";
    this.code = code;
    this.stage = stage;
  }
}

const identifierSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxIdChars)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const boundedLabelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value)
  .refine((value) => !hasUnsafeControlCharacter(value));
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z.number().int().safe().positive();
const relativePathSchema = z
  .string()
  .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeRelativePathChars)
  .refine(isNormalizedManifestRelativePath);
const runtimePlatformSchema = z.enum(["darwin", "win32"]);
const runtimeArchitectureSchema = z.enum(["arm64", "x64"]);
const artifactKindSchema = z.enum(LOCAL_SUBTITLE_RUNTIME_ARTIFACT_KINDS);
const artifactBackendSchema = z.enum(
  LOCAL_SUBTITLE_RUNTIME_ARTIFACT_BACKENDS,
);
const signatureKindSchema = z.enum(LOCAL_SUBTITLE_RUNTIME_SIGNATURE_KINDS);
const integrityProfileSchema = z.enum(
  LOCAL_SUBTITLE_RUNTIME_INTEGRITY_PROFILES,
);

const stagingIntegritySchema = z
  .object({
    algorithm: z.literal("sha256"),
    binaryHashPhase: z.enum([
      "after_nested_code_signing_before_outer_bundle_signing",
      "unsigned_final_bytes_before_outer_packaging",
    ]),
    outerSignatureCoverage: z.enum([
      "required",
      "not_required_personal_distribution",
    ]),
  })
  .strict();

const stagingLimitsSchema = z
  .object({
    maxIdChars: z.literal(LOCAL_SUBTITLE_LIMITS.maxIdChars),
    maxManifestBytes: z.literal(LOCAL_SUBTITLE_LIMITS.maxRuntimeManifestBytes),
    maxArtifacts: z.literal(LOCAL_SUBTITLE_LIMITS.maxRuntimeArtifacts),
    maxLicenses: z.literal(LOCAL_SUBTITLE_LIMITS.maxRuntimeLicenses),
    maxSources: z.literal(LOCAL_SUBTITLE_LIMITS.maxRuntimeSources),
    maxEvidenceFiles: z.literal(
      LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles,
    ),
    maxRelativePathChars: z.literal(
      LOCAL_SUBTITLE_LIMITS.maxRuntimeRelativePathChars,
    ),
  })
  .strict();

const requiredEvidenceFileSchema = z
  .object({
    relativePath: relativePathSchema,
    byteSize: positiveSafeIntegerSchema,
    sha256: sha256Schema,
  })
  .strict();

const requiredArtifactSchema = z
  .object({
    id: identifierSchema,
    kind: artifactKindSchema,
    backend: artifactBackendSchema,
    relativePath: relativePathSchema,
    licenseRef: identifierSchema,
    sourceRef: identifierSchema,
    executable: z.boolean(),
  })
  .strict();

const requiredLicenseSchema = z
  .object({
    id: identifierSchema,
    component: boundedLabelSchema,
    spdxExpression: boundedLabelSchema,
    licenseFiles: z
      .array(requiredEvidenceFileSchema)
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles),
    noticeFiles: z
      .array(requiredEvidenceFileSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles),
  })
  .strict();

const requiredSourceSchema = z
  .object({
    id: identifierSchema,
    component: boundedLabelSchema,
    version: boundedLabelSchema,
    evidenceFile: requiredEvidenceFileSchema,
  })
  .strict();

const stagingTargetSchema = z
  .object({
    id: identifierSchema,
    platform: runtimePlatformSchema,
    arch: runtimeArchitectureSchema,
    integrityProfile: integrityProfileSchema,
    integrity: stagingIntegritySchema,
    allowedSignatureKinds: z.array(signatureKindSchema).min(1).max(2),
    artifactVersions: z
      .object({
        runner: boundedLabelSchema,
        media: boundedLabelSchema,
      })
      .strict(),
    requiredArtifacts: z
      .array(requiredArtifactSchema)
      .min(3)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeArtifacts),
    requiredLicenses: z
      .array(requiredLicenseSchema)
      .min(2)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeLicenses),
    requiredSources: z
      .array(requiredSourceSchema)
      .min(2)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeSources),
  })
  .strict();

const stagingContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeManifestSchemaVersion: z.literal(
      LOCAL_SUBTITLE_RUNTIME_MANIFEST_SCHEMA_VERSION,
    ),
    runtimeContractVersion: z.literal(
      LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    ),
    developmentRuntimeRoot: z.literal(
      "build/local-subtitle-resources/local-subtitle",
    ),
    packagedRuntimeRoot: z.literal("local-subtitle"),
    runtimeManifestRelativePath: z.literal(
      LOCAL_SUBTITLE_RUNTIME_MANIFEST_RELATIVE_PATH,
    ),
    artifactNamePattern: z.literal(
      "${productName}_${version}_${arch}.${ext}",
    ),
    limits: stagingLimitsSchema,
    targets: z.array(stagingTargetSchema).length(2),
  })
  .strict();

export type LocalSubtitleStagingContract = z.infer<
  typeof stagingContractSchema
>;
export type LocalSubtitleStagingTarget =
  LocalSubtitleStagingContract["targets"][number];

const evidenceFileSchema = requiredEvidenceFileSchema;

const licenseRecordSchema = z
  .object({
    id: identifierSchema,
    component: boundedLabelSchema,
    spdxExpression: boundedLabelSchema,
    licenseFiles: z
      .array(evidenceFileSchema)
      .min(1)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles),
    noticeFiles: z
      .array(evidenceFileSchema)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles),
  })
  .strict();

const sourceRecordSchema = z
  .object({
    id: identifierSchema,
    component: boundedLabelSchema,
    version: boundedLabelSchema,
    evidenceFile: evidenceFileSchema,
  })
  .strict();

const artifactRecordSchema = z
  .object({
    id: identifierSchema,
    kind: artifactKindSchema,
    platform: runtimePlatformSchema,
    arch: runtimeArchitectureSchema,
    backend: artifactBackendSchema,
    relativePath: relativePathSchema,
    byteSize: positiveSafeIntegerSchema,
    sha256: sha256Schema,
    version: boundedLabelSchema,
    licenseRef: identifierSchema,
    sourceRef: identifierSchema,
    executable: z.boolean(),
    signatureKind: signatureKindSchema,
  })
  .strict();

const runtimeManifestSchema = z
  .object({
    schemaVersion: z.literal(
      LOCAL_SUBTITLE_RUNTIME_MANIFEST_SCHEMA_VERSION,
    ),
    runtimeContractVersion: z.literal(
      LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION,
    ),
    manifestId: identifierSchema,
    target: z
      .object({
        platform: runtimePlatformSchema,
        arch: runtimeArchitectureSchema,
      })
      .strict(),
    integrityProfile: integrityProfileSchema,
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        binaryHashPhase: z.enum([
          "after_nested_code_signing_before_outer_bundle_signing",
          "unsigned_final_bytes_before_outer_packaging",
        ]),
        outerSignatureCoverage: z.enum([
          "required",
          "not_required_personal_distribution",
        ]),
      })
      .strict(),
    artifacts: z
      .array(artifactRecordSchema)
      .min(3)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeArtifacts),
    licenses: z
      .array(licenseRecordSchema)
      .min(2)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeLicenses),
    sources: z
      .array(sourceRecordSchema)
      .min(2)
      .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeSources),
  })
  .strict();

export type LocalSubtitleRuntimeManifest = z.infer<
  typeof runtimeManifestSchema
>;
export type LocalSubtitleRuntimeArtifact =
  LocalSubtitleRuntimeManifest["artifacts"][number];
export type LocalSubtitleRuntimeLicense =
  LocalSubtitleRuntimeManifest["licenses"][number];
export type LocalSubtitleRuntimeSource =
  LocalSubtitleRuntimeManifest["sources"][number];

export interface LocalSubtitleNativeBinaryIdentity {
  readonly format:
    | "mach-o"
    | "mach-o-fat"
    | "mach-o-fat-invalid"
    | "pe"
    | "unknown";
  readonly architectures: readonly string[];
  readonly minimumOsVersion: string | null;
}

export function parseLocalSubtitleStagingContract(
  input: unknown,
): LocalSubtitleStagingContract {
  const result = stagingContractSchema.safeParse(input);
  if (!result.success) {
    throw invalidManifest("The local subtitle staging contract is invalid.");
  }
  validateStagingContractSemantics(result.data);
  return deepFreeze(result.data);
}

export const LOCAL_SUBTITLE_STAGING_CONTRACT =
  parseLocalSubtitleStagingContract(rawStagingContract);

export function assertSupportedLocalSubtitleRuntimeTarget(
  platform: NodeJS.Platform | string,
  arch: string,
): LocalSubtitleStagingTarget {
  if (platform !== "darwin" && platform !== "win32") {
    throw new LocalSubtitleResourceError(
      "unsupported_platform",
      "target",
      "The local subtitle runtime does not support this platform.",
    );
  }
  const expectedArch = platform === "darwin" ? "arm64" : "x64";
  if (arch !== expectedArch) {
    throw new LocalSubtitleResourceError(
      "unsupported_architecture",
      "target",
      platform === "darwin"
        ? "The macOS local subtitle runtime requires arm64."
        : "The Windows local subtitle runtime requires x64.",
    );
  }
  const target = LOCAL_SUBTITLE_STAGING_CONTRACT.targets.find(
    (candidate) =>
      candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) {
    throw invalidManifest("The staging contract is missing a supported target.");
  }
  return target;
}

export function parseLocalSubtitleRuntimeManifest(
  input: unknown,
  options: {
    readonly platform: NodeJS.Platform | string;
    readonly arch: string;
  },
): LocalSubtitleRuntimeManifest {
  const target = assertSupportedLocalSubtitleRuntimeTarget(
    options.platform,
    options.arch,
  );
  if (isPlainObject(input)) {
    if (
      input.runtimeContractVersion !== undefined &&
      input.runtimeContractVersion !==
        LOCAL_SUBTITLE_SERVER_HTTP_CONTRACT_VERSION
    ) {
      throw new LocalSubtitleResourceError(
        "runtime_protocol_mismatch",
        "manifest",
        "The bundled runtime protocol version is not supported.",
      );
    }
  }
  const result = runtimeManifestSchema.safeParse(input);
  if (!result.success) {
    throw invalidManifest("The bundled runtime manifest is invalid.");
  }
  validateRuntimeManifestSemantics(result.data, target);
  return deepFreeze(result.data);
}

export function normalizeLocalSubtitleManifestRelativePath(
  value: string,
): string {
  if (!isNormalizedManifestRelativePath(value)) {
    throw invalidManifest(
      "A bundled runtime resource path is not a normalized relative path.",
    );
  }
  return value;
}

export function inspectLocalSubtitleNativeBinary(
  buffer: Buffer,
): LocalSubtitleNativeBinaryIdentity {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { format: "unknown", architectures: [], minimumOsVersion: null };
  }

  const magicBe = buffer.readUInt32BE(0);
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const is64 = magicBe === 0xcafebabf;
    const entrySize = is64 ? 32 : 20;
    const count = buffer.readUInt32BE(4);
    if (count < 1 || count > 16 || buffer.length < 8 + count * entrySize) {
      return {
        format: "mach-o-fat-invalid",
        architectures: [],
        minimumOsVersion: null,
      };
    }
    const architectures: string[] = [];
    for (let index = 0; index < count; index += 1) {
      architectures.push(
        mapMachCpuType(buffer.readUInt32BE(8 + index * entrySize)),
      );
    }
    return {
      format: "mach-o-fat",
      architectures: [...new Set(architectures)],
      minimumOsVersion: null,
    };
  }

  const magicLe = buffer.readUInt32LE(0);
  if (magicLe === 0xfeedfacf || magicBe === 0xfeedfacf) {
    const littleEndian = magicLe === 0xfeedfacf;
    const read32 = littleEndian
      ? (offset: number) => buffer.readUInt32LE(offset)
      : (offset: number) => buffer.readUInt32BE(offset);
    const architecture = mapMachCpuType(read32(4));
    const commandCount = read32(16);
    let offset = 32;
    let minimumOsVersion: string | null = null;
    for (let index = 0; index < commandCount; index += 1) {
      if (offset + 8 > buffer.length) break;
      const command = read32(offset);
      const commandSize = read32(offset + 4);
      if (commandSize < 8 || offset + commandSize > buffer.length) break;
      if (command === 0x32 && commandSize >= 24) {
        minimumOsVersion = decodePackedVersion(read32(offset + 12));
      } else if (command === 0x24 && commandSize >= 16) {
        minimumOsVersion = decodePackedVersion(read32(offset + 8));
      }
      offset += commandSize;
    }
    return {
      format: "mach-o",
      architectures: [architecture],
      minimumOsVersion,
    };
  }

  if (buffer[0] === 0x4d && buffer[1] === 0x5a && buffer.length >= 64) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= buffer.length &&
      buffer.toString("binary", peOffset, peOffset + 4) === "PE\0\0"
    ) {
      return {
        format: "pe",
        architectures: [mapPeMachine(buffer.readUInt16LE(peOffset + 4))],
        minimumOsVersion: null,
      };
    }
  }

  return { format: "unknown", architectures: [], minimumOsVersion: null };
}

export function isLocalSubtitleMediaArtifact(
  artifact: Pick<LocalSubtitleRuntimeArtifact, "kind">,
): boolean {
  return artifact.kind === "ffmpeg" || artifact.kind === "ffprobe";
}

function validateStagingContractSemantics(
  contract: LocalSubtitleStagingContract,
): void {
  const observedTargets = new Set<string>();
  for (const target of contract.targets) {
    const targetKey = `${target.platform}-${target.arch}`;
    if (observedTargets.has(targetKey)) {
      throw invalidManifest("Staging contract targets must be unique.");
    }
    observedTargets.add(targetKey);
    const expected = expectedTargetPolicy(target.platform, target.arch);
    if (
      target.id !== expected.id ||
      target.integrityProfile !== expected.integrityProfile ||
      !sameRecord(target.artifactVersions, expected.artifactVersions) ||
      !sameStringSet(
        target.allowedSignatureKinds,
        expected.allowedSignatureKinds,
      ) ||
      !sameRecord(target.integrity, expected.integrity)
    ) {
      throw invalidManifest("A staging target policy is not supported.");
    }
    validateRequiredArtifacts(target);
    assertUniqueBy(target.requiredLicenses, (record) => record.id);
    assertUniqueBy(target.requiredSources, (record) => record.id);
    const licenseIds = new Set(target.requiredLicenses.map((record) => record.id));
    const sourceIds = new Set(target.requiredSources.map((record) => record.id));
    for (const artifact of target.requiredArtifacts) {
      if (
        !licenseIds.has(artifact.licenseRef) ||
        !sourceIds.has(artifact.sourceRef)
      ) {
        throw invalidManifest(
          "A required artifact references unknown evidence.",
        );
      }
    }
    const evidencePaths = [
      ...target.requiredLicenses.flatMap((license) => [
        ...license.licenseFiles.map((file) => file.relativePath),
        ...license.noticeFiles.map((file) => file.relativePath),
      ]),
      ...target.requiredSources.map(
        (source) => source.evidenceFile.relativePath,
      ),
    ];
    if (evidencePaths.length > contract.limits.maxEvidenceFiles) {
      throw invalidManifest("A staging target has too many evidence files.");
    }
    assertUniqueCaseInsensitivePaths([
      ...target.requiredArtifacts.map((artifact) => artifact.relativePath),
      ...evidencePaths,
    ]);
  }
  if (
    !observedTargets.has("darwin-arm64") ||
    !observedTargets.has("win32-x64")
  ) {
    throw invalidManifest("The staging contract target matrix is incomplete.");
  }
}

function expectedArtifactVersion(
  artifact: Pick<LocalSubtitleStagingTarget["requiredArtifacts"][number], "kind">,
  target: LocalSubtitleStagingTarget,
): string {
  return artifact.kind === "ffmpeg" || artifact.kind === "ffprobe"
    ? target.artifactVersions.media
    : target.artifactVersions.runner;
}

function validateRequiredArtifacts(target: LocalSubtitleStagingTarget): void {
  assertUniqueBy(target.requiredArtifacts, (artifact) => artifact.id);
  assertUniqueCaseInsensitivePaths(
    target.requiredArtifacts.map((artifact) => artifact.relativePath),
  );
  const kinds = new Map<LocalSubtitleRuntimeArtifactKind, number>();
  for (const artifact of target.requiredArtifacts) {
    kinds.set(artifact.kind, (kinds.get(artifact.kind) ?? 0) + 1);
    if (
      (artifact.kind === "ffmpeg" || artifact.kind === "ffprobe") &&
      artifact.backend !== "media"
    ) {
      throw invalidManifest("Bundled media tools must use the media backend.");
    }
    if (
      artifact.kind === "dynamic_library" &&
      (artifact.executable || artifact.backend === "media")
    ) {
      throw invalidManifest("A dynamic library contract is invalid.");
    }
    if (artifact.kind !== "dynamic_library" && !artifact.executable) {
      throw invalidManifest("Bundled programs must be executable.");
    }
  }
  for (const requiredKind of ["server", "ffmpeg", "ffprobe"] as const) {
    if (kinds.get(requiredKind) !== 1) {
      throw invalidManifest(
        `The staging contract must contain exactly one ${requiredKind}.`,
      );
    }
  }
}

function validateRuntimeManifestSemantics(
  manifest: LocalSubtitleRuntimeManifest,
  target: LocalSubtitleStagingTarget,
): void {
  if (
    manifest.target.platform !== target.platform ||
    manifest.target.arch !== target.arch ||
    manifest.integrityProfile !== target.integrityProfile ||
    !sameRecord(
      {
        algorithm: manifest.integrity.algorithm,
        binaryHashPhase: manifest.integrity.binaryHashPhase,
        outerSignatureCoverage: manifest.integrity.outerSignatureCoverage,
      },
      target.integrity,
    )
  ) {
    throw invalidManifest(
      "The bundled runtime target or integrity profile does not match.",
    );
  }

  const artifactsById = uniqueMap(manifest.artifacts, "artifact");
  if (artifactsById.size !== target.requiredArtifacts.length) {
    throw invalidManifest("The bundled runtime artifact set is incomplete.");
  }
  for (const expected of target.requiredArtifacts) {
    const artifact = artifactsById.get(expected.id);
    if (
      !artifact ||
      artifact.kind !== expected.kind ||
      artifact.platform !== target.platform ||
      artifact.arch !== target.arch ||
      artifact.backend !== expected.backend ||
      artifact.relativePath !== expected.relativePath ||
      artifact.licenseRef !== expected.licenseRef ||
      artifact.sourceRef !== expected.sourceRef ||
      artifact.executable !== expected.executable ||
      artifact.version !== expectedArtifactVersion(expected, target) ||
      !target.allowedSignatureKinds.includes(artifact.signatureKind)
    ) {
      throw invalidManifest(
        "A bundled runtime artifact does not match the staging contract.",
      );
    }
  }

  validateEvidenceSemantics(manifest, target);
  const evidencePaths = [
    ...manifest.licenses.flatMap((license) => [
      ...license.licenseFiles.map((file) => file.relativePath),
      ...license.noticeFiles.map((file) => file.relativePath),
    ]),
    ...manifest.sources.map((source) => source.evidenceFile.relativePath),
  ];
  if (evidencePaths.length > LOCAL_SUBTITLE_LIMITS.maxRuntimeEvidenceFiles) {
    throw invalidManifest("The bundled runtime manifest has too many files.");
  }
  assertUniqueCaseInsensitivePaths([
    ...manifest.artifacts.map((artifact) => artifact.relativePath),
    ...evidencePaths,
  ]);
}

function validateEvidenceSemantics(
  manifest: LocalSubtitleRuntimeManifest,
  target: LocalSubtitleStagingTarget,
): void {
  const licenses = uniqueMap(manifest.licenses, "license");
  const sources = uniqueMap(manifest.sources, "source");
  if (
    licenses.size !== target.requiredLicenses.length ||
    sources.size !== target.requiredSources.length
  ) {
    throw invalidManifest("The bundled runtime evidence set is incomplete.");
  }
  for (const expected of target.requiredLicenses) {
    const actual = licenses.get(expected.id);
    if (
      !actual ||
      actual.component !== expected.component ||
      actual.spdxExpression !== expected.spdxExpression ||
      !sameEvidenceFiles(actual.licenseFiles, expected.licenseFiles) ||
      !sameEvidenceFiles(actual.noticeFiles, expected.noticeFiles)
    ) {
      throw invalidManifest("A license record does not match its component.");
    }
  }
  for (const expected of target.requiredSources) {
    const actual = sources.get(expected.id);
    if (
      !actual ||
      actual.component !== expected.component ||
      actual.version !== expected.version ||
      !sameRecord(actual.evidenceFile, expected.evidenceFile)
    ) {
      throw invalidManifest("A source record does not match its component.");
    }
  }
}

function expectedTargetPolicy(
  platform: LocalSubtitleRuntimePlatform,
  arch: LocalSubtitleRuntimeArchitecture,
) {
  if (platform === "darwin" && arch === "arm64") {
    return {
      id: "darwin-arm64",
      integrityProfile: "macos_nested_signed_final_bytes_sha256",
      allowedSignatureKinds: ["adhoc", "developer_id"],
      artifactVersions: {
        runner: "v1.9.1+f049fff",
        media: "8.1.2",
      },
      integrity: {
        algorithm: "sha256",
        binaryHashPhase:
          "after_nested_code_signing_before_outer_bundle_signing",
        outerSignatureCoverage: "required",
      },
    } as const;
  }
  if (platform === "win32" && arch === "x64") {
    return {
      id: "win32-x64",
      integrityProfile: "windows_unsigned_personal_final_bytes_sha256",
      allowedSignatureKinds: ["unsigned"],
      artifactVersions: {
        runner: "v1.9.1+f049fff",
        media: "n8.1.2-21-gce3c09c101-20260630",
      },
      integrity: {
        algorithm: "sha256",
        binaryHashPhase: "unsigned_final_bytes_before_outer_packaging",
        outerSignatureCoverage: "not_required_personal_distribution",
      },
    } as const;
  }
  throw invalidManifest("The staging contract contains an unsupported target.");
}

function isNormalizedManifestRelativePath(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxRuntimeRelativePathChars ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.trim() !== value ||
    hasUnsafeControlCharacter(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        isWindowsReservedName(segment),
    )
  ) {
    return false;
  }
  return value === segments.join("/");
}

function isWindowsReservedName(segment: string): boolean {
  const base = segment.split(".", 1)[0]?.toUpperCase() ?? "";
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function hasUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function uniqueMap<T extends { readonly id: string }>(
  records: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const key = record.id.toLowerCase();
    if (result.has(key)) {
      throw invalidManifest(`Bundled runtime ${label} IDs must be unique.`);
    }
    result.set(key, record);
  }
  return result;
}

function assertUniqueBy<T>(
  records: readonly T[],
  selector: (record: T) => string,
): void {
  const values = new Set<string>();
  for (const record of records) {
    const value = selector(record).toLowerCase();
    if (values.has(value)) {
      throw invalidManifest("Staging contract IDs must be unique.");
    }
    values.add(value);
  }
}

function assertUniqueCaseInsensitivePaths(paths: readonly string[]): void {
  const observed = new Set<string>();
  for (const value of paths) {
    const key = value.toLowerCase();
    if (observed.has(key)) {
      throw invalidManifest(
        "Bundled runtime paths must be globally unique.",
      );
    }
    observed.add(key);
  }
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function sameEvidenceFiles(
  left: readonly {
    readonly relativePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }[],
  right: readonly {
    readonly relativePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByPath = new Map(
    right.map((record) => [record.relativePath.toLowerCase(), record]),
  );
  return left.every((record) => {
    const expected = rightByPath.get(record.relativePath.toLowerCase());
    return expected !== undefined && sameRecord(record, expected);
  });
}

function sameRecord(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1],
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidManifest(message: string): LocalSubtitleResourceError {
  return new LocalSubtitleResourceError(
    "media_runtime_invalid",
    "manifest",
    message,
  );
}

function mapMachCpuType(value: number): string {
  if (value === 0x0100000c) return "arm64";
  if (value === 0x01000007) return "x64";
  return `mach-${value.toString(16)}`;
}

function mapPeMachine(value: number): string {
  if (value === 0x8664) return "x64";
  if (value === 0xaa64) return "arm64";
  return `pe-${value.toString(16)}`;
}

function decodePackedVersion(value: number): string {
  return `${(value >>> 16) & 0xffff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
