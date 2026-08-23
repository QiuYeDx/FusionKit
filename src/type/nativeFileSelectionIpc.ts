import { z } from "zod";

export const NATIVE_FILE_SELECTION_BRIDGE_VERSION = 1 as const;

export const NATIVE_FILE_SELECTION_INTERNAL_CHANNELS = {
  resolveInputFiles: "native-file-selection:internal:resolve-input-files",
} as const;

export const NATIVE_FILE_SELECTION_SOURCES = ["picker", "drop"] as const;
export type NativeFileSelectionSource =
  (typeof NATIVE_FILE_SELECTION_SOURCES)[number];

export const NATIVE_FILE_SELECTION_LIMITS = Object.freeze({
  maxFiles: 100,
  maxPathChars: 32_768,
  maxDisplayNameChars: 255,
  maxCaptureRefChars: 96,
});

export type NativeFileSelectionErrorCode =
  | "invalid_request"
  | "authorization_expired"
  | "bridge_unavailable";

export interface NativeFileSelectionError {
  readonly code: NativeFileSelectionErrorCode;
  readonly message: string;
  readonly field?: string;
}

export type NativeFileSelectionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: NativeFileSelectionError };

export interface NativeFileSelectionCapture {
  readonly captureRef: string;
  readonly fileCount: number;
}

export interface ResolvedNativeInputFile {
  readonly filePath: string;
  readonly displayName: string;
  readonly sourceDirectory: string;
}

export interface NativeFileSelectionRendererApi {
  readonly bridgeVersion: typeof NATIVE_FILE_SELECTION_BRIDGE_VERSION;
  captureInputFile(
    file: File,
    captureRef?: string,
    source?: NativeFileSelectionSource,
  ): NativeFileSelectionResult<NativeFileSelectionCapture>;
  resolveCapturedInputFiles(
    captureRef: string,
  ): Promise<NativeFileSelectionResult<readonly ResolvedNativeInputFile[]>>;
}

const nativePathSchema = z
  .string()
  .min(1)
  .max(NATIVE_FILE_SELECTION_LIMITS.maxPathChars)
  .refine((value) => !value.includes("\0"));

const displayNameSchema = z
  .string()
  .min(1)
  .max(NATIVE_FILE_SELECTION_LIMITS.maxDisplayNameChars)
  .refine((value) => value !== "." && value !== "..")
  .refine((value) => !/[\\/\0]/u.test(value));

export const nativeFileSelectionResolveRequestSchema = z
  .object({
    source: z.enum(NATIVE_FILE_SELECTION_SOURCES),
    files: z
      .array(z.object({ filePath: nativePathSchema }).strict())
      .min(1)
      .max(NATIVE_FILE_SELECTION_LIMITS.maxFiles),
  })
  .strict();

export const resolvedNativeInputFileSchema = z
  .object({
    filePath: nativePathSchema,
    displayName: displayNameSchema,
    sourceDirectory: nativePathSchema,
  })
  .strict();

export const nativeFileSelectionErrorSchema = z
  .object({
    code: z.enum([
      "invalid_request",
      "authorization_expired",
      "bridge_unavailable",
    ]),
    message: z.string().min(1).max(512),
    field: z.string().min(1).max(256).optional(),
  })
  .strict();

export const nativeFileSelectionResolveResultSchema = z.discriminatedUnion(
  "ok",
  [
    z
      .object({
        ok: z.literal(true),
        data: z
          .array(resolvedNativeInputFileSchema)
          .min(1)
          .max(NATIVE_FILE_SELECTION_LIMITS.maxFiles),
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: nativeFileSelectionErrorSchema,
      })
      .strict(),
  ],
);
