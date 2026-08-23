import type { IpcRenderer, WebUtils } from "electron";
import {
  NATIVE_FILE_SELECTION_BRIDGE_VERSION,
  NATIVE_FILE_SELECTION_INTERNAL_CHANNELS,
  NATIVE_FILE_SELECTION_LIMITS,
  nativeFileSelectionResolveResultSchema,
  type NativeFileSelectionCapture,
  type NativeFileSelectionRendererApi,
  type NativeFileSelectionResult,
  type NativeFileSelectionSource,
  type ResolvedNativeInputFile,
} from "@/type/nativeFileSelectionIpc";

export interface CreateNativeFileSelectionRendererApiOptions {
  readonly ipcRenderer: Pick<IpcRenderer, "invoke">;
  readonly webUtils: Pick<WebUtils, "getPathForFile">;
  readonly now?: () => number;
  readonly createCaptureNonce?: () => string;
}

const INPUT_CAPTURE_TTL_MS = 30_000;
const MAX_PENDING_INPUT_CAPTURES = 8;
const INPUT_CAPTURE_NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const INPUT_CAPTURE_REF_PATTERN = /^native_file_input_[0-9a-f]{32}$/u;

interface PendingInputCapture {
  readonly files: ReadonlyArray<{ readonly filePath: string }>;
  readonly source: NativeFileSelectionSource;
  readonly expiresAt: number;
}

export function createNativeFileSelectionRendererApi({
  ipcRenderer,
  webUtils,
  now = Date.now,
  createCaptureNonce = defaultCaptureNonce,
}: CreateNativeFileSelectionRendererApiOptions): NativeFileSelectionRendererApi {
  const pendingInputCaptures = new Map<string, PendingInputCapture>();

  const purgeExpiredInputCaptures = () => {
    const currentTime = now();
    for (const [captureRef, capture] of pendingInputCaptures) {
      if (capture.expiresAt <= currentTime) {
        pendingInputCaptures.delete(captureRef);
      }
    }
  };

  const captureInputFile = (
    file: File,
    captureRef?: string,
    source: NativeFileSelectionSource = "picker",
  ): NativeFileSelectionResult<NativeFileSelectionCapture> => {
    if (source !== "picker" && source !== "drop") {
      return invalidRequestFailure("source");
    }
    purgeExpiredInputCaptures();

    let capture: PendingInputCapture | undefined;
    if (captureRef !== undefined) {
      if (!INPUT_CAPTURE_REF_PATTERN.test(captureRef)) {
        return invalidRequestFailure("captureRef");
      }
      capture = pendingInputCaptures.get(captureRef);
      if (!capture) return authorizationExpiredFailure("captureRef");
      if (capture.source !== source) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure("source");
      }
      if (capture.files.length >= NATIVE_FILE_SELECTION_LIMITS.maxFiles) {
        pendingInputCaptures.delete(captureRef);
        return invalidRequestFailure("files");
      }
    }

    const fileIndex = capture?.files.length ?? 0;
    let filePath = "";
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return authorizationExpiredFailure(`files.${fileIndex}`);
    }
    if (
      typeof filePath !== "string" ||
      filePath.length === 0 ||
      filePath.length > NATIVE_FILE_SELECTION_LIMITS.maxPathChars
    ) {
      if (captureRef) pendingInputCaptures.delete(captureRef);
      return authorizationExpiredFailure(`files.${fileIndex}`);
    }
    if (capture?.files.some((candidate) => candidate.filePath === filePath)) {
      pendingInputCaptures.delete(captureRef!);
      return invalidRequestFailure("files");
    }

    const capturedFile = Object.freeze({ filePath });
    if (capture && captureRef) {
      const files = Object.freeze([...capture.files, capturedFile]);
      pendingInputCaptures.set(captureRef, {
        files,
        source: capture.source,
        expiresAt: capture.expiresAt,
      });
      return {
        ok: true,
        data: Object.freeze({ captureRef, fileCount: files.length }),
      };
    }

    while (pendingInputCaptures.size >= MAX_PENDING_INPUT_CAPTURES) {
      const oldestCaptureRef = pendingInputCaptures.keys().next().value;
      if (typeof oldestCaptureRef !== "string") break;
      pendingInputCaptures.delete(oldestCaptureRef);
    }

    let nonce = "";
    try {
      nonce = createCaptureNonce();
    } catch {
      return bridgeUnavailableFailure();
    }
    if (!INPUT_CAPTURE_NONCE_PATTERN.test(nonce)) {
      return bridgeUnavailableFailure();
    }
    const nextCaptureRef = `native_file_input_${nonce}`;
    if (pendingInputCaptures.has(nextCaptureRef)) {
      return bridgeUnavailableFailure();
    }
    pendingInputCaptures.set(nextCaptureRef, {
      files: Object.freeze([capturedFile]),
      source,
      expiresAt: now() + INPUT_CAPTURE_TTL_MS,
    });
    return {
      ok: true,
      data: Object.freeze({ captureRef: nextCaptureRef, fileCount: 1 }),
    };
  };

  return Object.freeze({
    bridgeVersion: NATIVE_FILE_SELECTION_BRIDGE_VERSION,
    captureInputFile,
    async resolveCapturedInputFiles(
      captureRef: string,
    ): Promise<
      NativeFileSelectionResult<readonly ResolvedNativeInputFile[]>
    > {
      if (
        typeof captureRef !== "string" ||
        !INPUT_CAPTURE_REF_PATTERN.test(captureRef)
      ) {
        return invalidRequestFailure("captureRef");
      }
      purgeExpiredInputCaptures();
      const capture = pendingInputCaptures.get(captureRef);
      pendingInputCaptures.delete(captureRef);
      if (!capture) return authorizationExpiredFailure("captureRef");

      let response: unknown;
      try {
        response = await ipcRenderer.invoke(
          NATIVE_FILE_SELECTION_INTERNAL_CHANNELS.resolveInputFiles,
          { source: capture.source, files: capture.files },
        );
      } catch {
        return bridgeUnavailableFailure();
      }
      const parsed = nativeFileSelectionResolveResultSchema.safeParse(response);
      return parsed.success
        ? parsed.data as NativeFileSelectionResult<readonly ResolvedNativeInputFile[]>
        : bridgeUnavailableFailure();
    },
  });
}

function invalidRequestFailure<T>(
  field?: string,
): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message: "The native file selection request is invalid.",
      ...(field ? { field } : {}),
    },
  };
}

function authorizationExpiredFailure<T>(
  field?: string,
): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: "authorization_expired",
      message: "The selected files are no longer available. Select them again.",
      ...(field ? { field } : {}),
    },
  };
}

function bridgeUnavailableFailure<T>(): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: "bridge_unavailable",
      message: "The native file selection bridge is unavailable or out of date.",
    },
  };
}

function defaultCaptureNonce(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
