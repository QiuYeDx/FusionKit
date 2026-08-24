import {
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  LOCAL_SUBTITLE_DEVICE_PREFERENCES,
  type LocalSubtitleBackend,
  type LocalSubtitleDevicePreference,
  type LocalSubtitleErrorCode,
  type LocalSubtitleOperationStage,
} from "@/type/localSubtitle";
import {
  isLocalSubtitleVerifiedAcceleratorPack,
  matchesLocalSubtitleVerifiedAcceleratorPack,
  type LocalSubtitleVerifiedAcceleratorPack,
  type LocalSubtitleVerifiedAcceleratorPackArtifact,
} from "./accelerator-manager";
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
  readonly acceleratorPack?: LocalSubtitleVerifiedAcceleratorPack;
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
  readonly metalAttestationAvailable?: boolean;
  readonly cudaAttestationAvailable?: boolean;
  readonly resolveCudaAccelerator?: (
    signal?: AbortSignal,
  ) => Promise<LocalSubtitleVerifiedAcceleratorPack>;
  readonly selectCpuServerArtifact?: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;
  readonly selectMetalServerArtifact?: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;
}

export class LocalSubtitleBackendResolver {
  readonly #verifyServerRuntime: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly #selectCpuServerArtifact: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;
  readonly #selectMetalServerArtifact: (
    runtime: LocalSubtitleVerifiedRuntimeBundle,
  ) => LocalSubtitleVerifiedRuntimeArtifact;
  readonly #metalAttestationAvailable: boolean;
  readonly #cudaAttestationAvailable: boolean;
  readonly #resolveCudaAccelerator:
    | ((signal?: AbortSignal) => Promise<LocalSubtitleVerifiedAcceleratorPack>)
    | undefined;

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
    if (
      options.selectMetalServerArtifact !== undefined &&
      typeof options.selectMetalServerArtifact !== "function"
    ) {
      throw new TypeError("The local subtitle Metal artifact selector is invalid.");
    }
    if (
      options.metalAttestationAvailable !== undefined &&
      typeof options.metalAttestationAvailable !== "boolean"
    ) {
      throw new TypeError("The local subtitle Metal attestation capability is invalid.");
    }
    if (
      options.cudaAttestationAvailable !== undefined &&
      typeof options.cudaAttestationAvailable !== "boolean"
    ) {
      throw new TypeError("The local subtitle CUDA attestation capability is invalid.");
    }
    if (
      options.resolveCudaAccelerator !== undefined &&
      typeof options.resolveCudaAccelerator !== "function"
    ) {
      throw new TypeError("The local subtitle CUDA accelerator resolver is invalid.");
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
    this.#selectMetalServerArtifact = options.selectMetalServerArtifact ??
      this.#selectCpuServerArtifact;
    this.#metalAttestationAvailable = options.metalAttestationAvailable === true;
    this.#cudaAttestationAvailable = options.cudaAttestationAvailable === true;
    this.#resolveCudaAccelerator = options.resolveCudaAccelerator;
  }

  async resolveBackend(
    options: ResolveLocalSubtitleBackendOptions,
  ): Promise<LocalSubtitleVerifiedBackendResolution> {
    assertResolutionRequest(options);
    throwIfAborted(options.signal);

    if (
      options.devicePreference === "cuda" &&
      (!this.#cudaAttestationAvailable || !this.#resolveCudaAccelerator)
    ) {
      throw new LocalSubtitleBackendResolverError(
        "backend_unverified",
        "The selected local subtitle GPU backend does not have a production attestation path.",
      );
    }
    if (
      options.devicePreference === "metal" &&
      !this.#metalAttestationAvailable
    ) {
      throw new LocalSubtitleBackendResolverError(
        "backend_unverified",
        "The selected local subtitle Metal backend does not have a production attestation path.",
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
    const metalAdmitted =
      this.#metalAttestationAvailable &&
      runtime.target.platform === "darwin" &&
      runtime.target.arch === "arm64";
    const cudaTargetAdmitted =
      this.#cudaAttestationAvailable &&
      this.#resolveCudaAccelerator !== undefined &&
      runtime.target.platform === "win32" &&
      runtime.target.arch === "x64";
    if (options.devicePreference === "metal" && !metalAdmitted) {
      throw new LocalSubtitleBackendResolverError(
        "backend_unverified",
        "The selected local subtitle Metal backend does not have a production attestation path.",
      );
    }
    if (options.devicePreference === "cuda" && !cudaTargetAdmitted) {
      throw new LocalSubtitleBackendResolverError(
        "backend_unverified",
        "The selected local subtitle CUDA backend is not available on this target.",
      );
    }
    let acceleratorPack: LocalSubtitleVerifiedAcceleratorPack | undefined;
    if (
      cudaTargetAdmitted &&
      options.devicePreference !== "cpu" &&
      options.devicePreference !== "metal"
    ) {
      try {
        acceleratorPack = await this.#resolveCudaAccelerator!(options.signal);
        throwIfAborted(options.signal);
        assertCudaAcceleratorPack(acceleratorPack);
      } catch (error) {
        throwIfAborted(options.signal);
        if (options.devicePreference === "cuda") {
          throw new LocalSubtitleBackendResolverError(
            "backend_unverified",
            "The selected local subtitle CUDA accelerator did not pass production verification.",
          );
        }
        acceleratorPack = undefined;
      }
    }
    const resolvedBackend = acceleratorPack
      ? "cuda" as const
      : options.devicePreference !== "cpu" && metalAdmitted
        ? "metal" as const
        : "cpu" as const;
    const runtimeArtifact = resolvedBackend === "metal"
      ? this.#selectMetalServerArtifact(runtime)
      : this.#selectCpuServerArtifact(runtime);
    if (resolvedBackend === "metal") {
      assertMetalServerArtifact(runtime, runtimeArtifact);
    } else {
      assertCpuServerArtifact(runtimeArtifact);
    }
    const runtimeServerArtifact = runtimeArtifact as
      LocalSubtitleVerifiedRuntimeArtifact & { readonly kind: "server" };
    const artifact = acceleratorPack
      ? acceleratorServerArtifact(acceleratorPack)
      : runtimeServerArtifact;

    const resolution = {
      devicePreference: options.devicePreference,
      resolvedBackend,
      model: Object.freeze({
        id: options.model.id,
        sha256: options.model.sha256,
      }),
      ...snapshotRuntimeIdentity(runtime, artifact),
      ...(acceleratorPack === undefined ? {} : { acceleratorPack }),
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
  const runtimeMatches =
    runtime.root === resolution.runtimeRoot &&
    runtime.runtimeGeneration === resolution.runtimeGeneration &&
    runtime.target.platform === resolution.target.platform &&
    runtime.target.arch === resolution.target.arch;
  if (!runtimeMatches) return false;
  if (resolution.resolvedBackend === "cuda") {
    const pack = resolution.acceleratorPack;
    const artifact = pack?.artifacts.find(
      (candidate): candidate is LocalSubtitleVerifiedAcceleratorPackArtifact & {
        readonly kind: "server";
      } => candidate.id === resolution.serverArtifact.id &&
        candidate.kind === "server",
    );
    return isLocalSubtitleVerifiedAcceleratorPack(pack) &&
      artifact !== undefined &&
      sameServerArtifact(resolution.serverArtifact, {
        ...artifact,
        backend: "cuda",
        version: pack.serverVersion,
        signatureKind: pack.signatureKind,
      });
  }
  if (resolution.acceleratorPack !== undefined) return false;
  const artifact = runtime?.artifactPaths?.[resolution.serverArtifact.id];
  return (
    artifact?.kind === resolution.serverArtifact.kind &&
    artifact.backend === resolution.serverArtifact.backend &&
    artifact.absolutePath === resolution.serverArtifact.absolutePath &&
    artifact.byteSize === resolution.serverArtifact.byteSize &&
    artifact.sha256 === resolution.serverArtifact.sha256 &&
    artifact.version === resolution.serverArtifact.version &&
    artifact.signatureKind === resolution.serverArtifact.signatureKind
  );
}

export function matchesLocalSubtitleBackendResolutionAccelerator(
  resolution: LocalSubtitleVerifiedBackendResolution,
  acceleratorPack: LocalSubtitleVerifiedAcceleratorPack,
): boolean {
  return isLocalSubtitleVerifiedBackendResolution(resolution) &&
    resolution.resolvedBackend === "cuda" &&
    resolution.acceleratorPack !== undefined &&
    matchesLocalSubtitleVerifiedAcceleratorPack(
      resolution.acceleratorPack,
      acceleratorPack,
    );
}

function snapshotRuntimeIdentity(
  runtime: LocalSubtitleVerifiedRuntimeBundle,
  artifact: Readonly<{
    readonly id: string;
    readonly kind: "server";
    readonly backend: LocalSubtitleVerifiedRuntimeArtifact["backend"];
    readonly absolutePath: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly version: string;
    readonly signatureKind: LocalSubtitleVerifiedRuntimeArtifact["signatureKind"];
  }>,
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

function assertCudaAcceleratorPack(
  pack: LocalSubtitleVerifiedAcceleratorPack,
): void {
  const server = Array.isArray(pack?.artifacts)
    ? pack.artifacts.filter((artifact) => artifact.kind === "server")
    : [];
  if (
    !isLocalSubtitleVerifiedAcceleratorPack(pack) ||
    pack.target.platform !== "win32" ||
    pack.target.arch !== "x64" ||
    pack.target.backend !== "cuda" ||
    pack.engine.version !== LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.version ||
    pack.engine.commit !== LOCAL_SUBTITLE_PRODUCTION_CONTRACT.engine.commit ||
    server.length !== 1 ||
    server[0]?.id !== pack.serverArtifactId ||
    server[0].kind !== "server" ||
    !SHA256_PATTERN.test(server[0].sha256)
  ) {
    throw new LocalSubtitleBackendResolverError(
      "backend_unverified",
      "The managed CUDA accelerator proof is invalid.",
    );
  }
}

function acceleratorServerArtifact(
  pack: LocalSubtitleVerifiedAcceleratorPack,
): Readonly<{
  readonly id: string;
  readonly kind: "server";
  readonly backend: "cuda";
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly version: string;
  readonly signatureKind: "unsigned";
}> {
  const artifact = pack.artifacts.find(
    (candidate): candidate is LocalSubtitleVerifiedAcceleratorPackArtifact & {
      readonly kind: "server";
    } => candidate.id === pack.serverArtifactId && candidate.kind === "server",
  );
  if (!artifact) {
    throw new LocalSubtitleBackendResolverError(
      "backend_unverified",
      "The managed CUDA accelerator server proof is invalid.",
    );
  }
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    backend: "cuda" as const,
    absolutePath: artifact.absolutePath,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    version: pack.serverVersion,
    signatureKind: pack.signatureKind,
  });
}

function sameServerArtifact(
  left: LocalSubtitleBackendRuntimeIdentity["serverArtifact"],
  right: LocalSubtitleBackendRuntimeIdentity["serverArtifact"],
): boolean {
  return left.id === right.id &&
    left.kind === right.kind &&
    left.backend === right.backend &&
    left.absolutePath === right.absolutePath &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    left.version === right.version &&
    left.signatureKind === right.signatureKind;
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

function assertMetalServerArtifact(
  runtime: LocalSubtitleVerifiedRuntimeBundle,
  artifact: LocalSubtitleVerifiedRuntimeArtifact,
): void {
  if (
    runtime.target.platform !== "darwin" ||
    runtime.target.arch !== "arm64" ||
    !artifact ||
    artifact.kind !== "server" ||
    artifact.backend !== "metal_cpu" ||
    !SHA256_PATTERN.test(artifact.sha256) ||
    typeof artifact.absolutePath !== "string" ||
    artifact.absolutePath.length === 0
  ) {
    throw new LocalSubtitleBackendResolverError(
      "runtime_protocol_mismatch",
      "The verified runtime did not provide the production Metal server artifact.",
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
