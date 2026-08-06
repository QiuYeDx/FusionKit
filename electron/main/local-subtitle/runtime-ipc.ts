import {
  LOCAL_SUBTITLE_BACKENDS,
  LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
  type LocalSubtitleBackend,
  type LocalSubtitleErrorCode,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  localSubtitleIpcSuccess,
  type LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import type {
  LocalSubtitleIpcHandlerContext,
  LocalSubtitleIpcHandlers,
} from "./ipc";
import { LocalSubtitleMediaError } from "./media-normalizer";
import {
  loadLocalSubtitleRuntimeManifest,
  selectLocalSubtitleCpuServerArtifactId,
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleLoadedRuntimeManifest,
  type LocalSubtitleResourceEnvironment,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import { LocalSubtitleResourceError } from "./resource-manifest";

type RuntimeComponentSummary = LocalSubtitleRuntimeSummary["runner"];
type BackendSummary = LocalSubtitleRuntimeSummary["backends"][number];

export interface LocalSubtitleRuntimeIpcBridgeOptions {
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly mediaRuntimeVerifier: {
    verifyRuntime(options: {
      readonly owner: LocalSubtitleIpcHandlerContext["owner"];
      readonly signal?: AbortSignal;
    }): Promise<{ readonly runtimeGeneration: string }>;
  };
  readonly supportedGpuBackends?: readonly Exclude<LocalSubtitleBackend, "cpu">[];
  readonly loadRuntimeManifest?: (
    environment: LocalSubtitleResourceEnvironment,
  ) => Promise<LocalSubtitleLoadedRuntimeManifest>;
  readonly verifyServerRuntime?: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
}

export class LocalSubtitleRuntimeIpcBridge {
  readonly handlers: LocalSubtitleIpcHandlers;
  readonly #environment: LocalSubtitleResourceEnvironment;
  readonly #verifyMediaRuntime: LocalSubtitleRuntimeIpcBridgeOptions["mediaRuntimeVerifier"]["verifyRuntime"];
  readonly #supportedGpuBackends: ReadonlySet<Exclude<LocalSubtitleBackend, "cpu">>;
  readonly #loadRuntimeManifest: NonNullable<
    LocalSubtitleRuntimeIpcBridgeOptions["loadRuntimeManifest"]
  >;
  readonly #verifyServerRuntime: NonNullable<
    LocalSubtitleRuntimeIpcBridgeOptions["verifyServerRuntime"]
  >;

  constructor(options: LocalSubtitleRuntimeIpcBridgeOptions) {
    if (
      !options?.environment ||
      typeof options.mediaRuntimeVerifier?.verifyRuntime !== "function"
    ) {
      throw new TypeError("The local subtitle runtime IPC options are invalid.");
    }
    const supportedGpuBackends = options.supportedGpuBackends ?? [];
    if (
      !Array.isArray(supportedGpuBackends) ||
      supportedGpuBackends.some(
        (backend) => backend !== "metal" && backend !== "cuda",
      )
    ) {
      throw new TypeError("The local subtitle runtime GPU capabilities are invalid.");
    }
    this.#environment = options.environment;
    this.#verifyMediaRuntime = options.mediaRuntimeVerifier.verifyRuntime.bind(
      options.mediaRuntimeVerifier,
    );
    this.#supportedGpuBackends = new Set(supportedGpuBackends);
    this.#loadRuntimeManifest = options.loadRuntimeManifest ??
      loadLocalSubtitleRuntimeManifest;
    this.#verifyServerRuntime = options.verifyServerRuntime ?? (() =>
      verifyLocalSubtitleRuntimeBundle({
        environment: this.#environment,
        scope: "server",
      }));
    this.handlers = Object.freeze({
      public: Object.freeze({
        [LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeRuntime]: async (
          _request: unknown,
          context: LocalSubtitleIpcHandlerContext,
        ) => localSubtitleIpcSuccess(await this.#probe(context)),
      }),
    });
  }

  async #probe(
    context: LocalSubtitleIpcHandlerContext,
  ): Promise<LocalSubtitleRuntimeSummary> {
    const loaded = await this.#loadRuntimeManifest(this.#environment);
    const runtimeGeneration = loaded.manifestSha256;
    const [serverResult, mediaResult] = await Promise.allSettled([
      this.#verifyServerRuntime(),
      this.#verifyMediaRuntime({
        owner: context.owner,
        signal: context.signal,
      }),
    ]);
    throwIfAborted(context.signal);

    const runner = serverResult.status === "fulfilled"
      ? runnerSummary(serverResult.value, runtimeGeneration)
      : componentFailure(serverResult.reason, "runner");
    const mediaRuntime = mediaResult.status === "fulfilled"
      ? mediaSummary(loaded, mediaResult.value.runtimeGeneration, runtimeGeneration)
      : componentFailure(mediaResult.reason, "media");

    return Object.freeze({
      schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
      platform: loaded.manifest.target.platform,
      arch: loaded.manifest.target.arch,
      runtimeGeneration,
      runner,
      mediaRuntime,
      backends: LOCAL_SUBTITLE_BACKENDS.map((backend) =>
        this.#backendSummary(backend, loaded, runner),
      ),
    });
  }

  #backendSummary(
    backend: LocalSubtitleBackend,
    loaded: LocalSubtitleLoadedRuntimeManifest,
    runner: RuntimeComponentSummary,
  ): BackendSummary {
    if (runner.status !== "ready") {
      return Object.freeze({
        backend,
        status: "unavailable" as const,
        errorCode: runner.errorCode ?? "runtime_protocol_mismatch",
      });
    }
    if (backend === "cpu") {
      return Object.freeze({ backend, status: "available" as const });
    }
    if (backend === "metal") {
      const serverSupportsMetal = loaded.manifest.artifacts.some(
        (artifact) => artifact.kind === "server" && artifact.backend === "metal_cpu",
      );
      return this.#supportedGpuBackends.has("metal") && serverSupportsMetal
        ? Object.freeze({ backend, status: "available" as const })
        : Object.freeze({
            backend,
            status: "unavailable" as const,
            errorCode: "accelerator_unavailable" as const,
          });
    }
    return this.#supportedGpuBackends.has("cuda")
      ? Object.freeze({
          backend,
          status: "unverified" as const,
          errorCode: "backend_unverified" as const,
        })
      : Object.freeze({
          backend,
          status: "unavailable" as const,
          errorCode: "accelerator_unavailable" as const,
        });
  }
}

