import {
  LOCAL_SUBTITLE_DEVICE_PREFERENCES,
  type LocalSubtitleBackend,
  type LocalSubtitleDevicePreference,
  type LocalSubtitleErrorCode,
  type LocalSubtitleOperationStage,
} from "@/type/localSubtitle";
import {
  resolveVerifiedLocalSubtitleArtifact,
  selectLocalSubtitleCpuServerArtifactId,
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleResourceEnvironment,
  type LocalSubtitleVerifiedRuntimeArtifact,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import type { LocalSubtitleServerManagedResourceIdentity } from "./server-process-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERIFIED_BACKEND_RESOLUTION_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.verified-backend-resolution",
);
const VERIFIED_BACKEND_RESOLUTIONS = new WeakSet<object>();

export class LocalSubtitleBackendResolverError extends Error {
  readonly name = "LocalSubtitleBackendResolverError";

  constructor(
    readonly localSubtitleCode: Extract<
      LocalSubtitleErrorCode,
      "backend_unverified" | "media_runtime_invalid" | "runtime_protocol_mismatch"
    >,
    message: string,
    readonly stage: LocalSubtitleOperationStage = "preflight",
  ) {
    super(message);
  }
}

interface LocalSubtitleBackendRuntimeIdentity {
  readonly runtimeRoot: string;
  readonly runtimeGeneration: string;
  readonly target: LocalSubtitleVerifiedRuntimeBundle["target"];
  readonly serverArtifact: Readonly<{
    readonly id: string;
    readonly kind: "server";
    readonly backend: LocalSubtitleVerifiedRuntimeArtifact["backend"];
    readonly absolutePath: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly version: string;
    readonly signatureKind: LocalSubtitleVerifiedRuntimeArtifact["signatureKind"];
  }>;
}

export interface LocalSubtitleVerifiedBackendResolution
  extends LocalSubtitleBackendRuntimeIdentity {
  readonly [VERIFIED_BACKEND_RESOLUTION_BRAND]: true;
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly resolvedBackend: LocalSubtitleBackend;
  readonly model: Readonly<{
    readonly id: string;
    readonly sha256: string;
  }>;
}

export interface ResolveLocalSubtitleBackendOptions {
  readonly devicePreference: LocalSubtitleDevicePreference;
  readonly admittedRuntimeGeneration: string;
  readonly model: LocalSubtitleServerManagedResourceIdentity<"managed">;
  readonly signal?: AbortSignal;
}

export interface LocalSubtitleBackendResolverOptions {
  readonly runtimeEnvironment?: LocalSubtitleResourceEnvironment;
  readonly verifyServerRuntime?: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly selectCpuServerArtifact?: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;
}

export class LocalSubtitleBackendResolver {
  readonly #verifyServerRuntime: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly #selectCpuServerArtifact: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;

  constructor(options: LocalSubtitleBackendResolverOptions) {
    if (!options?.verifyServerRuntime && !options?.runtimeEnvironment) {
      throw new TypeError("A local subtitle server runtime verifier is required.");
    }
    if (
      options.selectCpuServerArtifact !== undefined &&
      typeof options.selectCpuServerArtifact !== "function"
    ) {
      throw new TypeError("The local subtitle backend artifact selector is invalid.");
    }
    this.#verifyServerRuntime = options.verifyServerRuntime ?? (() =>
      verifyLocalSubtitleRuntimeBundle({
        environment: options.runtimeEnvironment!,
        scope: "server",
      }));
    this.#selectCpuServerArtifact = options.selectCpuServerArtifact ??
      ((runtime) =>
        resolveVerifiedLocalSubtitleArtifact(
          runtime,
          selectLocalSubtitleCpuServerArtifactId(runtime),
        ));
  }

  async resolveBackend(
    options: ResolveLocalSubtitleBackendOptions,
  ): Promise<LocalSubtitleVerifiedBackendResolution> {
    assertResolutionRequest(options);
    throwIfAborted(options.signal);

    // GPU admission remains closed until production has an identity-bound,
    // deadline-bounded backend attestor. Explicit GPU requests never fall back.
    if (
      options.devicePreference === "cuda" ||
      options.devicePreference === "metal"
    ) {
      throw new LocalSubtitleBackendResolverError(
        "backend_unverified",
        "The selected local subtitle GPU backend does not have a production attestation path.",
      );
    }

    const runtime = await this.#verifyServerRuntime();
    throwIfAborted(options.signal);
    if (
      !runtime ||
      runtime.runtimeGeneration !== options.admittedRuntimeGeneration
    ) {
      throw new LocalSubtitleBackendResolverError(
        "media_runtime_invalid",
        "The local subtitle runtime changed during backend resolution.",
      );
    }
    const artifact = this.#selectCpuServerArtifact(runtime);
    assertCpuServerArtifact(artifact);

    const resolution = {
      devicePreference: options.devicePreference,
      resolvedBackend: "cpu" as const,
      model: Object.freeze({
        id: options.model.id,
        sha256: options.model.sha256,
      }),
      ...snapshotRuntimeIdentity(runtime, artifact),
    } as Omit<
      LocalSubtitleVerifiedBackendResolution,
      typeof VERIFIED_BACKEND_RESOLUTION_BRAND
    >;
    Object.defineProperty(resolution, VERIFIED_BACKEND_RESOLUTION_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const verified = Object.freeze(
      resolution,
    ) as LocalSubtitleVerifiedBackendResolution;
    VERIFIED_BACKEND_RESOLUTIONS.add(verified);
    return verified;
  }
}

