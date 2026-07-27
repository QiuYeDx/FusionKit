import { createLocalSubtitleOverwriteNativeRuntime } from "./overwrite-native-backend";
import { verifyLocalSubtitleOverwriteNativeAddon } from "./overwrite-native-resource";
import {
  LocalSubtitleOverwriteRecoveryFileRepository,
  LocalSubtitleOverwriteRecoveryOwner,
} from "./overwrite-recovery-owner";
import {
  initializeLocalSubtitleOverwriteProductionRuntimeWithDependencies,
  type LocalSubtitleOverwriteProductionRuntime,
  type LocalSubtitleOverwriteProductionRuntimeOptions,
} from "./overwrite-production-runtime-core";

export type {
  LocalSubtitleOverwriteProductionRuntime,
  LocalSubtitleOverwriteProductionRuntimeOptions,
} from "./overwrite-production-runtime-core";

export function initializeLocalSubtitleOverwriteProductionRuntime<TReservation>(
  options: LocalSubtitleOverwriteProductionRuntimeOptions<TReservation>,
): Promise<LocalSubtitleOverwriteProductionRuntime<TReservation>> {
  return initializeLocalSubtitleOverwriteProductionRuntimeWithDependencies(
    options,
    {
      verifyNativeAddon: verifyLocalSubtitleOverwriteNativeAddon,
      createNativeRuntime: createLocalSubtitleOverwriteNativeRuntime,
      createRepository: (absolutePath) =>
        new LocalSubtitleOverwriteRecoveryFileRepository(absolutePath),
      createRecoveryOwner: (repository, artifacts, authority) =>
        new LocalSubtitleOverwriteRecoveryOwner(
          repository,
          artifacts,
          authority,
        ),
    },
  );
}
