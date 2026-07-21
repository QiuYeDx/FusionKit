import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import path from "node:path";

const MAX_ABSOLUTE_PATH_CHARS = 32_768;
const MAX_ARGUMENT_CHARS = 32_768;
const MAX_ARGUMENT_COUNT = 4_096;

export const LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY = Object.freeze({
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 12 * 60 * 60 * 1_000,
  terminateGraceMs: 2_000,
  forceKillGraceMs: 2_000,
  maxGraceMs: 60_000,
  stdoutMaxBytes: 1024 * 1024,
  stderrMaxBytes: 64 * 1024,
  maxConfigurableOutputBytes: 64 * 1024 * 1024,
} as const);

export type LocalSubtitleMediaProcessRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LocalSubtitleMediaProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly terminateGraceMs?: number;
  readonly forceKillGraceMs?: number;
  readonly stdoutMaxBytes?: number;
  readonly stderrMaxBytes?: number;
  readonly stdoutMode?: "capture" | "stream";
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly runner?: LocalSubtitleMediaProcessRunner;
}

interface LocalSubtitleMediaProcessResultBase {
  readonly status: "closed" | "spawn_error" | "close_unconfirmed";
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
  readonly closeConfirmed: Promise<void>;
  readonly spawnErrorCode?: string;
  readonly stdioErrorCode?: string;
}

export type LocalSubtitleMediaProcessResult =
  LocalSubtitleMediaProcessResultBase;

export interface BuildLocalSubtitleMediaEnvironmentOptions {
  readonly platform: "darwin" | "win32";
  readonly mediaDirectory: string;
  readonly tempDirectory: string;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
}

export function buildLocalSubtitleMediaEnvironment(
  options: BuildLocalSubtitleMediaEnvironmentOptions,
): Readonly<Record<string, string>> {
  assertAbsoluteNormalizedPath(options.mediaDirectory);
  assertAbsoluteNormalizedPath(options.tempDirectory);

  const source = options.sourceEnvironment ?? process.env;
  const environment: Record<string, string> = {
    PATH: options.mediaDirectory,
    LANG: "C",
    LC_ALL: "C",
    TEMP: options.tempDirectory,
    TMP: options.tempDirectory,
  };

  if (options.platform === "darwin") {
    environment.TMPDIR = options.tempDirectory;
    return Object.freeze(environment);
  }

  environment.PATHEXT = ".COM;.EXE";
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "ProgramFiles",
    "ProgramW6432",
  ] as const) {
    const value = source[key];
    if (isSafeAbsoluteEnvironmentPath(value)) environment[key] = value;
  }
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (systemRoot) {
    environment.PATH = [
      options.mediaDirectory,
      path.join(systemRoot, "System32"),
    ].join(";");
  }
  return Object.freeze(environment);
}

