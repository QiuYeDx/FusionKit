import { randomUUID } from "node:crypto";
import path from "node:path";
import { shouldRetryUnconditionedAudio } from "./quiet-audio";
import { needsLocalSubtitleSeparators, restoreLocalSubtitleCueSeparators } from "./cue-separator-restorer";
import {
  LOCAL_SUBTITLE_ERROR_MANIFEST,
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  createLocalSubtitleError,
  isLocalSubtitleErrorCode,
  type LocalSubtitleError,
  type LocalSubtitleErrorCode,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleDiagnostics,
  type LocalSubtitleFormat,
  type LocalSubtitleOperationStage,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleDirectoryIdentity,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  ResolvedLocalSubtitleOutputDirectory,
} from "./authorizations";
import type {
  LocalSubtitleJobBatchExecutionContext,
  LocalSubtitleJobBatchRuntime,
  LocalSubtitleJobTaskExecutionContext,
  LocalSubtitleJobTaskExecutionResult,
  LocalSubtitleJobTaskExecutor,
} from "./job-manager";
import {
  isLocalSubtitleVerifiedBackendResolution,
  matchesLocalSubtitleBackendResolutionAccelerator,
  matchesLocalSubtitleBackendResolutionRuntime,
  type LocalSubtitleVerifiedBackendResolution,
} from "./backend-resolver";
import {
  matchesLocalSubtitleVerifiedAcceleratorPack,
  type LocalSubtitleVerifiedAcceleratorPack,
} from "./accelerator-manager";
import {
  isLocalSubtitleBrandedPcmWindow,
  type LocalSubtitleBrandedPcmWindow,
  type LocalSubtitleMediaNormalizer,
  type LocalSubtitleMediaStructuralWindow,
  type LocalSubtitleNormalizedPcm,
  type LocalSubtitleResolvedPcmWindow,
} from "./media-normalizer";
import {
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleResourceEnvironment,
  type LocalSubtitleVerifiedRuntimeArtifact,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";
import type {
  LocalSubtitleServerInferenceRequest,
} from "./server-contract";
import type {
  LocalSubtitleServerInferenceOperation,
  LocalSubtitleServerLease,
  LocalSubtitleServerRuntimePin,
  LocalSubtitleServerSupervisor,
  LocalSubtitleServerSupervisorInferenceResponse,
} from "./server-supervisor";
import type {
  LocalSubtitleExportResult,
  LocalSubtitleExporter,
} from "./subtitle-exporter";
import {
  sameLocalSubtitleFileIdentity,
  sameLocalSubtitleFilesystemObjectIdentity,
} from "./filesystem-object-identity";
import {
  LocalSubtitlePostProcessorError,
  assessLocalSubtitleRawWindow,
  createSubtitlePostProcessPolicy,
  decideLocalSubtitleWindowRetry,
  planLocalSubtitleRootWindows,
  postProcessLocalSubtitleTranscript,
  throwLocalSubtitleWindowDecisionFailure,
  type LocalSubtitlePostProcessingWindow,
  type LocalSubtitlePostProcessingWindowAttempt,
} from "./subtitle-post-processor";

const DEFAULT_CPU_THREADS = 4;
const MIN_CPU_THREADS = 1;
const MAX_CPU_THREADS = 8;
const RESERVED_WINDOWS_OUTPUT_STEM =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export const LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY = Object.freeze({
  maxRetainedRawSegments: LOCAL_SUBTITLE_LIMITS.maxTranscriptSegments,
  maxRetainedRawTextBytes:
    LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxServerResponseBytes,
  maxQualityRecoveryReplays: 1,
  qualityRecoveryTemperatureStep: 0.2,
  separatorRequestTimeoutMs: 30_000,
  maxConsecutiveUnchangedSeparatorWindows: 2,
});

interface LocalSubtitleRetainedRawBudget {
  readonly maxSegments: number;
  readonly maxTextBytes: number;
}

interface LocalSubtitleRetainedRawUsage {
  segments: number;
  textBytes: number;
}

type ProductionMedia = Pick<
  LocalSubtitleMediaNormalizer,
  | "normalizeTask"
  | "materializeWindow"
  | "resolveWindow"
  | "disposeWindow"
  | "disposeNormalized"
>;

type ProductionSupervisor = Pick<
  LocalSubtitleServerSupervisor,
  | "acquireBatchRuntimePin"
  | "acquirePinnedTaskLease"
  | "acquirePinnedSeparatorLease"
  | "beginInference"
  | "cancelRequest"
  | "release"
  | "releaseBatchRuntimePin"
>;

interface ProductionBatchRuntimeRecord {
  readonly runtime: LocalSubtitleJobBatchRuntime;
  readonly owner: LocalSubtitleJobBatchExecutionContext["owner"];
  readonly batchId: string;
  readonly config: LocalSubtitleJobBatchExecutionContext["config"];
  readonly managedModel: LocalSubtitleJobBatchExecutionContext["managedModel"];
  readonly managedVad?: LocalSubtitleJobBatchExecutionContext["managedVad"];
  readonly admittedRuntimeGeneration: string;
  readonly backendResolution: LocalSubtitleVerifiedBackendResolution;
  readonly signal: AbortSignal;
  active: boolean;
  pin?: LocalSubtitleServerRuntimePin;
  pinOperation?: Promise<LocalSubtitleServerRuntimePin>;
  pinnedIdentity?: PinnedServerRuntimeIdentity;
}

interface PinnedServerRuntimeIdentity {
  readonly runtimeRoot: string;
  readonly runtimeGeneration: string;
  readonly targetPlatform: LocalSubtitleVerifiedRuntimeBundle["target"]["platform"];
  readonly targetArch: LocalSubtitleVerifiedRuntimeBundle["target"]["arch"];
  readonly serverArtifact: Readonly<{
    id: string;
    kind: LocalSubtitleVerifiedRuntimeArtifact["kind"];
    backend: LocalSubtitleVerifiedRuntimeArtifact["backend"];
    absolutePath: string;
    byteSize: number;
    sha256: string;
    version: string;
    signatureKind: LocalSubtitleVerifiedRuntimeArtifact["signatureKind"];
  }>;
  readonly managedModel: LocalSubtitleJobBatchExecutionContext["managedModel"];
  readonly managedVad?: LocalSubtitleJobBatchExecutionContext["managedVad"];
  readonly acceleratorPack?: LocalSubtitleVerifiedAcceleratorPack;
}

type ProductionOutputs = Pick<
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  "resolveBatchLease"
>;

type ProductionInputs = Pick<
  LocalSubtitleInputAuthorizationRegistry,
  "resolveTaskSourceOutputDirectory"
>;

type ProductionExporter = Pick<
  LocalSubtitleExporter<unknown>,
  "exportArtifacts" | "supportsConflictPolicy"
>;

export interface LocalSubtitleProductionExecutorOptions {
  readonly media: ProductionMedia;
  readonly supervisor: ProductionSupervisor;
  readonly inputs: ProductionInputs;
  readonly outputs: ProductionOutputs;
  readonly exporter: ProductionExporter;
  readonly runtimeEnvironment?: LocalSubtitleResourceEnvironment;
  readonly verifyServerRuntime?: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly resolveCudaAccelerator?: (
    signal?: AbortSignal,
  ) => Promise<LocalSubtitleVerifiedAcceleratorPack>;
  readonly validateWindowBrand?: (
    window: LocalSubtitleBrandedPcmWindow,
  ) => boolean;
  readonly rootPlanIdFactory?: () => string;
  readonly cpuThreads?: number;
  readonly retainedRawBudget?: LocalSubtitleRetainedRawBudget;
}

export class LocalSubtitleProductionExecutor
  implements LocalSubtitleJobTaskExecutor
{
  readonly #media: ProductionMedia;
  readonly #supervisor: ProductionSupervisor;
  readonly #inputs: ProductionInputs;
  readonly #outputs: ProductionOutputs;
  readonly #exporter: ProductionExporter;
  readonly #verifyServerRuntime: () => Promise<LocalSubtitleVerifiedRuntimeBundle>;
  readonly #resolveCudaAccelerator:
    | ((signal?: AbortSignal) => Promise<LocalSubtitleVerifiedAcceleratorPack>)
    | undefined;
  readonly #validateWindowBrand: (
    window: LocalSubtitleBrandedPcmWindow,
  ) => boolean;
  readonly #rootPlanIdFactory: () => string;
  readonly #cpuThreads: number;
  readonly #retainedRawBudget: LocalSubtitleRetainedRawBudget;
  readonly #batchRuntimes = new WeakMap<
    LocalSubtitleJobBatchRuntime,
    ProductionBatchRuntimeRecord
  >();
  #nextRequestGeneration = 1;

  constructor(options: LocalSubtitleProductionExecutorOptions) {
    if (
      !hasMethods(options?.media, [
        "normalizeTask",
        "materializeWindow",
        "resolveWindow",
        "disposeWindow",
        "disposeNormalized",
      ]) ||
      !hasMethods(options?.supervisor, [
        "acquireBatchRuntimePin",
        "acquirePinnedTaskLease",
        "acquirePinnedSeparatorLease",
        "beginInference",
        "cancelRequest",
        "release",
        "releaseBatchRuntimePin",
      ]) ||
      !hasMethods(options?.inputs, ["resolveTaskSourceOutputDirectory"]) ||
      !hasMethods(options?.outputs, ["resolveBatchLease"]) ||
      !hasMethods(options?.exporter, [
        "exportArtifacts",
        "supportsConflictPolicy",
      ])
    ) {
      throw new TypeError("The local subtitle production executor options are invalid.");
    }
    if (!options.verifyServerRuntime && !options.runtimeEnvironment) {
      throw new TypeError("A local subtitle server runtime verifier is required.");
    }
    if (
      options.resolveCudaAccelerator !== undefined &&
      typeof options.resolveCudaAccelerator !== "function"
    ) {
      throw new TypeError("The local subtitle CUDA accelerator resolver is invalid.");
    }
    const cpuThreads = options.cpuThreads ?? DEFAULT_CPU_THREADS;
    if (
      !Number.isSafeInteger(cpuThreads) ||
      cpuThreads < MIN_CPU_THREADS ||
      cpuThreads > MAX_CPU_THREADS
    ) {
      throw new TypeError("The local subtitle CPU thread count is invalid.");
    }
    const retainedRawBudget = options.retainedRawBudget ?? {
      maxSegments:
        LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxRetainedRawSegments,
      maxTextBytes:
        LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxRetainedRawTextBytes,
    };
    if (
      !isPositiveSafeIntegerAtMost(
        retainedRawBudget.maxSegments,
        LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxRetainedRawSegments,
      ) ||
      !isPositiveSafeIntegerAtMost(
        retainedRawBudget.maxTextBytes,
        LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxRetainedRawTextBytes,
      )
    ) {
      throw new TypeError("The local subtitle retained raw response budget is invalid.");
    }
    this.#media = options.media;
    this.#supervisor = options.supervisor;
    this.#inputs = options.inputs;
    this.#outputs = options.outputs;
    this.#exporter = options.exporter;
    this.#verifyServerRuntime = options.verifyServerRuntime ?? (() =>
      verifyLocalSubtitleRuntimeBundle({
        environment: options.runtimeEnvironment!,
        scope: "server",
      }));
    this.#resolveCudaAccelerator = options.resolveCudaAccelerator;
    this.#validateWindowBrand =
      options.validateWindowBrand ?? isLocalSubtitleBrandedPcmWindow;
    this.#rootPlanIdFactory =
      options.rootPlanIdFactory ?? (() => `plan-${randomUUID()}`);
    this.#cpuThreads = cpuThreads;
    this.#retainedRawBudget = Object.freeze({ ...retainedRawBudget });
  }

  supportsOutputConflictPolicy(policy: LocalSubtitleConflictPolicy): boolean {
    return this.#exporter.supportsConflictPolicy(policy);
  }

  beginBatchSlice(
    context: LocalSubtitleJobBatchExecutionContext,
  ): LocalSubtitleJobBatchRuntime {
    if (
      !isSupportedBatchExecutionContext(
        context,
        this.#exporter.supportsConflictPolicy.bind(this.#exporter),
      )
    ) {
      throw createLocalSubtitleError(
        "invalid_ipc_request",
        "The local subtitle batch runtime context is invalid.",
        { stage: "preflight" },
      );
    }
    const runtime = Object.freeze({}) as LocalSubtitleJobBatchRuntime;
    this.#batchRuntimes.set(runtime, {
      runtime,
      owner: Object.freeze({ ...context.owner }),
      batchId: context.batchId,
      config: context.config,
      managedModel: context.managedModel,
      ...(context.managedVad === undefined
        ? {}
        : { managedVad: context.managedVad }),
      admittedRuntimeGeneration: context.admittedRuntimeGeneration,
      backendResolution: context.backendResolution,
      signal: context.signal,
      active: true,
    });
    return runtime;
  }

  endBatchSlice(runtime: LocalSubtitleJobBatchRuntime): void {
    const record = this.#batchRuntimes.get(runtime);
    if (!record?.active) return;
    record.active = false;
    if (record.pin) {
      this.#supervisor.releaseBatchRuntimePin(record.pin);
      record.pin = undefined;
    }
  }

  async execute(
    context: LocalSubtitleJobTaskExecutionContext,
  ): Promise<LocalSubtitleJobTaskExecutionResult> {
    const batchRuntime = this.#resolveBatchRuntime(context);
    if (
      !batchRuntime ||
      !isSupportedExecutionContext(
        context,
        this.#exporter.supportsConflictPolicy.bind(this.#exporter),
      )
    ) {
      return failedResult("invalid_ipc_request", "preflight");
    }

    let sourceOutputDirectoryIdentity: LocalSubtitleDirectoryIdentity | undefined;
    if (context.config.output.mode === "source") {
      try {
        throwIfCancelled(context.signal);
        const directory = await this.#inputs.resolveTaskSourceOutputDirectory(
          context.owner,
          context.taskId,
          context.fileToken,
        );
        sourceOutputDirectoryIdentity = Object.freeze({ ...directory.identity });
        throwIfCancelled(context.signal);
      } catch (error) {
        if (context.signal.aborted || error instanceof ExecutionCancelled) {
          return Object.freeze({ status: "cancelled", artifactResults: [] });
        }
        const code = publicErrorCode(error, "exporting");
        return failedResult(
          code,
          LOCAL_SUBTITLE_ERROR_MANIFEST[code].defaultStage,
        );
      }
    }
    const resolveOutputDirectory = this.#createOutputDirectoryResolver(
      context,
      sourceOutputDirectoryIdentity,
    );

    let stage: LocalSubtitleOperationStage = "preparing_media";
    let normalized: LocalSubtitleNormalizedPcm | undefined;
    let lease: LocalSubtitleServerLease | undefined;
    let transcript:
      | ReturnType<typeof postProcessLocalSubtitleTranscript>["transcript"]
      | undefined;
    let pipelineError: unknown;
    let durationMs: number | undefined;

    try {
      throwIfCancelled(context.signal);
      normalized = await this.#media.normalizeTask({
        owner: context.owner,
        fileToken: context.fileToken,
        taskId: context.taskId,
        taskGeneration: context.generation,
        ...(context.audioStreamId === undefined
          ? {}
          : { audioStreamId: context.audioStreamId }),
        signal: context.signal,
        onProgress: (percentage) => {
          const progress = boundedPercentage(percentage);
          context.update({
            status: "preparing_media",
            progress: {
              stage: "preparing_media",
              stageProgress: progress,
              overallProgress: Math.floor(progress * 0.2),
            },
          });
        },
      });
      durationMs = normalized.durationMs;
      throwIfCancelled(context.signal);

      const policy = createSubtitlePostProcessPolicy(context.config.inference);
      const rootPlan = planLocalSubtitleRootWindows({
        rootPlanId: this.#rootPlanIdFactory(),
        totalFrames: normalized.totalFrames,
        policy,
      });

      stage = "loading_model";
      context.update({
        status: "loading_model",
        progress: {
          stage: "loading_model",
          stageProgress: 0,
          overallProgress: 20,
        },
        durationMs,
      });
      const runtime = await this.#verifyServerRuntime();
      throwIfCancelled(context.signal);
      if (
        runtime.runtimeGeneration !== normalized.runtimeGeneration ||
        runtime.runtimeGeneration !== context.admittedRuntimeGeneration ||
        !matchesLocalSubtitleBackendResolutionRuntime(
          context.backendResolution,
          runtime,
        )
      ) {
        throw createLocalSubtitleError(
          "media_runtime_invalid",
          "The bundled runtime changed after batch admission or media normalization.",
          { stage: "loading_model" },
        );
      }
      const serverArtifactId = context.backendResolution.serverArtifact.id;
      let acceleratorPack: LocalSubtitleVerifiedAcceleratorPack | undefined;
      if (context.backendResolution.resolvedBackend === "cuda") {
        if (!this.#resolveCudaAccelerator) {
          throw createLocalSubtitleError(
            "backend_unverified",
            "The CUDA accelerator cannot be reverified for execution.",
            { stage: "loading_model" },
          );
        }
        try {
          acceleratorPack = await this.#resolveCudaAccelerator(context.signal);
        } catch {
          if (context.signal.aborted) throw new ExecutionCancelled();
          throw createLocalSubtitleError(
            "backend_unverified",
            "The CUDA accelerator failed execution-time verification.",
            { stage: "loading_model" },
          );
        }
        throwIfCancelled(context.signal);
        if (
          !matchesLocalSubtitleBackendResolutionAccelerator(
            context.backendResolution,
            acceleratorPack,
          )
        ) {
          throw createLocalSubtitleError(
            "media_runtime_invalid",
            "The CUDA accelerator changed after batch admission.",
            { stage: "loading_model" },
          );
        }
      }
      const pin = await this.#ensureBatchRuntimePin(
        batchRuntime,
        runtime,
        serverArtifactId,
        acceleratorPack,
        context.signal,
      );
      lease = await this.#supervisor.acquirePinnedTaskLease(pin, context.signal, {
        // Native process reuse changed the same audio after unrelated VAD requests.
        // Reuse within a file; start each affected task without prior inference state.
        freshInferenceState: runtime.target.platform === "win32" &&
          context.config.resolvedBackend === "cuda" && context.config.inference.vad.enabled,
      });
      throwIfCancelled(context.signal);
      context.update({
        status: "loading_model",
        progress: {
          stage: "loading_model",
          stageProgress: 100,
          overallProgress: 30,
        },
        durationMs,
      });

      stage = "transcribing";
      const attempts: LocalSubtitlePostProcessingWindowAttempt[] = [];
      const requestsPerRoot = new Map<string, number>();
      const consumedBrands = new WeakSet<object>();
      const consumedResponses = new Set<string>();
      const retainedRawUsage: LocalSubtitleRetainedRawUsage = {
        segments: 0,
        textBytes: 0,
      };
      let nextWindowAttempt = 1;
      let completedRootWindows = 0;
      context.update({
        status: "transcribing",
        progress: {
          stage: "transcribing",
          stageProgress: 0,
          overallProgress: 30,
          completedWindows: 0,
          totalWindows: rootPlan.windows.length,
        },
        durationMs,
      });

      const executeWindowAttempt = async (
        window: LocalSubtitlePostProcessingWindow,
        qualityRecoveryAttempt: number,
        conditionQuietAudio = context.config.inference.vad.enabled,
        separatorCandidate = false,
      ) => {
        throwIfCancelled(context.signal);
        let brand: LocalSubtitleBrandedPcmWindow | undefined;
        let operationError: unknown;
        let outcome:
          | Readonly<{
              attempt: LocalSubtitlePostProcessingWindowAttempt;
              assessment: ReturnType<typeof assessLocalSubtitleRawWindow>;
              decision: ReturnType<typeof decideLocalSubtitleWindowRetry>;
              quietAudioConditioned: boolean;
            }>
          | undefined;
        try {
          brand = await this.#media.materializeWindow({
            normalized: normalized!,
            descriptor: window,
            signal: context.signal,
            conditionQuietAudio,
          });
          assertWindowBrand(
            brand,
            window,
            context,
            normalized!.normalizationId,
            consumedBrands,
            this.#validateWindowBrand,
          );
          const before = await this.#media.resolveWindow(brand, {
            taskId: context.taskId,
            taskGeneration: context.generation,
            descriptor: window,
          });
          assertResolvedWindowMatchesBrand(brand, before);

          const windowAttempt = nextWindowAttempt;
          nextWindowAttempt = incrementSafeCounter(
            nextWindowAttempt,
            "windowAttempt",
          );
          const requestGeneration = this.#claimRequestGeneration();
          requestsPerRoot.set(window.rootWindowKey, (requestsPerRoot.get(window.rootWindowKey) ?? 0) + 1);
          const request = createInferenceRequest(context, before, requestGeneration,
            qualityRecoveryAttempt, separatorCandidate);
          let inference: LocalSubtitleServerSupervisorInferenceResponse;
          const deadline = separatorCandidate ? new AbortController() : undefined;
          const cancelDeadline = () => deadline?.abort();
          const timeout = deadline ? setTimeout(cancelDeadline,
            LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.separatorRequestTimeoutMs) : undefined;
          if (context.signal.aborted) cancelDeadline();
          else if (deadline) context.signal.addEventListener("abort", cancelDeadline, { once: true });
          try {
            const signal = deadline?.signal ?? context.signal;
            inference = await this.#runInference(lease!, { ...request, signal }, signal);
            if (deadline?.signal.aborted) throw new SeparatorCandidateUnavailable();
          } catch (error) {
            if (separatorCandidate && !context.signal.aborted &&
                !isCleanupFailureCode(publicErrorCode(error, "transcribing"))) {
              throw new SeparatorCandidateUnavailable();
            }
            throw error;
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            context.signal.removeEventListener("abort", cancelDeadline);
          }
          throwIfCancelled(context.signal);
          const after = await this.#media.resolveWindow(brand, {
            taskId: context.taskId,
            taskGeneration: context.generation,
            descriptor: window,
          });
          assertSameResolvedWindow(before, after);
          const attempt = bindAttempt({
            window,
            windowAttempt,
            requestGeneration,
            inference,
            consumedResponses,
          });
          const attemptPolicy = separatorCandidate ? Object.freeze({ ...policy, vadEnabled: false }) : policy;
          const assessment = assessLocalSubtitleRawWindow({
            window,
            result: attempt.response.result,
            policy: attemptPolicy,
          });
          const decision = decideLocalSubtitleWindowRetry({
            attempt,
            assessment,
            policy: attemptPolicy,
          });
          outcome = Object.freeze({ attempt, assessment, decision,
            quietAudioConditioned: before.quietAudioGainDb !== undefined });
        } catch (error) {
          operationError = error;
        } finally {
          if (brand) {
            try {
              await this.#media.disposeWindow(brand);
            } catch (error) {
              operationError = cleanupFailure(error, context.signal.aborted);
            }
          }
        }
        if (operationError !== undefined) throw operationError;
        if (!outcome) {
          throw createLocalSubtitleError(
            "runtime_protocol_mismatch",
            "The local inference attempt produced no quality assessment.",
            { stage: "transcribing" },
          );
        }
        return outcome;
      };

      const retainAttempt = (
        attempt: LocalSubtitlePostProcessingWindowAttempt,
      ): void => {
        reserveRetainedRawResponse(
          attempt.response,
          retainedRawUsage,
          this.#retainedRawBudget,
        );
        attempts.push(attempt);
      };

      const dispatchWindow = async (
        window: LocalSubtitlePostProcessingWindow,
      ): Promise<void> => {
        let qualityRecoveryAttempts = 0;
        while (true) {
          let outcome = await executeWindowAttempt(window, qualityRecoveryAttempts);
          if (outcome.quietAudioConditioned && shouldRetryUnconditionedAudio(outcome.assessment)) {
            // Retry the original audio once, without recursively conditioning it.
            // Discard this candidate rather than letting display shaping hide it.
            outcome = await executeWindowAttempt(window, qualityRecoveryAttempts, false);
          }
          const { attempt, assessment, decision } = outcome;
          if (decision.action === "accept") {
            retainAttempt(attempt);
            return;
          }
          if (decision.action === "split") {
            retainAttempt(attempt);
            for (const child of decision.children) {
              await dispatchWindow(child);
            }
            return;
          }
          if (
            decision.reason !== "contract_invalid" &&
            qualityRecoveryAttempts <
              LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxQualityRecoveryReplays
          ) {
            qualityRecoveryAttempts += 1;
            continue;
          }
          throwLocalSubtitleWindowDecisionFailure(decision, assessment, {
            qualityRecoveryAttempts,
            maxQualityRecoveryAttempts:
              LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxQualityRecoveryReplays,
          });
        }
      };

      for (const rootWindow of rootPlan.windows) {
        await dispatchWindow(rootWindow);
        completedRootWindows += 1;
        const stageProgress = Math.floor(
          (completedRootWindows / rootPlan.windows.length) * 100,
        );
        context.update({
          status: "transcribing",
          progress: {
            stage: "transcribing",
            stageProgress,
            overallProgress: 30 + Math.floor(stageProgress * 0.5),
            completedWindows: completedRootWindows,
            totalWindows: rootPlan.windows.length,
          },
          durationMs,
        });
      }

      stage = "post_processing";
      context.update({
        status: "post_processing",
        progress: {
          stage: "post_processing",
          stageProgress: 0,
          overallProgress: 80,
        },
        durationMs,
      });
      transcript = postProcessLocalSubtitleTranscript({
        source: {
          displayName: normalized.displayName,
          durationMs: normalized.durationMs,
          totalFrames: normalized.totalFrames,
          sampleRateHz: normalized.sampleRateHz,
        },
        model: {
          engine: context.config.model.engine,
          modelId: context.config.model.modelId,
          modelHash: context.config.model.modelHash,
          backend: context.config.resolvedBackend,
        },
        taskMode: context.config.taskMode,
        policy,
        rootPlan,
        attempts,
      }).transcript;
      // A separate text-only pass retains the accepted primary transcript and times.
      // Non-Windows/backends remain on the previously verified production path.
      if (runtime.target.platform === "win32" && context.config.resolvedBackend === "cuda" &&
          context.config.taskMode === "transcribe" && context.config.inference.vad.enabled) {
        const segments = [...transcript.segments];
        const eligible = rootPlan.windows.flatMap(window => {
          if (requestsPerRoot.get(window.rootWindowKey) !== 1) return [];
          const primary = attempts.find(attempt => attempt.window.windowKey === window.windowKey);
          if (!primary || !["ja", "japanese"].includes(primary.response.result.language.toLowerCase())) return [];
          const cueIndices = segments.flatMap((cue, index) => needsLocalSubtitleSeparators(cue) &&
            cue.startMs >= window.startMs && cue.endMs <= window.endMs &&
            primary.response.result.segments.some(raw => raw.text === cue.text &&
              raw.startMs + window.startMs === cue.startMs && raw.endMs + window.startMs === cue.endMs) ? [index] : []);
          return cueIndices.length ? [{ window, primary, cueIndices }] : [];
        });
        if (eligible.length) {
          await this.#supervisor.release(lease!);
          lease = undefined;
          try {
            lease = await this.#supervisor.acquirePinnedSeparatorLease(pin, context.signal);
          } catch (error) {
            if (context.signal.aborted || isCleanupFailureCode(publicErrorCode(error, "loading_model"))) throw error;
            // Optional model startup failure leaves all accepted primary cues available.
          }
          if (lease) {
            let unchanged = 0;
            for (let index = 0; index < eligible.length; index++) {
              throwIfCancelled(context.signal);
              const { window, primary, cueIndices } = eligible[index]!;
              let candidate: Awaited<ReturnType<typeof executeWindowAttempt>>;
              try {
                candidate = await executeWindowAttempt(window, 0, false, true);
              } catch (error) {
                if (error instanceof SeparatorCandidateUnavailable) break;
                throw error;
              }
              if (candidate.decision.action !== "accept") break;
              try {
                reserveRetainedRawResponse(candidate.attempt.response, retainedRawUsage, this.#retainedRawBudget);
              } catch {
                break;
              }
              let changed = false;
              for (const cueIndex of cueIndices) {
                const cue = segments[cueIndex]!;
                const restored = restoreLocalSubtitleCueSeparators({ cue,
                  primary: primary.response.result.segments,
                  candidate: candidate.attempt.response.result.segments,
                  windowStartMs: window.startMs, targets: policy });
                changed ||= restored !== cue;
                segments[cueIndex] = restored;
              }
              unchanged = changed ? 0 : unchanged + 1;
              context.update({ status: "post_processing", progress: {
                stage: "post_processing", stageProgress: Math.floor((index + 1) / eligible.length * 100),
                overallProgress: 80 + Math.floor((index + 1) / eligible.length * 10),
              }, durationMs });
              if (unchanged >= LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.maxConsecutiveUnchangedSeparatorWindows) break;
            }
            transcript = Object.freeze({ ...transcript, segments: Object.freeze(segments) });
          }
        }
      }
      context.update({
        status: "post_processing",
        progress: {
          stage: "post_processing",
          stageProgress: 100,
          overallProgress: 90,
        },
        durationMs,
      });
    } catch (error) {
      pipelineError = error;
    }

    const cleanupError = await this.#cleanupPipeline(lease, normalized);
    lease = undefined;
    normalized = undefined;
    if (cleanupError !== undefined) {
      return failedResult(
        context.signal.aborted ? "cancel_failed" : "cleanup_failed",
        "cleanup",
        durationMs,
      );
    }
    if (pipelineError !== undefined) {
      const code = normalizeCleanupErrorCode(
        publicErrorCode(pipelineError, stage),
        context.signal.aborted,
      );
      if (isCleanupFailureCode(code)) {
        return failedResult(code, "cleanup", durationMs);
      }
      if (context.signal.aborted || pipelineError instanceof ExecutionCancelled) {
        return Object.freeze({ status: "cancelled", artifactResults: [], durationMs });
      }
      return failedResult(
        code,
        code === "transcript_quality_failed"
          ? LOCAL_SUBTITLE_ERROR_MANIFEST[code].defaultStage
          : stage,
        durationMs,
        pipelineError,
      );
    }
    if (!transcript || context.signal.aborted) {
      return Object.freeze({ status: "cancelled", artifactResults: [], durationMs });
    }

    stage = "exporting";
    try {
      context.update({
        status: "exporting",
        progress: {
          stage: "exporting",
          stageProgress: 0,
          overallProgress: 90,
        },
        durationMs,
      });
      const result = await this.#exporter.exportArtifacts({
        owner: context.owner,
        taskId: context.taskId,
        generation: context.generation,
        outputStem: outputStem(transcript.source.displayName, context.taskId),
        formats: context.config.output.formats,
        conflictPolicy: context.config.output.conflictPolicy,
        transcript,
        resolveOutputDirectory,
        signal: context.signal,
      });
      return mapExportResult(result, durationMs, context.signal.aborted);
    } catch (error) {
      const rawCode = publicErrorCode(error, stage);
      const code = normalizeCleanupErrorCode(rawCode, context.signal.aborted);
      if (!isCleanupFailureCode(code) && context.signal.aborted) {
        return Object.freeze({ status: "cancelled", artifactResults: [], durationMs });
      }
      return failedResult(
        code,
        isCleanupFailureCode(code)
          ? "cleanup"
          : LOCAL_SUBTITLE_ERROR_MANIFEST[code].defaultStage,
        durationMs,
      );
    }
  }

  async #runInference(
    lease: LocalSubtitleServerLease,
    request: LocalSubtitleServerInferenceRequest,
    signal: AbortSignal,
  ): Promise<LocalSubtitleServerSupervisorInferenceResponse> {
    let operation: LocalSubtitleServerInferenceOperation;
    operation = this.#supervisor.beginInference(lease, request);
    let cancelOperation: Promise<void> | undefined;
    let cancelError: unknown;
    const cancel = () => {
      if (cancelOperation) return;
      try {
        cancelOperation = Promise.resolve(
          this.#supervisor.cancelRequest(operation.ticket),
        ).catch((error) => {
          cancelError = error;
        });
      } catch (error) {
        cancelError = error;
        cancelOperation = Promise.resolve();
      }
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    let result: LocalSubtitleServerSupervisorInferenceResponse | undefined;
    let operationError: unknown;
    try {
      result = await operation.result;
    } catch (error) {
      operationError = error;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      await cancelOperation;
    }
    if (cancelError !== undefined) throw cleanupFailure(cancelError, true);
    if (operationError !== undefined) throw operationError;
    if (!result) {
      throw createLocalSubtitleError(
        "runtime_protocol_mismatch",
        "The local inference operation returned no response.",
        { stage: "transcribing" },
      );
    }
    return result;
  }

  async #cleanupPipeline(
    lease: LocalSubtitleServerLease | undefined,
    normalized: LocalSubtitleNormalizedPcm | undefined,
  ): Promise<unknown | undefined> {
    let firstFailure: unknown;
    if (lease) {
      try {
        await this.#supervisor.release(lease);
      } catch (error) {
        firstFailure = error;
      }
    }
    if (normalized) {
      try {
        await this.#media.disposeNormalized(normalized);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    return firstFailure;
  }

  #claimRequestGeneration(): number {
    const generation = this.#nextRequestGeneration;
    this.#nextRequestGeneration = incrementSafeCounter(
      generation,
      "requestGeneration",
    );
    return generation;
  }

  #createOutputDirectoryResolver(
    context: LocalSubtitleJobTaskExecutionContext,
    expectedSourceIdentity?: LocalSubtitleDirectoryIdentity,
  ): () => Promise<ResolvedLocalSubtitleOutputDirectory> {
    return context.config.output.mode === "source"
      ? async () => {
          if (!expectedSourceIdentity) {
            throw createLocalSubtitleError(
              "output_write_failed",
              "The source subtitle output directory proof is unavailable.",
              { stage: "exporting" },
            );
          }
          const directory = await this.#inputs.resolveTaskSourceOutputDirectory(
            context.owner,
            context.taskId,
            context.fileToken,
          );
          if (!sameDirectoryIdentity(directory.identity, expectedSourceIdentity)) {
            throw createLocalSubtitleError(
              "output_write_failed",
              "The source subtitle output directory changed after preflight.",
              { stage: "exporting" },
            );
          }
          return directory;
        }
      : () => this.#outputs.resolveBatchLease(context.owner, context.batchId);
  }

  #resolveBatchRuntime(
    context: LocalSubtitleJobTaskExecutionContext,
  ): ProductionBatchRuntimeRecord | undefined {
    const record = this.#batchRuntimes.get(context.batchRuntime);
    if (
      !record?.active ||
      record.signal.aborted ||
      record.batchId !== context.batchId ||
      record.owner.webContentsId !== context.owner.webContentsId ||
      record.owner.ownerSessionId !== context.owner.ownerSessionId ||
      record.config !== context.config ||
      record.managedModel !== context.managedModel ||
      record.managedVad !== context.managedVad ||
      record.admittedRuntimeGeneration !== context.admittedRuntimeGeneration ||
      record.backendResolution !== context.backendResolution
    ) {
      return undefined;
    }
    return record;
  }

  async #ensureBatchRuntimePin(
    record: ProductionBatchRuntimeRecord,
    runtime: LocalSubtitleVerifiedRuntimeBundle,
    serverArtifactId: string,
    acceleratorPack: LocalSubtitleVerifiedAcceleratorPack | undefined,
    signal: AbortSignal,
  ): Promise<LocalSubtitleServerRuntimePin> {
    if (signal.aborted) throw new ExecutionCancelled();
    if (!record.active || record.signal.aborted) {
      throw createLocalSubtitleError(
        "owner_released",
        "The local subtitle batch runtime was released.",
        { stage: "loading_model" },
      );
    }
    const requestedIdentity = snapshotPinnedServerRuntimeIdentity(
      runtime,
      record.backendResolution,
      record.managedModel,
      record.managedVad,
      acceleratorPack,
    );
    if (
      record.pinnedIdentity &&
      !samePinnedServerRuntimeIdentity(record.pinnedIdentity, requestedIdentity)
    ) {
      throw createLocalSubtitleError(
        "media_runtime_invalid",
        "The bundled runtime changed while the batch runtime was pinned.",
        { stage: "loading_model" },
      );
    }
    if (record.pin) {
      return record.pin;
    }
    if (!record.pinOperation) {
      record.pinnedIdentity = requestedIdentity;
      let acquired: Promise<LocalSubtitleServerRuntimePin>;
      try {
        const common = {
          purpose: "inference" as const,
          verifiedRuntime: runtime,
          serverArtifactId,
          model: record.managedModel,
          ...(record.managedVad === undefined
            ? {}
            : { vadModel: record.managedVad }),
          threads: this.#cpuThreads,
        };
        acquired = record.backendResolution.resolvedBackend === "cuda"
          ? this.#supervisor.acquireBatchRuntimePin(
              record.owner,
              record.batchId,
              {
                ...common,
                backend: "cuda",
                acceleratorPack: acceleratorPack!,
              },
              record.signal,
            )
          : this.#supervisor.acquireBatchRuntimePin(
              record.owner,
              record.batchId,
              {
                ...common,
                backend: record.backendResolution.resolvedBackend,
              },
              record.signal,
            );
      } catch (error) {
        record.pinnedIdentity = undefined;
        throw error;
      }
      let operation!: Promise<LocalSubtitleServerRuntimePin>;
      operation = acquired
        .then((pin) => {
          if (!record.active || record.signal.aborted) {
            this.#supervisor.releaseBatchRuntimePin(pin);
            throw createLocalSubtitleError(
              "owner_released",
              "The local subtitle batch runtime was released during startup.",
              { stage: "loading_model" },
            );
          }
          record.pin = pin;
          return pin;
        })
        .catch((error: unknown) => {
          if (record.pinOperation === operation && !record.pin) {
            record.pinnedIdentity = undefined;
          }
          throw error;
        })
        .finally(() => {
          if (record.pinOperation === operation) record.pinOperation = undefined;
        });
      record.pinOperation = operation;
      void operation.catch(() => undefined);
    }
    const operation = record.pinOperation;
    return waitForBatchPin(operation, signal);
  }
}

