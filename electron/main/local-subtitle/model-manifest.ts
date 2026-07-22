import { z } from "zod";
import rawModelManifest from "../../../resources/local-subtitle/manifests/local-subtitle-models.v1.json";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleErrorCode,
} from "@/type/localSubtitle";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_IDENTIFIER_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu;
const FILE_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;
const GGML_MAGIC_HEX_PATTERN = /^[a-f0-9]{8}$/u;

export type LocalSubtitleModelErrorCode = Extract<
  LocalSubtitleErrorCode,
  "model_incompatible" | "model_corrupt"
>;

export type LocalSubtitleModelErrorStage =
  | "manifest"
  | "path"
  | "header"
  | "integrity";

export class LocalSubtitleModelError extends Error {
  readonly code: LocalSubtitleModelErrorCode;
  readonly stage: LocalSubtitleModelErrorStage;

  constructor(
    code: LocalSubtitleModelErrorCode,
    stage: LocalSubtitleModelErrorStage,
    message: string,
  ) {
    super(message);
    this.name = "LocalSubtitleModelError";
    this.code = code;
    this.stage = stage;
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
  .regex(MODEL_IDENTIFIER_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const sourceRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const fileNameSchema = z
  .string()
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars)
  .regex(FILE_NAME_PATTERN)
  .refine((value) => value.trim() === value)
  .refine((value) => value !== "." && value !== "..")
  .refine((value) => !isWindowsReservedName(value));
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"));

const ggmlHeaderSchema = z
  .object({
    magicHex: z.string().regex(GGML_MAGIC_HEX_PATTERN),
    headerInt32Le: z
      .array(z.number().int().min(1).max(0x7fffffff))
      .length(11),
  })
  .strict();

const modelEntrySchema = z
  .object({
    id: identifierSchema,
    resourceType: z.literal("model"),
    fileName: fileNameSchema,
    format: z.literal("ggml"),
    engineCompatibility: boundedStringSchema,
    sourceRevision: sourceRevisionSchema,
    downloadUrl: httpsUrlSchema,
    byteSize: z
      .number()
      .int()
      .safe()
      .positive()
      .max(LOCAL_SUBTITLE_LIMITS.maxMediaFileBytes),
    sha256: sha256Schema,
    license: boundedStringSchema,
    bundledInInstaller: z.boolean(),
    multilingual: z.boolean(),
    quantization: boundedStringSchema,
    defaultRecommended: z.boolean(),
    qualityLabel: boundedStringSchema,
    ggml: ggmlHeaderSchema,
  })
  .strict();

const modelCatalogSchema = z
  .array(modelEntrySchema)
  .min(1)
  .max(LOCAL_SUBTITLE_LIMITS.maxRuntimeArtifacts);

const modelManifestSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION),
    engine: z
      .object({
        id: boundedStringSchema,
        version: boundedStringSchema,
        commit: sourceRevisionSchema,
      })
      .strict(),
    models: modelCatalogSchema,
  })
  .strict();

export type LocalSubtitleModelManifest = z.infer<typeof modelManifestSchema>;
export type LocalSubtitleModelManifestEntry =
  LocalSubtitleModelManifest["models"][number];
export type LocalSubtitleGgmlManifestHeader =
  LocalSubtitleModelManifestEntry["ggml"];

const EXPECTED_ENGINE = deepFreeze({
  id: "whisper.cpp",
  version: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version,
  commit: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit,
} as const);

const EXPECTED_LAUNCH_MODEL = deepFreeze({
  id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
  resourceType: "model",
  fileName: "ggml-large-v3-q5_0.bin",
  format: "ggml",
  engineCompatibility: "whisper.cpp-v1.9.1",
  sourceRevision: "c521a4b02f422512d734391fdf08bb08c0862f68",
  downloadUrl:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin?download=true",
  byteSize: 1_081_140_203,
  sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.sha256,
  license: "MIT",
  bundledInInstaller: false,
  multilingual: true,
  quantization: "q5_0",
  defaultRecommended: true,
  qualityLabel: "quantized-large-v3",
  ggml: {
    magicHex: "6c6d6767",
    headerInt32Le: [
      51_866,
      1_500,
      1_280,
      20,
      32,
      448,
      1_280,
      20,
      32,
      128,
      2_008,
    ],
  },
} as const);

