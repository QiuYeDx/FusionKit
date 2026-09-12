import path from "node:path";
import type { LocalSubtitleResourceEnvironment } from "./resource-path";
import type {
  LocalSubtitleMainRuntimeShutdownReason,
  LocalSubtitleMainRuntimeTarget,
} from "./main-runtime";
import {
  LocalSubtitleOverwriteNativeBackendError,
  type LocalSubtitleOverwriteNativeRuntime,
} from "./overwrite-native-backend";
import {
  LocalSubtitleOverwriteNativeResourceError,
  type LocalSubtitleVerifiedOverwriteNativeAddon,
} from "./overwrite-native-resource";
import {
  LocalSubtitleOverwriteRecoveryError,
  type LocalSubtitleOverwriteRecoveryAuthority,
  type LocalSubtitleOverwriteRecoveryRepository,
  type LocalSubtitleOverwriteRecoveryRegistry,
  type LocalSubtitleOverwriteRecoveryOwner,
  isLocalSubtitleOverwriteRecoveryOwner,
} from "./overwrite-recovery-owner";
import {
  isLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionCoordinator,
} from "./overwrite-transaction";

export const LOCAL_SUBTITLE_OVERWRITE_RECOVERY_REPOSITORY_RELATIVE_PATH =
  "recovery/overwrite-recovery.v2.json" as const;

export interface LocalSubtitleOverwriteProductionRuntimeOptions<TReservation> {
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly managedResourceRoot: string;
  readonly artifacts: LocalSubtitleOverwriteRecoveryRegistry<TReservation>;
}

export type LocalSubtitleOverwriteProductionRuntime<TReservation> =
  | Readonly<{
      status: "ready";
      addonGeneration: string;
      transactions: LocalSubtitleOverwriteTransactionCoordinator;
      recoveryOwner: LocalSubtitleOverwriteRecoveryOwner<TReservation>;
      lifecycleTarget: LocalSubtitleOverwriteRecoveryOwner<TReservation>;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "native_resource_unavailable";
      lifecycleTarget: LocalSubtitleMainRuntimeTarget;
    }>
  | Readonly<{
      status: "blocked";
      reason: "recovery_state_unavailable";
      lifecycleTarget: LocalSubtitleMainRuntimeTarget;
    }>;

export interface LocalSubtitleOverwriteProductionRuntimeDependencies<
  TReservation,
> {
  readonly verifyNativeAddon: (options: {
    readonly environment: LocalSubtitleResourceEnvironment;
  }) => Promise<LocalSubtitleVerifiedOverwriteNativeAddon>;
  readonly createNativeRuntime: (
    proof: LocalSubtitleVerifiedOverwriteNativeAddon,
  ) => LocalSubtitleOverwriteNativeRuntime;
  readonly createRepository: (
    absolutePath: string,
  ) => LocalSubtitleOverwriteRecoveryRepository;
  readonly createRecoveryOwner: (
    repository: LocalSubtitleOverwriteRecoveryRepository,
    artifacts: LocalSubtitleOverwriteRecoveryRegistry<TReservation>,
    authority: LocalSubtitleOverwriteRecoveryAuthority,
  ) => LocalSubtitleOverwriteRecoveryOwner<TReservation>;
}

export async function initializeLocalSubtitleOverwriteProductionRuntimeWithDependencies<
  TReservation,
>(
  options: LocalSubtitleOverwriteProductionRuntimeOptions<TReservation>,
  dependencies: LocalSubtitleOverwriteProductionRuntimeDependencies<TReservation>,
): Promise<LocalSubtitleOverwriteProductionRuntime<TReservation>> {
  assertOptions(options);
  assertDependencies(dependencies);

  let proof: LocalSubtitleVerifiedOverwriteNativeAddon;
  try {
    proof = await dependencies.verifyNativeAddon({
      environment: options.environment,
    });
  } catch (error) {
    if (error instanceof LocalSubtitleOverwriteNativeResourceError) {
      return unavailable();
    }
    throw error;
  }

  let nativeRuntime: LocalSubtitleOverwriteNativeRuntime;
  try {
    nativeRuntime = dependencies.createNativeRuntime(proof);
  } catch (error) {
    if (
      error instanceof LocalSubtitleOverwriteNativeBackendError ||
      error instanceof LocalSubtitleOverwriteNativeResourceError
    ) {
      return unavailable();
    }
    throw error;
  }
  if (
    !isLocalSubtitleOverwriteTransactionCoordinator(nativeRuntime.transactions)
  ) {
    throw new TypeError(
      "The verified overwrite native transaction coordinator is invalid.",
    );
  }

  const repositoryPath = path.join(
    options.managedResourceRoot,
    LOCAL_SUBTITLE_OVERWRITE_RECOVERY_REPOSITORY_RELATIVE_PATH,
  );
  let recoveryOwner: LocalSubtitleOverwriteRecoveryOwner<TReservation>;
  try {
    const repository = dependencies.createRepository(repositoryPath);
    recoveryOwner = dependencies.createRecoveryOwner(
      repository,
      options.artifacts,
      nativeRuntime.recovery,
    );
  } catch (error) {
    if (error instanceof LocalSubtitleOverwriteRecoveryError) {
      return blocked();
    }
    throw error;
  }
  if (!isLocalSubtitleOverwriteRecoveryOwner(recoveryOwner)) {
    throw new TypeError("The overwrite recovery owner is invalid.");
  }

  return Object.freeze({
    status: "ready" as const,
    addonGeneration: proof.addonGeneration,
    transactions: nativeRuntime.transactions,
    recoveryOwner,
    lifecycleTarget: recoveryOwner,
  });
}

function assertOptions<TReservation>(
  options: LocalSubtitleOverwriteProductionRuntimeOptions<TReservation>,
): void {
  if (
    !options ||
    typeof options !== "object" ||
    !options.environment ||
    typeof options.managedResourceRoot !== "string" ||
    !path.isAbsolute(options.managedResourceRoot) ||
    options.managedResourceRoot.includes("\0") ||
    !options.artifacts
  ) {
    throw new TypeError(
      "The overwrite production runtime options are invalid.",
    );
  }
}

function assertDependencies<TReservation>(
  dependencies: LocalSubtitleOverwriteProductionRuntimeDependencies<TReservation>,
): void {
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    typeof dependencies.verifyNativeAddon !== "function" ||
    typeof dependencies.createNativeRuntime !== "function" ||
    typeof dependencies.createRepository !== "function" ||
    typeof dependencies.createRecoveryOwner !== "function"
  ) {
    throw new TypeError(
      "The overwrite production runtime dependencies are invalid.",
    );
  }
}

function unavailable(): LocalSubtitleOverwriteProductionRuntime<never> {
  return Object.freeze({
    status: "unavailable",
    reason: "native_resource_unavailable",
    lifecycleTarget: createUnavailableLifecycleTarget(),
  });
}

function blocked(): LocalSubtitleOverwriteProductionRuntime<never> {
  return Object.freeze({
    status: "blocked",
    reason: "recovery_state_unavailable",
    lifecycleTarget: createUnavailableLifecycleTarget(),
  });
}

function createUnavailableLifecycleTarget(): LocalSubtitleMainRuntimeTarget {
  return Object.freeze({
    releaseOwner: () => undefined,
    shutdown: (reason: LocalSubtitleMainRuntimeShutdownReason) =>
      reason === "update"
        ? Promise.reject(
            new LocalSubtitleOverwriteRecoveryError(
              "recovery_pending",
              "The overwrite recovery runtime is unavailable during update.",
            ),
          )
        : Promise.resolve(),
  });
}