function waitForBatchPin(
  operation: Promise<LocalSubtitleServerRuntimePin>,
  signal: AbortSignal,
): Promise<LocalSubtitleServerRuntimePin> {
  if (signal.aborted) return Promise.reject(new ExecutionCancelled());
  return new Promise<LocalSubtitleServerRuntimePin>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new ExecutionCancelled()));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (pin) => finish(() => resolve(pin)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function snapshotPinnedServerRuntimeIdentity(
  runtime: LocalSubtitleVerifiedRuntimeBundle,
  resolution: LocalSubtitleVerifiedBackendResolution,
  managedModel: LocalSubtitleJobBatchExecutionContext["managedModel"],
  managedVad: LocalSubtitleJobBatchExecutionContext["managedVad"],
  acceleratorPack: LocalSubtitleVerifiedAcceleratorPack | undefined,
): PinnedServerRuntimeIdentity {
  const artifact = resolution.serverArtifact;
  if (
    resolution.resolvedBackend !== "cuda" &&
    !runtime.artifactPaths[artifact.id]
  ) {
    throw createLocalSubtitleError(
      "runtime_protocol_mismatch",
      "The selected local inference server artifact is missing.",
      { stage: "loading_model" },
    );
  }
  return Object.freeze({
    runtimeRoot: runtime.root,
    runtimeGeneration: runtime.runtimeGeneration,
    targetPlatform: runtime.target.platform,
    targetArch: runtime.target.arch,
    serverArtifact: Object.freeze({
      id: artifact.id,
      kind: artifact.kind,
      backend: artifact.backend,
      absolutePath: artifact.absolutePath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      version: artifact.version,
      signatureKind: artifact.signatureKind,
    }),
    managedModel: Object.freeze({ ...managedModel }),
    ...(managedVad === undefined
      ? {}
      : { managedVad: Object.freeze({ ...managedVad }) }),
    ...(acceleratorPack === undefined ? {} : { acceleratorPack }),
  });
}

function samePinnedServerRuntimeIdentity(
  current: PinnedServerRuntimeIdentity,
  requested: PinnedServerRuntimeIdentity,
): boolean {
  const left = current.serverArtifact;
  const right = requested.serverArtifact;
  return (
    current.runtimeRoot === requested.runtimeRoot &&
    current.runtimeGeneration === requested.runtimeGeneration &&
    current.targetPlatform === requested.targetPlatform &&
    current.targetArch === requested.targetArch &&
    left.id === right.id &&
    left.kind === right.kind &&
    left.backend === right.backend &&
    left.absolutePath === right.absolutePath &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    left.version === right.version &&
    left.signatureKind === right.signatureKind &&
    sameManagedResourceIdentity(current.managedModel, requested.managedModel) &&
    sameOptionalManagedResourceIdentity(current.managedVad, requested.managedVad) &&
    samePinnedAcceleratorPack(
      current.acceleratorPack,
      requested.acceleratorPack,
    )
  );
}

function sameManagedResourceIdentity(
  current: LocalSubtitleJobBatchExecutionContext["managedModel"],
  requested: LocalSubtitleJobBatchExecutionContext["managedModel"],
): boolean {
  return (
    current.storage === requested.storage &&
    current.id === requested.id &&
    current.absolutePath === requested.absolutePath &&
    current.byteSize === requested.byteSize &&
    current.sha256 === requested.sha256
  );
}

function sameOptionalManagedResourceIdentity(
  current: LocalSubtitleJobBatchExecutionContext["managedVad"],
  requested: LocalSubtitleJobBatchExecutionContext["managedVad"],
): boolean {
  if (current === undefined || requested === undefined) {
    return current === requested;
  }
  return sameManagedResourceIdentity(current, requested);
}

function samePinnedAcceleratorPack(
  current: LocalSubtitleVerifiedAcceleratorPack | undefined,
  requested: LocalSubtitleVerifiedAcceleratorPack | undefined,
): boolean {
  if (!current || !requested) return current === requested;
  return matchesLocalSubtitleVerifiedAcceleratorPack(current, requested);
}

function createInferenceRequest(
  context: LocalSubtitleJobTaskExecutionContext,
  resolved: LocalSubtitleResolvedPcmWindow,
  requestGeneration: number,
  qualityRecoveryAttempt = 0,
  separatorCandidate = false,
): LocalSubtitleServerInferenceRequest {
  const configuredTemperature = context.config.inference.advanced.temperature;
  const temperature =
    qualityRecoveryAttempt === 0
      ? configuredTemperature
      : Math.min(
          1,
          Math.max(
            LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.qualityRecoveryTemperatureStep,
            configuredTemperature +
              qualityRecoveryAttempt *
                LOCAL_SUBTITLE_PRODUCTION_EXECUTOR_POLICY.qualityRecoveryTemperatureStep,
          ),
        );
  return Object.freeze({
    requestGeneration,
    filePath: resolved.filePath,
    expectedFileIdentity: Object.freeze({
      objectIdentity: Object.freeze({ ...resolved.fileIdentity.objectIdentity }),
      size: resolved.fileIdentity.size,
      mtimeMs: resolved.fileIdentity.mtimeMs,
      ctimeMs: resolved.fileIdentity.ctimeMs,
    }),
    language: context.config.language,
    taskMode: context.config.taskMode,
    beamSize: context.config.inference.advanced.beamSize,
    temperature,
    vadEnabled: separatorCandidate ? false : context.config.inference.vad.enabled,
    vadMinSilenceMs: context.config.inference.advanced.vadMinSilenceMs,
    ...(!separatorCandidate && context.config.inference.vad.enabled && resolved.quietAudioGainDb !== undefined
      ? {vadSpeechPadMs: 1000 as const} : {}),
    ...(context.config.inference.advanced.initialPrompt === undefined
      ? {}
      : { initialPrompt: context.config.inference.advanced.initialPrompt }),
    signal: context.signal,
  });
}

function assertWindowBrand(
  brand: LocalSubtitleBrandedPcmWindow,
  window: LocalSubtitlePostProcessingWindow,
  context: LocalSubtitleJobTaskExecutionContext,
  normalizationId: string,
  consumed: WeakSet<object>,
  validate: (window: LocalSubtitleBrandedPcmWindow) => boolean,
): void {
  if (
    typeof brand !== "object" ||
    brand === null ||
    !Object.isFrozen(brand) ||
    !validate(brand) ||
    consumed.has(brand) ||
    brand.taskId !== context.taskId ||
    brand.taskGeneration !== context.generation ||
    brand.normalizationId !== normalizationId ||
    !sameWindowDescriptor(brand.descriptor, window)
  ) {
    throw createLocalSubtitleError(
      "media_changed",
      "The normalized inference window binding is invalid.",
      { stage: "transcribing" },
    );
  }
  consumed.add(brand);
}

function assertResolvedWindowMatchesBrand(
  brand: LocalSubtitleBrandedPcmWindow,
  resolved: LocalSubtitleResolvedPcmWindow,
): void {
  if (
    !path.isAbsolute(resolved.filePath) ||
    resolved.byteSize !== brand.byteSize ||
    resolved.sha256 !== brand.sha256 ||
    resolved.quietAudioGainDb !== brand.quietAudioGainDb ||
    resolved.fileIdentity.size !== brand.byteSize
  ) {
    throw createLocalSubtitleError(
      "media_changed",
      "The normalized inference window proof changed before dispatch.",
      { stage: "transcribing" },
    );
  }
}

function assertSameResolvedWindow(
  before: LocalSubtitleResolvedPcmWindow,
  after: LocalSubtitleResolvedPcmWindow,
): void {
  if (
    before.filePath !== after.filePath ||
    before.byteSize !== after.byteSize ||
    before.sha256 !== after.sha256 ||
    before.quietAudioGainDb !== after.quietAudioGainDb ||
    !sameFileIdentity(before.fileIdentity, after.fileIdentity)
  ) {
    throw createLocalSubtitleError(
      "media_changed",
      "The normalized inference window proof changed during dispatch.",
      { stage: "transcribing" },
    );
  }
}

function bindAttempt(input: {
  readonly window: LocalSubtitlePostProcessingWindow;
  readonly windowAttempt: number;
  readonly requestGeneration: number;
  readonly inference: LocalSubtitleServerSupervisorInferenceResponse;
  readonly consumedResponses: Set<string>;
}): LocalSubtitlePostProcessingWindowAttempt {
  const { inference, requestGeneration } = input;
  if (
    !Number.isSafeInteger(inference.processEpoch) ||
    inference.processEpoch < 1 ||
    inference.response.requestGeneration !== requestGeneration
  ) {
    throw createLocalSubtitleError(
      "runtime_protocol_mismatch",
      "The local inference response crossed a stale dispatch boundary.",
      { stage: "transcribing" },
    );
  }
  const responseKey = `${inference.processEpoch}:${requestGeneration}`;
  if (input.consumedResponses.has(responseKey)) {
    throw createLocalSubtitleError(
      "runtime_protocol_mismatch",
      "The local inference response identity was reused.",
      { stage: "transcribing" },
    );
  }
  input.consumedResponses.add(responseKey);
  const response = deepFreeze(structuredClone(inference.response));
  return deepFreeze({
    window: input.window,
    windowAttempt: input.windowAttempt,
    processEpoch: inference.processEpoch,
    requestGeneration,
    response,
  });
}

function reserveRetainedRawResponse(
  response: LocalSubtitleServerSupervisorInferenceResponse["response"],
  usage: LocalSubtitleRetainedRawUsage,
  budget: LocalSubtitleRetainedRawBudget,
): void {
  const segmentCount = response.result.segments.length;
  if (segmentCount > budget.maxSegments - usage.segments) {
    throw createLocalSubtitleError(
      "limit_exceeded",
      "The local subtitle raw response segment budget was exceeded.",
      { stage: "transcribing" },
    );
  }

  let responseTextBytes = Buffer.byteLength(response.result.text, "utf8");
  if (responseTextBytes > budget.maxTextBytes - usage.textBytes) {
    throw createLocalSubtitleError(
      "limit_exceeded",
      "The local subtitle raw response text budget was exceeded.",
      { stage: "transcribing" },
    );
  }
  for (const segment of response.result.segments) {
    const segmentBytes = Buffer.byteLength(segment.text, "utf8");
    if (segmentBytes > budget.maxTextBytes - usage.textBytes - responseTextBytes) {
      throw createLocalSubtitleError(
        "limit_exceeded",
        "The local subtitle raw response text budget was exceeded.",
        { stage: "transcribing" },
      );
    }
    responseTextBytes += segmentBytes;
  }

  usage.segments += segmentCount;
  usage.textBytes += responseTextBytes;
}

function mapExportResult(
  result: LocalSubtitleExportResult,
  durationMs: number | undefined,
  cancellationRequested: boolean,
): LocalSubtitleJobTaskExecutionResult {
  if (result.status === "completed") {
    return Object.freeze({
      status: "completed",
      artifactResults: result.artifactResults,
      durationMs,
    });
  }
  if (result.status === "cancelled") {
    return Object.freeze({
      status: "cancelled",
      artifactResults: result.artifactResults,
      durationMs,
    });
  }
  const artifactResults = Object.freeze(
    result.artifactResults.map((artifact) =>
      artifact.status === "failed"
        ? Object.freeze({
            ...artifact,
            errorCode: normalizeCleanupErrorCode(
              artifact.errorCode,
              cancellationRequested,
            ),
          })
        : artifact
    ),
  );
  const failedCodes = artifactResults.flatMap((artifact) =>
    artifact.status === "failed" ? [artifact.errorCode] : []
  );
  const code = failedCodes.find(isCleanupFailureCode) ??
    failedCodes[0] ??
    "output_write_failed";
  return Object.freeze({
    status: "failed",
    error: createLocalSubtitleError(code, "The subtitle artifact export failed.", {
      stage: isCleanupFailureCode(code)
        ? "cleanup"
        : LOCAL_SUBTITLE_ERROR_MANIFEST[code].defaultStage,
    }),
    artifactResults,
    durationMs,
  });
}

function failedResult(
  code: LocalSubtitleErrorCode,
  stage: LocalSubtitleOperationStage,
  durationMs?: number,
  cause?: unknown,
): LocalSubtitleJobTaskExecutionResult {
  const qualityFailure = qualityFailurePresentation(code, cause);
  return Object.freeze({
    status: "failed",
    error: createLocalSubtitleError(
      code,
      qualityFailure?.message ?? "The local subtitle task failed.",
      {
        stage,
        ...(qualityFailure?.details === undefined
          ? {}
          : { details: qualityFailure.details }),
      },
    ),
    artifactResults: [],
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function qualityFailurePresentation(
  code: LocalSubtitleErrorCode,
  cause: unknown,
):
  | Readonly<{
      message: string;
      details: LocalSubtitleDiagnostics;
    }>
  | undefined {
  if (code !== "transcript_quality_failed") return undefined;

  const failure = snapshotQualityFailure(cause);
  if (!failure) {
    const internal = snapshotInternalFailure(cause);
    return Object.freeze({
      message:
        "Local transcript post-processing failed before a safe subtitle could be exported.",
      details: Object.freeze({
        summary:
          "An internal post-processing error was caught after transcription. The source media was not modified; retrying alone may not resolve this error.",
        lines: Object.freeze([
          `internal_error_type=${internal.type}`,
          `internal_error_message=${internal.message}`,
        ]),
        truncated: internal.truncated,
      }),
    });
  }

  const lines = [
    `post_processing_stage=${failure.stage}`,
    ...(failure.reason === undefined ? [] : [`reason=${failure.reason}`]),
    ...(failure.issues.length
      ? [`quality_issues=${failure.issues.join(",")}`]
      : []),
    ...(failure.windowStartMs === undefined ||
    failure.windowEndMs === undefined
      ? []
      : [
          `window=${formatDiagnosticSeconds(failure.windowStartMs)}-${formatDiagnosticSeconds(failure.windowEndMs)}`,
        ]),
    ...(failure.retryDepth === undefined
      ? []
      : [`split_retry_depth=${failure.retryDepth}`]),
    ...(failure.qualityRecoveryAttempts === undefined ||
    failure.maxQualityRecoveryAttempts === undefined
      ? []
      : [
          `automatic_quality_replays=${failure.qualityRecoveryAttempts}/${failure.maxQualityRecoveryAttempts}`,
        ]),
    ...(failure.rawSegmentCount === undefined
      ? []
      : [
          `raw_segments=${failure.rawSegmentCount}`,
          `unique_normalized_texts=${failure.normalizedUniqueTextCount}`,
          `longest_repeated_run=${failure.longestConsecutiveRepeatCueCount} cues / ${failure.longestConsecutiveRepeatSpanMs} ms`,
        ]),
  ];
  const metadata: NonNullable<LocalSubtitleDiagnostics["metadata"]> = {
    ...(failure.windowAttempt === undefined
      ? {}
      : { attempt: failure.windowAttempt }),
    ...(failure.maxQualityRecoveryAttempts === undefined
      ? {}
      : { maxAttempts: failure.maxQualityRecoveryAttempts + 1 }),
    ...(failure.rawSegmentCount === undefined
      ? {}
      : { observed: failure.rawSegmentCount }),
    ...(failure.limit === undefined ? {} : { limit: failure.limit }),
  };
  return Object.freeze({
    message:
      "Local transcription remained unstable after automatic quality recovery. No unreliable subtitle file was exported.",
    details: Object.freeze({
      summary:
        "The quality guard rejected a repeated or malformed transcript window after bounded automatic recovery. You can retry the task; the source media was not modified.",
      lines: Object.freeze(lines),
      metadata: Object.freeze(metadata),
      truncated: false,
    }),
  });
}

interface QualityFailureSnapshot {
  readonly stage: string;
  readonly reason?: string;
  readonly issues: readonly string[];
  readonly windowStartMs?: number;
  readonly windowEndMs?: number;
  readonly retryDepth?: number;
  readonly qualityRecoveryAttempts?: number;
  readonly maxQualityRecoveryAttempts?: number;
  readonly windowAttempt?: number;
  readonly limit?: number;
  readonly rawSegmentCount?: number;
  readonly normalizedUniqueTextCount?: number;
  readonly longestConsecutiveRepeatCueCount?: number;
  readonly longestConsecutiveRepeatSpanMs?: number;
}

function snapshotQualityFailure(cause: unknown): QualityFailureSnapshot | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const record = cause as Record<string, unknown>;
  if (
    !(cause instanceof LocalSubtitlePostProcessorError) &&
    record.name !== "LocalSubtitlePostProcessorError" &&
    record.localSubtitleCode !== "transcript_quality_failed"
  ) {
    return undefined;
  }
  const details =
    typeof record.details === "object" && record.details !== null
      ? record.details as Record<string, unknown>
      : undefined;
  const assessment =
    typeof details?.assessment === "object" && details.assessment !== null
      ? details.assessment as Record<string, unknown>
      : undefined;
  const issues = Array.isArray(assessment?.issues)
    ? assessment.issues.filter((value): value is string => typeof value === "string")
    : [];
  return Object.freeze({
    stage: typeof record.stage === "string" ? record.stage : "unknown",
    ...(typeof details?.reason === "string"
      ? { reason: diagnosticText(details.reason).value }
      : {}),
    issues: Object.freeze(issues.map((value) => diagnosticText(value).value)),
    ...optionalDiagnosticNumber(details, "windowStartMs"),
    ...optionalDiagnosticNumber(details, "windowEndMs"),
    ...optionalDiagnosticNumber(details, "retryDepth"),
    ...optionalDiagnosticNumber(details, "qualityRecoveryAttempts"),
    ...optionalDiagnosticNumber(details, "maxQualityRecoveryAttempts"),
    ...optionalDiagnosticNumber(details, "windowAttempt"),
    ...optionalDiagnosticNumber(details, "limit"),
    ...optionalDiagnosticNumber(assessment, "rawSegmentCount"),
    ...optionalDiagnosticNumber(assessment, "normalizedUniqueTextCount"),
    ...optionalDiagnosticNumber(assessment, "longestConsecutiveRepeatCueCount"),
    ...optionalDiagnosticNumber(assessment, "longestConsecutiveRepeatSpanMs"),
  });
}

function optionalDiagnosticNumber(
  record: Record<string, unknown> | undefined,
  key: keyof QualityFailureSnapshot,
): Partial<QualityFailureSnapshot> {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { [key]: value }
    : {};
}

function snapshotInternalFailure(cause: unknown): Readonly<{
  type: string;
  message: string;
  truncated: boolean;
}> {
  const record =
    typeof cause === "object" && cause !== null
      ? cause as Record<string, unknown>
      : undefined;
  const type = diagnosticText(
    typeof record?.name === "string" ? record.name : typeof cause,
  );
  const message = diagnosticText(
    typeof record?.message === "string"
      ? record.message
      : "No safe internal error message was available.",
  );
  return Object.freeze({
    type: type.value,
    message: message.value,
    truncated: type.truncated || message.truncated,
  });
}

function diagnosticText(value: string): Readonly<{
  value: string;
  truncated: boolean;
}> {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const maximumLength = 300;
  return Object.freeze({
    value: normalized.slice(0, maximumLength) || "unknown",
    truncated: normalized.length > maximumLength,
  });
}

function formatDiagnosticSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function cleanupFailure(
  cause: unknown,
  cancellationRequested: boolean,
): LocalSubtitleError {
  return createLocalSubtitleError(
    cancellationRequested ? "cancel_failed" : "cleanup_failed",
    "The local subtitle task cleanup failed.",
    { stage: "cleanup", causeCode: publicErrorCode(cause, "cleanup") },
  );
}

function isCleanupFailureCode(code: LocalSubtitleErrorCode): boolean {
  return code === "cleanup_failed" || code === "cancel_failed";
}

function normalizeCleanupErrorCode(
  code: LocalSubtitleErrorCode,
  cancellationRequested: boolean,
): LocalSubtitleErrorCode {
  if (!isCleanupFailureCode(code)) return code;
  return cancellationRequested ? "cancel_failed" : "cleanup_failed";
}

function publicErrorCode(
  error: unknown,
  stage: LocalSubtitleOperationStage,
): LocalSubtitleErrorCode {
  if (typeof error === "object" && error !== null) {
    for (const key of ["localSubtitleCode", "code"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && isLocalSubtitleErrorCode(value)) {
        return value;
      }
    }
  }
  if (stage === "preparing_media") return "media_decode_failed";
  if (stage === "loading_model") return "runtime_missing";
  if (stage === "transcribing") return "transcription_failed";
  if (stage === "post_processing") return "transcript_quality_failed";
  if (stage === "exporting") return "output_write_failed";
  return "cleanup_failed";
}

function outputStem(displayName: string, taskId: string): string {
  const parsed = path.parse(displayName).name
    .replace(/[\\/:\u0000-\u001f\u007f]/gu, "_")
    .trim();
  const fallback = `subtitle-${taskId}`;
  const source = parsed && parsed !== "." && parsed !== ".." ? parsed : fallback;
  const bounded = boundOutputStem(source) || boundOutputStem(fallback);
  return RESERVED_WINDOWS_OUTPUT_STEM.test(bounded)
    ? boundOutputStem(`_${bounded}`)
    : bounded;
}

function boundOutputStem(source: string): string {
  let result = "";
  for (const character of Array.from(source)) {
    const candidate = `${result}${character}`;
    if (
      candidate.length > LOCAL_SUBTITLE_LIMITS.maxDisplayNameChars ||
      Buffer.byteLength(`${candidate}.srt`, "utf8") > 255
    ) {
      break;
    }
    result = candidate;
  }
  return result;
}

function isSupportedBatchExecutionContext(
  context: LocalSubtitleJobBatchExecutionContext,
  supportsConflictPolicy: (policy: LocalSubtitleConflictPolicy) => boolean,
): boolean {
  return (
    typeof context === "object" &&
    context !== null &&
    typeof context.batchId === "string" &&
    context.batchId.length > 0 &&
    context.batchId.length <= LOCAL_SUBTITLE_LIMITS.maxIdChars &&
    typeof context.owner === "object" &&
    context.owner !== null &&
    Number.isSafeInteger(context.owner.webContentsId) &&
    typeof context.owner.ownerSessionId === "string" &&
    typeof context.admittedRuntimeGeneration === "string" &&
    /^[a-f0-9]{64}$/u.test(context.admittedRuntimeGeneration) &&
    typeof context.signal?.aborted === "boolean" &&
    typeof context.managedModel === "object" &&
    context.managedModel !== null &&
    typeof context.config === "object" &&
    context.config !== null &&
    context.managedModel.storage === "managed" &&
    context.managedModel.id === context.config.model.modelId &&
    context.managedModel.sha256 === context.config.model.modelHash &&
    isSupportedManagedVadContext(context) &&
    isSupportedBackendResolutionContext(context) &&
    (context.config.output.mode === "custom" ||
      context.config.output.mode === "source") &&
    supportsConflictPolicy(context.config.output.conflictPolicy) &&
    isSupportedProductionFormats(context.config.output.formats) &&
    isSupportedProductionTaskMode(context.config.taskMode)
  );
}

function isSupportedExecutionContext(
  context: LocalSubtitleJobTaskExecutionContext,
  supportsConflictPolicy: (policy: LocalSubtitleConflictPolicy) => boolean,
): boolean {
  return (
    (context.config.output.mode === "custom" ||
      context.config.output.mode === "source") &&
    supportsConflictPolicy(context.config.output.conflictPolicy) &&
    isSupportedProductionFormats(context.config.output.formats) &&
    isSupportedBackendResolutionContext(context) &&
    isSupportedManagedVadContext(context) &&
    isSupportedProductionTaskMode(context.config.taskMode)
  );
}

function isSupportedProductionTaskMode(
  taskMode: LocalSubtitleJobTaskExecutionContext["config"]["taskMode"],
): boolean {
  return taskMode === "transcribe" || taskMode === "translate_to_english";
}

function isSupportedManagedVadContext(
  context: Pick<
    LocalSubtitleJobBatchExecutionContext,
    "config" | "managedVad"
  >,
): boolean {
  const managedVad = context.managedVad;
  if (!context.config.inference.vad.enabled) return managedVad === undefined;
  return (
    managedVad !== undefined &&
    managedVad.storage === "managed" &&
    managedVad.id === context.config.inference.vad.modelId &&
    managedVad.id === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id &&
    managedVad.sha256 === LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256 &&
    Number.isSafeInteger(managedVad.byteSize) &&
    managedVad.byteSize > 0 &&
    typeof managedVad.absolutePath === "string" &&
    managedVad.absolutePath.length > 0
  );
}

function isSupportedBackendResolutionContext(
  context: Pick<
    LocalSubtitleJobBatchExecutionContext,
    | "backendResolution"
    | "config"
    | "managedModel"
    | "admittedRuntimeGeneration"
  >,
): boolean {
  const resolution = context.backendResolution;
  return (
    isLocalSubtitleVerifiedBackendResolution(resolution) &&
    (context.config.devicePreference === "auto" ||
      context.config.devicePreference === "cpu" ||
      context.config.devicePreference === "cuda" ||
      context.config.devicePreference === "metal") &&
    resolution.devicePreference === context.config.devicePreference &&
    (resolution.resolvedBackend === "cpu" ||
      resolution.resolvedBackend === "cuda" ||
      resolution.resolvedBackend === "metal") &&
    (resolution.resolvedBackend === "cpu"
      ? context.config.devicePreference === "auto" ||
        context.config.devicePreference === "cpu"
      : resolution.resolvedBackend === "cuda"
        ? context.config.devicePreference === "auto" ||
          context.config.devicePreference === "cuda"
        : context.config.devicePreference === "auto" ||
          context.config.devicePreference === "metal") &&
    resolution.resolvedBackend === context.config.resolvedBackend &&
    resolution.runtimeGeneration === context.admittedRuntimeGeneration &&
    resolution.model.id === context.managedModel.id &&
    resolution.model.sha256 === context.managedModel.sha256
  );
}

function isSupportedProductionFormats(
  formats: readonly LocalSubtitleFormat[],
): boolean {
  return formats.length > 0 &&
    formats.length <= 2 &&
    new Set(formats).size === formats.length &&
    formats.every((format) => format === "SRT" || format === "LRC");
}

function sameWindowDescriptor(
  left: LocalSubtitleMediaStructuralWindow,
  right: LocalSubtitlePostProcessingWindow,
): boolean {
  return (
    left.windowKey === right.windowKey &&
    left.rootPlanId === right.rootPlanId &&
    left.rootWindowKey === right.rootWindowKey &&
    left.parentWindowKey === right.parentWindowKey &&
    left.retryDepth === right.retryDepth &&
    left.startFrame === right.startFrame &&
    left.endFrame === right.endFrame &&
    left.coreStartFrame === right.coreStartFrame &&
    left.coreEndFrame === right.coreEndFrame &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.coreStartMs === right.coreStartMs &&
    left.coreEndMs === right.coreEndMs
  );
}

function sameFileIdentity(
  left: LocalSubtitleResolvedPcmWindow["fileIdentity"],
  right: LocalSubtitleResolvedPcmWindow["fileIdentity"],
): boolean {
  return sameLocalSubtitleFileIdentity(left, right);
}

function sameDirectoryIdentity(
  left: LocalSubtitleDirectoryIdentity,
  right: LocalSubtitleDirectoryIdentity,
): boolean {
  return sameLocalSubtitleFilesystemObjectIdentity(left, right);
}

function incrementSafeCounter(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw createLocalSubtitleError(
      "limit_exceeded",
      `The local subtitle ${field} counter is exhausted.`,
      { stage: "transcribing" },
    );
  }
  return value + 1;
}

function isPositiveSafeIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function boundedPercentage(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.floor(value)))
    : 0;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExecutionCancelled();
}

class ExecutionCancelled extends Error {
  readonly name = "ExecutionCancelled";
}

class SeparatorCandidateUnavailable extends Error {
  readonly name = "SeparatorCandidateUnavailable";
}

function hasMethods(
  value: unknown,
  methods: readonly string[],
): value is Record<string, (...args: never[]) => unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every(
      (method) => typeof (value as Record<string, unknown>)[method] === "function",
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