export function parseLocalSubtitleModelManifest(
  input: unknown,
): LocalSubtitleModelManifest {
  const result = modelManifestSchema.safeParse(input);
  if (!result.success) {
    throw invalidManifest("The local subtitle model manifest is invalid.");
  }
  validateManifestSemantics(result.data);
  return deepFreeze(result.data);
}

export function parseLocalSubtitleModelCatalog(
  input: unknown,
): readonly LocalSubtitleModelManifestEntry[] {
  const result = modelCatalogSchema.safeParse(input);
  if (!result.success) {
    throw invalidManifest("The local subtitle model catalog is invalid.");
  }
  assertUniqueCaseInsensitive(
    result.data.map((model) => model.id),
    "Model IDs",
  );
  assertUniqueCaseInsensitive(
    result.data.map((model) => model.fileName),
    "Model file names",
  );
  return deepFreeze(result.data);
}

export const LOCAL_SUBTITLE_MODEL_MANIFEST =
  parseLocalSubtitleModelManifest(rawModelManifest);

export function resolveLocalSubtitleModelManifestEntry(
  modelId: string,
): LocalSubtitleModelManifestEntry {
  const model = LOCAL_SUBTITLE_MODEL_MANIFEST.models.find(
    (candidate) => candidate.id === modelId,
  );
  if (!model) {
    throw new LocalSubtitleModelError(
      "model_incompatible",
      "manifest",
      "The requested local subtitle model is not allowlisted.",
    );
  }
  return model;
}

function validateManifestSemantics(
  manifest: LocalSubtitleModelManifest,
): void {
  assertUniqueCaseInsensitive(
    manifest.models.map((model) => model.id),
    "Model IDs",
  );
  assertUniqueCaseInsensitive(
    manifest.models.map((model) => model.fileName),
    "Model file names",
  );
  if (!sameEngine(manifest.engine, EXPECTED_ENGINE)) {
    throw invalidManifest(
      "The local subtitle model engine pin does not match PRE-006.",
    );
  }
  if (
    manifest.models.length !== 1 ||
    !sameModel(manifest.models[0]!, EXPECTED_LAUNCH_MODEL)
  ) {
    throw invalidManifest(
      "The local subtitle launch model pins do not match PRE-006.",
    );
  }
}

function sameEngine(
  actual: LocalSubtitleModelManifest["engine"],
  expected: typeof EXPECTED_ENGINE,
): boolean {
  return (
    actual.id === expected.id &&
    actual.version === expected.version &&
    actual.commit === expected.commit
  );
}

function sameModel(
  actual: LocalSubtitleModelManifestEntry,
  expected: typeof EXPECTED_LAUNCH_MODEL,
): boolean {
  return (
    actual.id === expected.id &&
    actual.resourceType === expected.resourceType &&
    actual.fileName === expected.fileName &&
    actual.format === expected.format &&
    actual.engineCompatibility === expected.engineCompatibility &&
    actual.sourceRevision === expected.sourceRevision &&
    actual.downloadUrl === expected.downloadUrl &&
    actual.byteSize === expected.byteSize &&
    actual.sha256 === expected.sha256 &&
    actual.license === expected.license &&
    actual.bundledInInstaller === expected.bundledInInstaller &&
    actual.multilingual === expected.multilingual &&
    actual.quantization === expected.quantization &&
    actual.defaultRecommended === expected.defaultRecommended &&
    actual.qualityLabel === expected.qualityLabel &&
    actual.ggml.magicHex === expected.ggml.magicHex &&
    sameNumberArray(actual.ggml.headerInt32Le, expected.ggml.headerInt32Le)
  );
}

function sameNumberArray(
  actual: readonly number[],
  expected: readonly number[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function assertUniqueCaseInsensitive(
  values: readonly string[],
  label: string,
): void {
  const observed = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (observed.has(key)) {
      throw invalidManifest(`${label} must be unique ignoring case.`);
    }
    observed.add(key);
  }
}

function isWindowsReservedName(fileName: string): boolean {
  const base = fileName.split(".", 1)[0]?.toUpperCase() ?? "";
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
}

function invalidManifest(message: string): LocalSubtitleModelError {
  return new LocalSubtitleModelError(
    "model_incompatible",
    "manifest",
    message,
  );
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