export async function runLocalSubtitleMediaProcess(
  request: LocalSubtitleMediaProcessRequest,
): Promise<LocalSubtitleMediaProcessResult> {
  const normalized = normalizeRequest(request);
  if (request.signal?.aborted) {
    return createResult({
      status: "closed",
      spawned: false,
      exitCode: null,
      signalCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      aborted: true,
      timedOut: false,
      outputExceeded: false,
      closeConfirmed: Promise.resolve(),
    });
  }

  let child: ChildProcess;
  try {
    child = normalized.runner(
      normalized.command,
      normalized.args,
      {
        cwd: normalized.cwd,
        env: { ...normalized.env } as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return createResult({
      status: "spawn_error",
      spawned: false,
      exitCode: null,
      signalCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      aborted: false,
      timedOut: false,
      outputExceeded: false,
      closeConfirmed: Promise.resolve(),
      spawnErrorCode: safeErrorCode(error),
    });
  }

  return new Promise<LocalSubtitleMediaProcessResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let spawned = hasProcessId(child);
    let aborted = false;
    let timedOut = false;
    let outputExceeded = false;
    let spawnErrorCode: string | undefined;
    let stdioErrorCode: string | undefined;
    let stopRequested = false;
    let terminateSent = false;
    let forceKillSent = false;
    let operationTimer: NodeJS.Timeout | undefined;
    let spawnWaitTimer: NodeJS.Timeout | undefined;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let confirmClose!: () => void;
    const closeConfirmed = new Promise<void>((resolveClose) => {
      confirmClose = resolveClose;
    });

    const cleanup = () => {
      if (operationTimer) clearTimeout(operationTimer);
      if (spawnWaitTimer) clearTimeout(spawnWaitTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdoutData);
      child.stdout?.removeListener("error", onStdoutError);
      child.stderr?.removeListener("data", onStderrData);
      child.stderr?.removeListener("error", onStderrError);
    };

    const observeLateClose = () => {
      const removeLateListeners = () => {
        child.removeListener("spawn", onLateSpawn);
        child.removeListener("error", onLateError);
        child.removeListener("close", onLateClose);
        child.stdout?.removeListener("error", onLateStreamError);
        child.stderr?.removeListener("error", onLateStreamError);
      };
      const onLateSpawn = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error observer remains authoritative.
        }
      };
      const onLateError = () => undefined;
      const onLateClose = () => {
        removeLateListeners();
        confirmClose();
      };
      const onLateStreamError = () => undefined;

      if (!spawned && !hasProcessId(child)) child.once("spawn", onLateSpawn);
      child.on("error", onLateError);
      child.once("close", onLateClose);
      child.stdout?.on("error", onLateStreamError);
      child.stderr?.on("error", onLateStreamError);
      child.stdout?.resume();
      child.stderr?.resume();
    };

    const finish = (
      status: LocalSubtitleMediaProcessResult["status"],
      exitCode: number | null,
      signalCode: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      if (status === "close_unconfirmed" || status === "spawn_error") {
        observeLateClose();
      }
      cleanup();
      resolve(createResult({
        status,
        spawned,
        exitCode,
        signalCode,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        aborted,
        timedOut,
        outputExceeded,
        closeConfirmed,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
        ...(stdioErrorCode ? { stdioErrorCode } : {}),
      }));
    };

    const sendTerminate = () => {
      if (settled || terminateSent) return;
      terminateSent = true;
      try {
        child.kill("SIGTERM");
      } catch (error) {
        stdioErrorCode ??= safeErrorCode(error, "TERMINATE_FAILED");
      }
      terminateTimer = setTimeout(() => {
        if (settled || forceKillSent) return;
        forceKillSent = true;
        try {
          child.kill("SIGKILL");
        } catch (error) {
          stdioErrorCode ??= safeErrorCode(error, "FORCE_KILL_FAILED");
        }
        forceKillTimer = setTimeout(
          () => finish("close_unconfirmed", null, null),
          normalized.forceKillGraceMs,
        );
        forceKillTimer.unref?.();
      }, normalized.terminateGraceMs);
      terminateTimer.unref?.();
    };

    const requestStop = () => {
      if (settled) return;
      stopRequested = true;
      if (operationTimer) {
        clearTimeout(operationTimer);
        operationTimer = undefined;
      }
      if (spawned || hasProcessId(child)) {
        sendTerminate();
      } else if (!spawnWaitTimer) {
        spawnWaitTimer = setTimeout(
          () => finish("close_unconfirmed", null, null),
          normalized.terminateGraceMs + normalized.forceKillGraceMs,
        );
        spawnWaitTimer.unref?.();
      }
    };

    function onSpawn() {
      spawned = true;
      if (spawnWaitTimer) {
        clearTimeout(spawnWaitTimer);
        spawnWaitTimer = undefined;
      }
      if (stopRequested) sendTerminate();
    }

    function onChildError(error: Error) {
      const code = safeErrorCode(error);
      if (!spawned && !hasProcessId(child)) {
        spawnErrorCode = code;
        finish("spawn_error", null, null);
        return;
      }
      stdioErrorCode ??= code;
      requestStop();
    }

    function onClose(
      exitCode: number | null,
      signalCode: NodeJS.Signals | null,
    ) {
      confirmClose();
      finish(
        spawnErrorCode && !spawned ? "spawn_error" : "closed",
        Number.isInteger(exitCode) ? exitCode : null,
        signalCode ?? null,
      );
    }

    function onStdoutData(chunk: unknown) {
      if (normalized.stdoutMode === "stream") {
        const streamed = Buffer.from(toBuffer(chunk));
        if (streamed.byteLength > 0 && normalized.onStdoutChunk) {
          try {
            normalized.onStdoutChunk(Uint8Array.from(streamed));
          } catch {
            stdioErrorCode ??= "STDOUT_CALLBACK_FAILED";
            requestStop();
          }
        }
        return;
      }
      const retained = retainChunk(
        chunk,
        stdoutChunks,
        stdoutBytes,
        normalized.stdoutMaxBytes,
      );
      stdoutBytes += retained.buffer.byteLength;
      if (retained.buffer.byteLength > 0 && normalized.onStdoutChunk) {
        try {
          normalized.onStdoutChunk(Uint8Array.from(retained.buffer));
        } catch {
          stdioErrorCode ??= "STDOUT_CALLBACK_FAILED";
          requestStop();
        }
      }
      if (retained.truncated) {
        outputExceeded = true;
        requestStop();
      }
    }

    function onStderrData(chunk: unknown) {
      const retained = retainChunk(
        chunk,
        stderrChunks,
        stderrBytes,
        normalized.stderrMaxBytes,
      );
      stderrBytes += retained.buffer.byteLength;
      if (retained.truncated) {
        outputExceeded = true;
        requestStop();
      }
    }

    function onStdoutError(error: Error) {
      stdioErrorCode ??= safeErrorCode(error, "STDOUT_PIPE_FAILED");
      requestStop();
    }

    function onStderrError(error: Error) {
      stdioErrorCode ??= safeErrorCode(error, "STDERR_PIPE_FAILED");
      requestStop();
    }

    function onAbort() {
      aborted = true;
      requestStop();
    }

    child.once("spawn", onSpawn);
    child.once("error", onChildError);
    child.once("close", onClose);
    child.stdout?.on("data", onStdoutData);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderrData);
    child.stderr?.on("error", onStderrError);
    request.signal?.addEventListener("abort", onAbort, { once: true });

    operationTimer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, normalized.timeoutMs);
    operationTimer.unref?.();

    if (request.signal?.aborted) onAbort();
  });
}

