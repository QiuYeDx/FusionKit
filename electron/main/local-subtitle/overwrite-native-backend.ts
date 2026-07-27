import { createRequire } from "node:module";
import {
  LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION as VERIFIED_NATIVE_PROTOCOL_VERSION,
  LocalSubtitleOverwriteNativeResourceError,
  assertLocalSubtitleVerifiedOverwriteNativeAddonCurrent,
  isLocalSubtitleVerifiedOverwriteNativeAddon,
  type LocalSubtitleVerifiedOverwriteNativeAddon,
} from "./overwrite-native-resource";
import {
  LocalSubtitleOverwriteNativeBackendError,
  loadLocalSubtitleOverwriteNativeBackend,
  overwriteNativeBackendFailure as failure,
  resolveExpectedOverwriteNativeTarget as resolveExpectedTarget,
  type LocalSubtitleOverwriteNativeArchitecture,
  type LocalSubtitleOverwriteNativeBackendErrorCode,
  type LocalSubtitleOverwriteNativePlatform,
} from "./overwrite-native-backend-core";
import {
  createLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionCoordinator,
} from "./overwrite-transaction";
import {
  createLocalSubtitleOverwriteRecoveryAuthority,
  type LocalSubtitleOverwriteRecoveryAuthority,
} from "./overwrite-recovery-owner";

export const LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION =
  VERIFIED_NATIVE_PROTOCOL_VERSION;

export { LocalSubtitleOverwriteNativeBackendError };
export type {
  LocalSubtitleOverwriteNativeArchitecture,
  LocalSubtitleOverwriteNativeBackendErrorCode,
  LocalSubtitleOverwriteNativePlatform,
};

export interface LocalSubtitleOverwriteNativeRuntime {
  readonly transactions: LocalSubtitleOverwriteTransactionCoordinator;
  readonly recovery: LocalSubtitleOverwriteRecoveryAuthority;
}

interface LoadedRuntimeRecord {
  readonly generation: string;
  readonly absoluteNodePath: string;
  readonly runtime: LocalSubtitleOverwriteNativeRuntime;
}

const LOADED_RUNTIMES = new Map<string, LoadedRuntimeRecord>();
const LOADED_PATH_GENERATIONS = new Map<string, string>();
const POISONED_GENERATIONS = new Set<string>();
const POISONED_PATHS = new Set<string>();
let activeGeneration: string | undefined;

export function createLocalSubtitleOverwriteNativeTransactionCoordinator(
  proof: LocalSubtitleVerifiedOverwriteNativeAddon,
): LocalSubtitleOverwriteTransactionCoordinator {
  return createLocalSubtitleOverwriteNativeRuntime(proof).transactions;
}

export function createLocalSubtitleOverwriteNativeRuntime(
  proof: LocalSubtitleVerifiedOverwriteNativeAddon,
): LocalSubtitleOverwriteNativeRuntime {
  if (!isLocalSubtitleVerifiedOverwriteNativeAddon(proof)) {
    throw failure(
      "invalid_verification_proof",
      "A verified overwrite native addon proof is required.",
    );
  }
  const expectedTarget = resolveExpectedTarget(process.platform, process.arch);
  if (
    proof.target.platform !== expectedTarget.platform ||
    proof.target.architecture !== expectedTarget.architecture ||
    proof.artifact.nativeProtocolVersion !==
      LOCAL_SUBTITLE_OVERWRITE_NATIVE_PROTOCOL_VERSION
  ) {
    throw failure(
      "target_mismatch",
      "The verified overwrite native addon target does not match the current process target.",
    );
  }
  assertVerifiedArtifactCurrent(proof);
  const generation = proof.addonGeneration;
  const absoluteNodePath = proof.artifact.absolutePath;
  if (
    POISONED_GENERATIONS.has(generation) ||
    POISONED_PATHS.has(absoluteNodePath)
  ) {
    throw failure(
      "module_load_failed",
      "The overwrite native addon generation is unavailable after a prior load failure.",
    );
  }
  const cached = LOADED_RUNTIMES.get(generation);
  if (cached) {
    if (cached.absoluteNodePath !== absoluteNodePath) {
      throw generationConflict();
    }
    return cached.runtime;
  }
  const pathGeneration = LOADED_PATH_GENERATIONS.get(absoluteNodePath);
  if (
    (pathGeneration !== undefined && pathGeneration !== generation) ||
    (activeGeneration !== undefined && activeGeneration !== generation)
  ) {
    throw generationConflict();
  }

  let backend: ReturnType<typeof loadLocalSubtitleOverwriteNativeBackend>;
  try {
    backend = loadLocalSubtitleOverwriteNativeBackend(
      absoluteNodePath,
      defaultLoadModule,
    );
    assertVerifiedArtifactCurrent(proof);
  } catch (error) {
    POISONED_GENERATIONS.add(generation);
    POISONED_PATHS.add(absoluteNodePath);
    throw error;
  }
  const runtime = Object.freeze({
    transactions: createLocalSubtitleOverwriteTransactionCoordinator(
      backend.transactions,
    ),
    recovery: createLocalSubtitleOverwriteRecoveryAuthority(backend.recovery),
  });
  const record = Object.freeze({ generation, absoluteNodePath, runtime });
  LOADED_RUNTIMES.set(generation, record);
  LOADED_PATH_GENERATIONS.set(absoluteNodePath, generation);
  activeGeneration = generation;
  return runtime;
}

function defaultLoadModule(absoluteNodePath: string): unknown {
  return createRequire(import.meta.url)(absoluteNodePath);
}

function assertVerifiedArtifactCurrent(
  proof: LocalSubtitleVerifiedOverwriteNativeAddon,
): void {
  try {
    assertLocalSubtitleVerifiedOverwriteNativeAddonCurrent(proof);
  } catch (cause) {
    if (cause instanceof LocalSubtitleOverwriteNativeBackendError) throw cause;
    throw failure(
      "verified_artifact_changed",
      "The verified overwrite native addon changed before it could be loaded.",
      cause instanceof LocalSubtitleOverwriteNativeResourceError ? cause : undefined,
    );
  }
}

function generationConflict(): LocalSubtitleOverwriteNativeBackendError {
  return failure(
    "generation_conflict",
    "A different overwrite native addon generation is already bound to this process.",
  );
}
