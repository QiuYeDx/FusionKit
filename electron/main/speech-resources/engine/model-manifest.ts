import { z } from "zod";
import rawModelManifest from "../../../../resources/speech-resources/manifests/speech-models.v1.json";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_MODEL_MANIFEST_VERSION,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleErrorCode,
} from "../../../../src/speech-resources/contracts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_IDENTIFIER_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu;
const FILE_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;
const GGML_MAGIC_HEX_PATTERN = /^[a-f0-9]{8}$/u;
const DOWNLOAD_HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

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
    allowedDownloadHosts: z
      .array(z.string().min(1).max(253).regex(DOWNLOAD_HOST_PATTERN))
      .min(1)
      .max(8),
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

const EXPECTED_MODELS = deepFreeze([
  {
    id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.launchModel.id,
    resourceType: "model",
    fileName: "ggml-large-v3-q5_0.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: "c521a4b02f422512d734391fdf08bb08c0862f68",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin?download=true",
    allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
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
  },
  {
    id: "large-v3",
    resourceType: "model",
    fileName: "ggml-large-v3.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: "c521a4b02f422512d734391fdf08bb08c0862f68",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3.bin?download=true",
    allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
    byteSize: 3_095_033_483,
    sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    license: "MIT",
    bundledInInstaller: false,
    multilingual: true,
    quantization: "f16",
    defaultRecommended: false,
    qualityLabel: "full-large-v3",
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
        1,
      ],
    },
  },
  {
    id: "large-v3-turbo-q8_0",
    resourceType: "model",
    fileName: "ggml-large-v3-turbo-q8_0.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q8_0.bin?download=true",
    allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
    byteSize: 874_188_075,
    sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    license: "MIT",
    bundledInInstaller: false,
    multilingual: true,
    quantization: "q8_0",
    defaultRecommended: false,
    qualityLabel: "quantized-large-v3-turbo",
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
        4,
        128,
        2_007,
      ],
    },
  },
  {
    id: "belle-large-v3-turbo-zh",
    resourceType: "model",
    fileName: "ggml-belle-large-v3-turbo-zh.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: "0a7f57392b773254eb60da8e49c7c683af369625",
    downloadUrl:
      "https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/0a7f57392b773254eb60da8e49c7c683af369625/ggml-model.bin?download=true",
    allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
    byteSize: 1_624_555_275,
    sha256: "2a3bba5bfdb4d4da3d9949a83b405711727ca1941d4d5810895e077eb3cb4d99",
    license: "Apache-2.0",
    bundledInInstaller: false,
    multilingual: true,
    quantization: "f16",
    defaultRecommended: false,
    qualityLabel: "full-belle-large-v3-turbo-zh",
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
        4,
        128,
        1,
      ],
    },
  },
  {
    id: "anime-whisper-q8_0",
    resourceType: "model",
    fileName: "ggml-anime-whisper-q8_0.bin",
    format: "ggml",
    engineCompatibility: "whisper.cpp-v1.9.1",
    sourceRevision: "35b467f144c62a3ab2d84bfbb517d6af5135444a",
    downloadUrl:
      "https://huggingface.co/Aratako/anime-whisper-ggml/resolve/35b467f144c62a3ab2d84bfbb517d6af5135444a/ggml-anime-whisper-q8_0.bin?download=true",
    allowedDownloadHosts: ["huggingface.co", "*.hf.co"],
    byteSize: 818_305_955,
    sha256: "6a04b7460bdcf2a16aa568c96dd670070abe553936c82fbbff86fc41d02ac3f3",
    license: "MIT",
    bundledInInstaller: false,
    multilingual: true,
    quantization: "q8_0",
    defaultRecommended: false,
    qualityLabel: "quantized-anime-whisper",
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
        2,
        128,
        2_007,
      ],
    },
  },
] as const);

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
  validateCatalogSemantics(result.data);
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
  validateCatalogSemantics(manifest.models);
  if (!sameEngine(manifest.engine, EXPECTED_ENGINE)) {
    throw invalidManifest(
      "The local subtitle model engine pin does not match PRE-006.",
    );
  }
  if (
    manifest.models.length !== EXPECTED_MODELS.length ||
    manifest.models.some(
      (model, index) => !sameModel(model, EXPECTED_MODELS[index]!),
    )
  ) {
    throw invalidManifest(
      "The local subtitle model pins do not match the production allowlist.",
    );
  }
}

function validateCatalogSemantics(
  models: readonly LocalSubtitleModelManifestEntry[],
): void {
  assertUniqueCaseInsensitive(
    models.map((model) => model.id),
    "Model IDs",
  );
  assertUniqueCaseInsensitive(
    models.map((model) => model.fileName),
    "Model file names",
  );
  for (const model of models) {
    assertUniqueCaseInsensitive(
      model.allowedDownloadHosts,
      "Model download hosts",
    );
    const sourceHost = new URL(model.downloadUrl).hostname.toLowerCase();
    if (!downloadHostAllowed(sourceHost, model.allowedDownloadHosts)) {
      throw invalidManifest(
        "The local subtitle model source host is not allowlisted.",
      );
    }
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
  expected: (typeof EXPECTED_MODELS)[number],
): boolean {
  return (
    actual.id === expected.id &&
    actual.resourceType === expected.resourceType &&
    actual.fileName === expected.fileName &&
    actual.format === expected.format &&
    actual.engineCompatibility === expected.engineCompatibility &&
    actual.sourceRevision === expected.sourceRevision &&
    actual.downloadUrl === expected.downloadUrl &&
    sameStringArray(
      actual.allowedDownloadHosts,
      expected.allowedDownloadHosts,
    ) &&
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

function sameStringArray(
  actual: readonly string[],
  expected: readonly string[],
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