interface NormalizedRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly terminateGraceMs: number;
  readonly forceKillGraceMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly stdoutMode: "capture" | "stream";
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly runner: LocalSubtitleMediaProcessRunner;
}

function normalizeRequest(
  request: LocalSubtitleMediaProcessRequest,
): NormalizedRequest {
  assertAbsoluteNormalizedPath(request.command);
  assertAbsoluteNormalizedPath(request.cwd);
  if (
    request.stdoutMode !== undefined &&
    request.stdoutMode !== "capture" &&
    request.stdoutMode !== "stream"
  ) {
    throw new TypeError("The native media stdout mode is invalid.");
  }
  if (
    !Array.isArray(request.args) ||
    request.args.length > MAX_ARGUMENT_COUNT ||
    request.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > MAX_ARGUMENT_CHARS ||
        argument.includes("\0"),
    )
  ) {
    throw new TypeError("The native media process arguments are invalid.");
  }
  if (!isPlainRecord(request.env)) {
    throw new TypeError("The native media process environment is invalid.");
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      (value !== undefined &&
        (typeof value !== "string" || value.includes("\0")))
    ) {
      throw new TypeError("The native media process environment is invalid.");
    }
    if (value !== undefined) environment[key] = value;
  }
  if (
    request.onStdoutChunk !== undefined &&
    typeof request.onStdoutChunk !== "function"
  ) {
    throw new TypeError("The native media stdout callback is invalid.");
  }
  if (request.runner !== undefined && typeof request.runner !== "function") {
    throw new TypeError("The native media process runner is invalid.");
  }

  return {
    command: request.command,
    args: Object.freeze([...request.args]),
    cwd: request.cwd,
    env: Object.freeze(environment),
    timeoutMs: boundedPositiveInteger(
      request.timeoutMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.defaultTimeoutMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.maxTimeoutMs,
    ),
    terminateGraceMs: boundedPositiveInteger(
      request.terminateGraceMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.terminateGraceMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.maxGraceMs,
    ),
    forceKillGraceMs: boundedPositiveInteger(
      request.forceKillGraceMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.forceKillGraceMs,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.maxGraceMs,
    ),
    stdoutMaxBytes: boundedNonNegativeInteger(
      request.stdoutMaxBytes,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.stdoutMaxBytes,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.maxConfigurableOutputBytes,
    ),
    stderrMaxBytes: boundedNonNegativeInteger(
      request.stderrMaxBytes,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.stderrMaxBytes,
      LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.maxConfigurableOutputBytes,
    ),
    stdoutMode: request.stdoutMode ?? "capture",
    ...(request.onStdoutChunk
      ? { onStdoutChunk: request.onStdoutChunk }
      : {}),
    runner: request.runner ?? defaultRunner,
  };
}

interface RetainedChunk {
  readonly buffer: Buffer;
  readonly truncated: boolean;
}

function retainChunk(
  value: unknown,
  chunks: Buffer[],
  retainedBytes: number,
  maxBytes: number,
): RetainedChunk {
  const source = toBuffer(value);
  const remaining = Math.max(0, maxBytes - retainedBytes);
  const retained = Buffer.from(source.subarray(0, remaining));
  if (retained.byteLength > 0) chunks.push(retained);
  return {
    buffer: retained,
    truncated: source.byteLength > remaining,
  };
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.alloc(0);
}

function createResult(
  result: LocalSubtitleMediaProcessResultBase,
): LocalSubtitleMediaProcessResult {
  return Object.freeze(result);
}

function defaultRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

function hasProcessId(child: ChildProcess): boolean {
  return Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0;
}

function assertAbsoluteNormalizedPath(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ABSOLUTE_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new TypeError("A native media process path is invalid.");
  }
}

function isSafeAbsoluteEnvironmentPath(
  value: string | undefined,
): value is string {
  if (typeof value !== "string") return false;
  try {
    assertAbsoluteNormalizedPath(value);
    return true;
  } catch {
    return false;
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError("A native media process duration is invalid.");
  }
  return resolved;
}

function boundedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new TypeError("A native media process byte limit is invalid.");
  }
  return resolved;
}

function safeErrorCode(error: unknown, fallback = "UNKNOWN"): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : fallback;
  return /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : fallback;
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