export function isLocalSubtitleVerifiedBackendResolution(
  input: unknown,
): input is LocalSubtitleVerifiedBackendResolution {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    VERIFIED_BACKEND_RESOLUTIONS.has(input) &&
    (input as { readonly [VERIFIED_BACKEND_RESOLUTION_BRAND]?: unknown })[
      VERIFIED_BACKEND_RESOLUTION_BRAND
    ] === true
  );
}

export function matchesLocalSubtitleBackendResolutionRuntime(
  resolution: LocalSubtitleVerifiedBackendResolution,
  runtime: LocalSubtitleVerifiedRuntimeBundle,
): boolean {
  if (!isLocalSubtitleVerifiedBackendResolution(resolution)) return false;
  const artifact = runtime?.artifactPaths?.[resolution.serverArtifact.id];
  return (
    runtime.root === resolution.runtimeRoot &&
    runtime.runtimeGeneration === resolution.runtimeGeneration &&
    runtime.target.platform === resolution.target.platform &&
    runtime.target.arch === resolution.target.arch &&
    artifact?.kind === resolution.serverArtifact.kind &&
    artifact.backend === resolution.serverArtifact.backend &&
    artifact.absolutePath === resolution.serverArtifact.absolutePath &&
    artifact.byteSize === resolution.serverArtifact.byteSize &&
    artifact.sha256 === resolution.serverArtifact.sha256 &&
    artifact.version === resolution.serverArtifact.version &&
    artifact.signatureKind === resolution.serverArtifact.signatureKind
  );
}

function snapshotRuntimeIdentity(
  runtime: LocalSubtitleVerifiedRuntimeBundle,
  artifact: LocalSubtitleVerifiedRuntimeArtifact,
): LocalSubtitleBackendRuntimeIdentity {
  return Object.freeze({
    runtimeRoot: runtime.root,
    runtimeGeneration: runtime.runtimeGeneration,
    target: Object.freeze({ ...runtime.target }),
    serverArtifact: Object.freeze({
      id: artifact.id,
      kind: "server" as const,
      backend: artifact.backend,
      absolutePath: artifact.absolutePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      version: artifact.version,
      signatureKind: artifact.signatureKind,
    }),
  });
}

function assertResolutionRequest(
  options: ResolveLocalSubtitleBackendOptions,
): void {
  if (
    !options ||
    !LOCAL_SUBTITLE_DEVICE_PREFERENCES.includes(options.devicePreference) ||
    !SHA256_PATTERN.test(options.admittedRuntimeGeneration) ||
    options.model?.storage !== "managed" ||
    typeof options.model.id !== "string" ||
    !SHA256_PATTERN.test(options.model.sha256)
  ) {
    throw new TypeError("The local subtitle backend resolution request is invalid.");
  }
}

function assertCpuServerArtifact(
  artifact: LocalSubtitleVerifiedRuntimeArtifact,
): void {
  if (
    !artifact ||
    artifact.kind !== "server" ||
    (artifact.backend !== "cpu" && artifact.backend !== "metal_cpu") ||
    !SHA256_PATTERN.test(artifact.sha256) ||
    typeof artifact.absolutePath !== "string" ||
    artifact.absolutePath.length === 0
  ) {
    throw new LocalSubtitleBackendResolverError(
      "runtime_protocol_mismatch",
      "The verified runtime did not provide one CPU-capable server artifact.",
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
