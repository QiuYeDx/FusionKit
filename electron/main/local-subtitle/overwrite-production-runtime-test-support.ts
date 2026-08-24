import {
  initializeLocalSubtitleOverwriteProductionRuntimeWithDependencies,
  type LocalSubtitleOverwriteProductionRuntime,
  type LocalSubtitleOverwriteProductionRuntimeDependencies,
  type LocalSubtitleOverwriteProductionRuntimeOptions,
} from "./overwrite-production-runtime-core";

export type { LocalSubtitleOverwriteProductionRuntimeDependencies } from "./overwrite-production-runtime-core";

export function initializeLocalSubtitleOverwriteProductionRuntimeForTest<
  TReservation,
>(
  options: LocalSubtitleOverwriteProductionRuntimeOptions<TReservation>,
  dependencies: LocalSubtitleOverwriteProductionRuntimeDependencies<TReservation>,
): Promise<LocalSubtitleOverwriteProductionRuntime<TReservation>> {
  return initializeLocalSubtitleOverwriteProductionRuntimeWithDependencies(
    options,
    dependencies,
  );
}
