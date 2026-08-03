import { z } from "zod";
import rawVadManifest from "../../../resources/local-subtitle/manifests/local-subtitle-vad.v1.json";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_VAD_MANIFEST_VERSION,
  type LocalSubtitleErrorCode,
} from "@/type/localSubtitle";

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu;
const FILE_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DOWNLOAD_HOST_PATTERN =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

export class LocalSubtitleVadManifestError extends Error {
  readonly name = "LocalSubtitleVadManifestError";

  constructor(
    readonly localSubtitleCode: Extract<
      LocalSubtitleErrorCode,
      "resource_not_allowed" | "resource_signature_invalid"
    >,
    message: string,
  ) {
    super(message);
  }
}

const boundedStringSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const identifierSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxIdChars)
  .regex(IDENTIFIER_PATTERN);
const fileNameSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars)
  .regex(FILE_NAME_PATTERN)
  .refine((value) => value !== "." && value !== "..")
  .refine((value) => !isWindowsReservedName(value));
const sourceRevisionSchema = z.string().regex(SOURCE_REVISION_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"));

const vadEntrySchema = z
  .object({
    id: identifierSchema,
    resourceType: z.literal("vad"),
    fileName: fileNameSchema,
    format: z.literal("ggml"),
    engineCompatibility: boundedStringSchema,
    sourceRevision: sourceRevisionSchema,
    downloadUrl: httpsUrlSchema,
    allowedDownloadHosts: z
      .array(z.string().min(1).max(253).regex(DOWNLOAD_HOST_PATTERN))
      .min(1)
      .max(8),
    byteSize: z.number().int().safe().positive(),
    sha256: sha256Schema,
    license: boundedStringSchema,
    bundledInInstaller: z.literal(false),
    defaultEnabled: z.boolean(),
    tokenTimestampsAllowed: z.literal(false),
    timelinePolicy: z.literal(
      LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
    ),
  })
  .strict();

const vadManifestSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SUBTITLE_VAD_MANIFEST_VERSION),
    engine: z
      .object({
        id: boundedStringSchema,
        version: boundedStringSchema,
        commit: sourceRevisionSchema,
      })
      .strict(),
    vad: vadEntrySchema,
  })
  .strict();

export type LocalSubtitleVadManifest = z.infer<typeof vadManifestSchema>;
export type LocalSubtitleVadManifestEntry = LocalSubtitleVadManifest["vad"];

const EXPECTED_MANIFEST = deepFreeze({
  schemaVersion: LOCAL_SUBTITLE_VAD_MANIFEST_VERSION,
  engine: {
    id: "whisper.cpp",
    version: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
    commit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
  },
  vad: {
    id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
    resourceType: "vad",
    fileName: "for-tests-silero-v6.2.0-ggml.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
    downloadUrl:
      "https://raw.githubusercontent.com/ggml-org/whisper.cpp/f049fff95a089aa9969deb009cdd4892b3e74916/models/for-tests-silero-v6.2.0-ggml.bin",
    allowedDownloadHosts: ["raw.githubusercontent.com"],
    byteSize: 885_098,
    sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
    license: "MIT",
    bundledInInstaller: false,
    defaultEnabled: true,
    tokenTimestampsAllowed: false,
    timelinePolicy: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.timelinePolicy,
  },
} as const);

export function parseLocalSubtitleVadManifest(
  input: unknown,
): LocalSubtitleVadManifest {
  const parsed = vadManifestSchema.safeParse(input);
  if (!parsed.success) throw invalidManifest();
  const manifest = parsed.data;
  if (
    JSON.stringify(manifest) !== JSON.stringify(EXPECTED_MANIFEST) ||
    !downloadHostAllowed(
      new URL(manifest.vad.downloadUrl).hostname.toLowerCase(),
      manifest.vad.allowedDownloadHosts,
    ) ||
    new Set(
      manifest.vad.allowedDownloadHosts.map((host) => host.toLowerCase()),
    ).size !== manifest.vad.allowedDownloadHosts.length
  ) {
    throw invalidManifest();
  }
  return deepFreeze(structuredClone(manifest));
}

export const LOCAL_SUBTITLE_VAD_MANIFEST =
  parseLocalSubtitleVadManifest(rawVadManifest);

function downloadHostAllowed(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  return allowedHosts.some((entry) => {
    const candidate = entry.toLowerCase();
    if (candidate.startsWith("*.")) {
      const suffix = candidate.slice(1);
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === candidate;
  });
}

function isWindowsReservedName(fileName: string): boolean {
  const base = fileName.split(".", 1)[0]?.toUpperCase() ?? "";
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function invalidManifest(): LocalSubtitleVadManifestError {
  return new LocalSubtitleVadManifestError(
    "resource_signature_invalid",
    "The local subtitle VAD manifest does not match the frozen production contract.",
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
