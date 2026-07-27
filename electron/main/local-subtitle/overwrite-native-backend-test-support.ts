import {
  loadLocalSubtitleOverwriteNativeBackend,
  type LocalSubtitleOverwriteNativeModuleLoader,
} from "./overwrite-native-backend-core";
import type { LocalSubtitleOverwriteNativeRuntime } from "./overwrite-native-backend";
import {
  createLocalSubtitleOverwriteTransactionCoordinator,
  type LocalSubtitleOverwriteTransactionCoordinator,
} from "./overwrite-transaction";
import { createLocalSubtitleOverwriteRecoveryAuthority } from "./overwrite-recovery-owner";

export function createLocalSubtitleOverwriteNativeRuntimeForTest(
  absoluteNodePath: string,
  loadModule: LocalSubtitleOverwriteNativeModuleLoader,
): LocalSubtitleOverwriteNativeRuntime {
  assertTestModuleLoader(loadModule);
  const backend = loadLocalSubtitleOverwriteNativeBackend(
    absoluteNodePath,
    loadModule,
  );
  return Object.freeze({
    transactions: createLocalSubtitleOverwriteTransactionCoordinator(
      backend.transactions,
    ),
    recovery: createLocalSubtitleOverwriteRecoveryAuthority(backend.recovery),
  });
}

export function createLocalSubtitleOverwriteNativeTransactionCoordinatorForTest(
  absoluteNodePath: string,
  loadModule: LocalSubtitleOverwriteNativeModuleLoader,
): LocalSubtitleOverwriteTransactionCoordinator {
  return createLocalSubtitleOverwriteNativeRuntimeForTest(
    absoluteNodePath,
    loadModule,
  ).transactions;
}

function assertTestModuleLoader(
  value: unknown,
): asserts value is LocalSubtitleOverwriteNativeModuleLoader {
  if (typeof value !== "function") {
    throw new TypeError("A test-only overwrite native module loader is required.");
  }
}
