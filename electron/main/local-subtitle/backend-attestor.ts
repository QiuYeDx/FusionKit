import type { LocalSubtitleBackend } from "@/type/localSubtitle";
import {
  waitForLocalSubtitleMetalBackendEvidence,
  type LocalSubtitleServerBackendAttestation,
  type LocalSubtitleServerBackendAttestationContext,
  type LocalSubtitleServerSupervisorDependencies,
} from "./server-supervisor";

export const LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY = Object.freeze({
  metalEvidenceGraceMs: 1_000,
} as const);

export interface LocalSubtitleProductionBackendAttestor {
  readonly supportedBackends: readonly Exclude<LocalSubtitleBackend, "cpu">[];
  readonly verifyBackend: NonNullable<
    LocalSubtitleServerSupervisorDependencies["verifyBackend"]
  >;
}

export function createLocalSubtitleProductionBackendAttestor(options: {
  readonly platform?: NodeJS.Platform | string;
  readonly arch?: string;
  readonly metalEvidenceGraceMs?: number;
} = {}): LocalSubtitleProductionBackendAttestor {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const metalEvidenceGraceMs = options.metalEvidenceGraceMs ??
    LOCAL_SUBTITLE_PRODUCTION_BACKEND_ATTESTATION_POLICY.metalEvidenceGraceMs;
  if (
    !Number.isSafeInteger(metalEvidenceGraceMs) ||
    metalEvidenceGraceMs < 1 ||
    metalEvidenceGraceMs > 10_000
  ) {
    throw new TypeError("The Metal backend evidence grace period is invalid.");
  }
  const supportsMetal = platform === "darwin" && arch === "arm64";

  return Object.freeze({
    supportedBackends: Object.freeze(supportsMetal ? ["metal" as const] : []),
    verifyBackend: async (
      context: Readonly<LocalSubtitleServerBackendAttestationContext>,
    ) =>
      verifyProductionBackend(context, supportsMetal, metalEvidenceGraceMs),
  });
}

async function verifyProductionBackend(
  context: Readonly<LocalSubtitleServerBackendAttestationContext>,
  supportsMetal: boolean,
  metalEvidenceGraceMs: number,
): Promise<LocalSubtitleServerBackendAttestation> {
  if (!supportsMetal || context.backend !== "metal") {
    throw new Error("The selected GPU backend has no production attestor.");
  }
  await waitForLocalSubtitleMetalBackendEvidence(
    context.evidence,
    context,
    context.signal,
    metalEvidenceGraceMs,
  );
  if (context.signal.aborted) {
    throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  return Object.freeze({
    verified: true,
    processEpoch: context.processEpoch,
    processId: context.processId,
    backend: context.backend,
    runtimeGeneration: context.runtimeGeneration,
    serverArtifactId: context.serverArtifactId,
  });
}
