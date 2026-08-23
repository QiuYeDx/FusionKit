import { lstat } from "node:fs/promises";
import path from "node:path";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  NATIVE_FILE_SELECTION_INTERNAL_CHANNELS,
  nativeFileSelectionResolveRequestSchema,
  nativeFileSelectionResolveResultSchema,
  type NativeFileSelectionResult,
  type NativeFileSelectionSource,
  type ResolvedNativeInputFile,
} from "@/type/nativeFileSelectionIpc";
import { isTrustedAudioSender } from "../audio/audio-ipc-security";
import { LocalSubtitleAuthorizationError } from "../local-subtitle/authorizations";
import { resolveLocalSubtitleInputPaths } from "../local-subtitle/windows-explorer-drop-resolver";

export type NativeFileSelectionPathResolver = (
  paths: readonly string[],
  source: NativeFileSelectionSource,
) => Promise<readonly string[]>;

export interface NativeFileSelectionIpcServiceOptions {
  readonly resolveInputPaths?: NativeFileSelectionPathResolver;
}

export class NativeFileSelectionIpcService {
  private readonly resolveInputPathsImpl: NativeFileSelectionPathResolver;

  constructor(options: NativeFileSelectionIpcServiceOptions = {}) {
    this.resolveInputPathsImpl =
      options.resolveInputPaths ?? resolveLocalSubtitleInputPaths;
  }

  async resolveInputFiles(
    request: unknown,
  ): Promise<NativeFileSelectionResult<readonly ResolvedNativeInputFile[]>> {
    const parsed = nativeFileSelectionResolveRequestSchema.safeParse(request);
    if (!parsed.success) return invalidRequestFailure("files");

    try {
      const resolvedPaths = await this.resolveInputPathsImpl(
        parsed.data.files.map((file) => file.filePath),
        parsed.data.source,
      );
      if (resolvedPaths.length !== parsed.data.files.length) {
        return invalidRequestFailure("files");
      }

      const resolvedFiles = await Promise.all(resolvedPaths.map(async (filePath) => {
        if (
          !path.isAbsolute(filePath) ||
          filePath.includes("\0") ||
          path.basename(filePath) === "." ||
          path.basename(filePath) === ".."
        ) {
          throw new TypeError("Resolved native file path is invalid.");
        }
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new TypeError("Resolved native input is not a regular file.");
        }
        return Object.freeze({
          filePath,
          displayName: path.basename(filePath),
          sourceDirectory: path.dirname(filePath),
        });
      }));
      if (new Set(resolvedFiles.map((file) => pathIdentity(file.filePath))).size !==
          resolvedFiles.length) {
        return invalidRequestFailure("files");
      }

      const response = {
        ok: true as const,
        data: Object.freeze(resolvedFiles),
      };
      const validated = nativeFileSelectionResolveResultSchema.safeParse(response);
      return validated.success
        ? validated.data
        : bridgeUnavailableFailure();
    } catch (error) {
      if (error instanceof LocalSubtitleAuthorizationError) {
        return {
          ok: false,
          error: {
            code: "authorization_expired",
            message: error.message,
            ...(error.field ? { field: error.field } : {}),
          },
        };
      }
      return authorizationExpiredFailure("files");
    }
  }
}

export function setupNativeFileSelectionIPC(
  service = new NativeFileSelectionIpcService(),
): void {
  ipcMain.handle(
    NATIVE_FILE_SELECTION_INTERNAL_CHANNELS.resolveInputFiles,
    async (event: IpcMainInvokeEvent, request: unknown) => {
      if (!isTrustedAudioSender(event)) return invalidRequestFailure();
      return service.resolveInputFiles(request);
    },
  );
}

function invalidRequestFailure<T>(field?: string): NativeFileSelectionResult<T> {
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
      message: "The original selected files are unavailable. Select them again.",
      ...(field ? { field } : {}),
    },
  };
}

function bridgeUnavailableFailure<T>(): NativeFileSelectionResult<T> {
  return {
    ok: false,
    error: {
      code: "bridge_unavailable",
      message: "The native file selection bridge returned invalid content.",
    },
  };
}

function pathIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}