function runnerSummary(
  runtime: LocalSubtitleVerifiedRuntimeBundle,
  runtimeGeneration: string,
): RuntimeComponentSummary {
  if (runtime.runtimeGeneration !== runtimeGeneration) {
    return Object.freeze({
      status: "invalid" as const,
      errorCode: "runtime_protocol_mismatch" as const,
    });
  }
  const artifact = runtime.artifactPaths[
    selectLocalSubtitleCpuServerArtifactId(runtime)
  ];
  if (!artifact) {
    return Object.freeze({
      status: "missing" as const,
      errorCode: "runtime_missing" as const,
    });
  }
  return Object.freeze({ status: "ready" as const, version: artifact.version });
}

function mediaSummary(
  loaded: LocalSubtitleLoadedRuntimeManifest,
  verifiedGeneration: string,
  runtimeGeneration: string,
): RuntimeComponentSummary {
  if (verifiedGeneration !== runtimeGeneration) {
    return Object.freeze({
      status: "invalid" as const,
      errorCode: "media_runtime_invalid" as const,
    });
  }
  const artifact = loaded.manifest.artifacts.find(
    (candidate) => candidate.kind === "ffmpeg",
  );
  if (!artifact) {
    return Object.freeze({
      status: "missing" as const,
      errorCode: "media_runtime_missing" as const,
    });
  }
  return Object.freeze({ status: "ready" as const, version: artifact.version });
}

function componentFailure(
  error: unknown,
  component: "runner" | "media",
): RuntimeComponentSummary {
  const code = componentErrorCode(error, component);
  return Object.freeze({
    status: componentStatus(code),
    errorCode: code,
  });
}

function componentErrorCode(
  error: unknown,
  component: "runner" | "media",
): LocalSubtitleErrorCode {
  if (error instanceof LocalSubtitleResourceError) return error.code;
  if (error instanceof LocalSubtitleMediaError) {
    if (error.localSubtitleCode === "owner_released") throw error;
    return error.localSubtitleCode;
  }
  throw error;
}

function componentStatus(
  code: LocalSubtitleErrorCode,
): RuntimeComponentSummary["status"] {
  if (code === "runtime_missing" || code === "media_runtime_missing") {
    return "missing";
  }
  if (code === "media_runtime_launch_failed") return "launch_failed";
  return "invalid";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}
