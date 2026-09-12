import path from "node:path";
import { isPromise, isProxy } from "node:util/types";
import { LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION } from "./overwrite-native-resource";
import type {
  LocalSubtitleOverwriteTransactionBackend,
  LocalSubtitleOverwriteTransactionBackendReceipt,
  LocalSubtitleOverwriteTransactionRequest,
} from "./overwrite-transaction";
import type { LocalSubtitleOverwriteRecoveryRequest } from "./overwrite-recovery-owner";

export type LocalSubtitleOverwriteNativePlatform = "darwin" | "win32";
export type LocalSubtitleOverwriteNativeArchitecture = "arm64" | "x64";

export type LocalSubtitleOverwriteNativeBackendErrorCode =
  | "invalid_module_path"
  | "unsupported_target"
  | "module_load_failed"
  | "invalid_module"
  | "protocol_mismatch"
  | "target_mismatch"
  | "invalid_verification_proof"
  | "verified_artifact_changed"
  | "generation_conflict";

export class LocalSubtitleOverwriteNativeBackendError extends Error {
  readonly name = "LocalSubtitleOverwriteNativeBackendError";

  constructor(
    readonly code: LocalSubtitleOverwriteNativeBackendErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

interface LocalSubtitleOverwriteNativeRawModule {
  readonly protocolVersion: typeof LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION;
  readonly platform: LocalSubtitleOverwriteNativePlatform;
  readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
  readonly begin: (
    request: LocalSubtitleOverwriteTransactionRequest,
  ) => LocalSubtitleOverwriteTransactionBackendReceipt;
  readonly recover: (request: LocalSubtitleOverwriteRecoveryRequest) => unknown;
  readonly acknowledge: (request: LocalSubtitleOverwriteRecoveryRequest) => unknown;
}

interface ValidatedLocalSubtitleOverwriteNativeRawModule {
  readonly receiver: object;
  readonly begin: LocalSubtitleOverwriteNativeRawModule["begin"];
  readonly recover: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => unknown;
  readonly acknowledge: (
    request: LocalSubtitleOverwriteRecoveryRequest,
  ) => unknown;
}

export type LocalSubtitleOverwriteNativeModuleLoader = (
  absoluteNodePath: string,
) => unknown;

const RAW_MODULE_KEYS = Object.freeze([
  "protocolVersion",
  "platform",
  "architecture",
  "begin",
  "recover",
  "acknowledge",
] as const);

export function loadLocalSubtitleOverwriteNativeBackend(
  absoluteNodePath: string,
  loadModule: LocalSubtitleOverwriteNativeModuleLoader,
): {
  readonly transactions: LocalSubtitleOverwriteTransactionBackend;
  readonly recovery: {
    recover(request: LocalSubtitleOverwriteRecoveryRequest): unknown;
    acknowledge(request: LocalSubtitleOverwriteRecoveryRequest): unknown;
  };
} {
  assertAbsoluteNodePath(absoluteNodePath);
  const expectedTarget = resolveExpectedOverwriteNativeTarget(
    process.platform,
    process.arch,
  );

  let loaded: unknown;
  try {
    loaded = loadModule(absoluteNodePath);
  } catch (cause) {
    throw backendFailure(
      "module_load_failed",
      "The overwrite native module could not be loaded.",
      cause,
    );
  }

  const { begin, recover, acknowledge, receiver } = validateRawModule(
    loaded,
    expectedTarget,
  );
  return Object.freeze({
    transactions: Object.freeze({
      begin(request: LocalSubtitleOverwriteTransactionRequest) {
        return begin.call(receiver, request);
      },
    }),
    recovery: Object.freeze({
      recover(request: LocalSubtitleOverwriteRecoveryRequest) {
        return recover.call(receiver, request);
      },
      acknowledge(request: LocalSubtitleOverwriteRecoveryRequest) {
        return acknowledge.call(receiver, request);
      },
    }),
  });
}

export function resolveExpectedOverwriteNativeTarget(
  platform: NodeJS.Platform | string,
  architecture: string,
): {
  readonly platform: LocalSubtitleOverwriteNativePlatform;
  readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
} {
  if (
    (platform === "darwin" && architecture === "arm64") ||
    (platform === "win32" && architecture === "x64")
  ) {
    return { platform, architecture };
  }
  throw backendFailure(
    "unsupported_target",
    "The overwrite native module target is unsupported.",
  );
}

export function overwriteNativeBackendFailure(
  code: LocalSubtitleOverwriteNativeBackendErrorCode,
  message: string,
  cause?: unknown,
): LocalSubtitleOverwriteNativeBackendError {
  return new LocalSubtitleOverwriteNativeBackendError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertAbsoluteNodePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.extname(value) !== ".node"
  ) {
    throw backendFailure(
      "invalid_module_path",
      "A verified absolute .node path is required for the overwrite native module.",
    );
  }
}

function validateRawModule(
  input: unknown,
  expectedTarget: {
    readonly platform: LocalSubtitleOverwriteNativePlatform;
    readonly architecture: LocalSubtitleOverwriteNativeArchitecture;
  },
): ValidatedLocalSubtitleOverwriteNativeRawModule {
  if (isPromise(input)) {
    absorbPromise(input);
    throw backendFailure(
      "invalid_module",
      "The overwrite native module must load synchronously.",
    );
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw invalidModule();
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== RAW_MODULE_KEYS.length ||
    !RAW_MODULE_KEYS.every((key) => keys.includes(key))
  ) {
    throw invalidModule();
  }

  const protocolVersion = readDataExport(input, "protocolVersion");
  const platform = readDataExport(input, "platform");
  const architecture = readDataExport(input, "architecture");
  const begin = readDataExport(input, "begin");
  const recover = readDataExport(input, "recover");
  const acknowledge = readDataExport(input, "acknowledge");
  if (!Number.isSafeInteger(protocolVersion) || Number(protocolVersion) <= 0) {
    throw invalidModule();
  }
  if (protocolVersion !== LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION) {
    throw backendFailure(
      "protocol_mismatch",
      "The overwrite native module protocol is incompatible.",
    );
  }
  if (!isSupportedModuleTarget(platform, architecture)) {
    throw invalidModule();
  }
  if (
    platform !== expectedTarget.platform ||
    architecture !== expectedTarget.architecture
  ) {
    throw backendFailure(
      "target_mismatch",
      "The overwrite native module target does not match the current process target.",
    );
  }
  if (
    typeof begin !== "function" ||
    typeof recover !== "function" ||
    typeof acknowledge !== "function"
  ) {
    throw invalidModule();
  }
  return {
    receiver: input,
    begin: begin as LocalSubtitleOverwriteNativeRawModule["begin"],
    recover: recover as ValidatedLocalSubtitleOverwriteNativeRawModule["recover"],
    acknowledge: acknowledge as ValidatedLocalSubtitleOverwriteNativeRawModule["acknowledge"],
  };
}

function readDataExport(
  input: object,
  key: (typeof RAW_MODULE_KEYS)[number],
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor)) {
    throw invalidModule();
  }
  return descriptor.value;
}

function isSupportedModuleTarget(
  platform: unknown,
  architecture: unknown,
): platform is LocalSubtitleOverwriteNativePlatform {
  return (
    (platform === "darwin" && architecture === "arm64") ||
    (platform === "win32" && architecture === "x64")
  );
}

function absorbPromise(value: Promise<unknown>): void {
  void Promise.prototype.then.call(value, undefined, () => undefined);
}

function invalidModule(): LocalSubtitleOverwriteNativeBackendError {
  return backendFailure(
    "invalid_module",
    "The overwrite native module exports are invalid.",
  );
}

const backendFailure = overwriteNativeBackendFailure;
