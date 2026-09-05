import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LOCAL_SUBTITLE_LIMITS,
  LOCAL_SUBTITLE_PRODUCTION_CONTRACT,
  type LocalSubtitleErrorCode,
  type LocalSubtitleOperationStage,
} from "@/type/localSubtitle";
import type { LocalSubtitleMediaProbeSummary } from "@/type/localSubtitleIpc";
import {
  LocalSubtitleInputAuthorizationRegistry,
  type LocalSubtitleFileIdentity,
  type LocalSubtitleOwnerKey,
  type ResolvedLocalSubtitleInput,
} from "./authorizations";
import {
  buildLocalSubtitleMediaEnvironment,
  runLocalSubtitleMediaProcess,
  type LocalSubtitleMediaProcessRequest,
  type LocalSubtitleMediaProcessResult,
} from "./media-process";
import {
  LocalSubtitlePcmWindowError,
  inspectLocalSubtitlePcm16Wav,
  writeLocalSubtitlePcmWindow,
  type LocalSubtitlePcm16WavMetadata,
} from "./pcm-window";
import {
  localSubtitleFileIdentityForHandle,
  localSubtitleFileIdentityForPath,
  sameLocalSubtitleInputFileIdentity as sameInputFileIdentity,
  sameLocalSubtitleFileIdentity as sameFileIdentity,
} from "./filesystem-object-identity";
import {
  isLocalSubtitleVerifiedRuntimeBundle,
  verifyLocalSubtitleRuntimeBundle,
  type LocalSubtitleResourceEnvironment,
  type LocalSubtitleSignatureVerifier,
  type LocalSubtitleVerifiedRuntimeArtifact,
  type LocalSubtitleVerifiedRuntimeBundle,
} from "./resource-path";

const READ_ONLY_NOFOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MEDIA_SESSION_PREFIX = "media-";
const CLEANUP_MARKER = ".cleanup-";
const NORMALIZED_PCM_PROOFS = new WeakMap<
  LocalSubtitleNormalizedPcm,
  NormalizedPcmRecord
>();
const WINDOW_PROOFS = new WeakMap<
  LocalSubtitleBrandedPcmWindow,
  PcmWindowRecord
>();
const OWNER_RELEASED_ABORT_REASON = Symbol(
  "fusionkit.local-subtitle.media-owner-released",
);
const OWNER_FAULTED_ABORT_REASON = Symbol(
  "fusionkit.local-subtitle.media-owner-faulted",
);

export const LOCAL_SUBTITLE_MEDIA_POLICY = deepFreeze({
  schemaVersion: 1,
  mediaRuntimeVersions: {
    darwin: "8.1.2",
    win32: "n8.1.2-21-gce3c09c101-20260630",
  },
  sampleRateHz: 16_000,
  channels: 1,
  bitsPerSample: 16,
  probeTimeoutMs: 30_000,
  runtimeProbeTimeoutMs: 15_000,
  minimumDecodeTimeoutMs: 120_000,
  maximumDecodeTimeoutMs: 12 * 60 * 60 * 1_000,
  decodeTimeoutRatio: 2,
  maxProbeStdoutBytes: 1024 * 1024,
  maxDiagnosticBytes: 64 * 1024,
  maxProbeMetadataBytes: 128 * 1024,
  maxProbeRecordsPerOwner: LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs,
  maxConcurrentOperationsPerOwner: 1,
  maxPendingOperationsPerOwner: 8,
  diskReserveBytes: 64 * 1024 * 1024,
  decodeDurationToleranceMs: 2_000,
  decodeLimitSentinelMs: 1_000,
  maxNormalizedWavHeaderBytes: 4_096,
  inputCopyProgressMaximum: 10,
  decodeProgressMaximum: 99,
  normalizedLeaf: "normalized.wav",
  sourceSnapshotLeaf: "source.snapshot",
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 200,
  noPathFallback: true,
} as const);

export type LocalSubtitleMediaErrorCode =
  | "invalid_configuration"
  | "runtime_launch_failed"
  | "probe_failed"
  | "no_audio_stream"
  | "media_changed"
  | "decode_failed"
  | "unsupported_media"
  | "limit_exceeded"
  | "resource_busy"
  | "insufficient_disk"
  | "aborted"
  | "timeout"
  | "cleanup_failed";

export class LocalSubtitleMediaError extends Error {
  readonly name = "LocalSubtitleMediaError";

  constructor(
    readonly code: LocalSubtitleMediaErrorCode,
    readonly localSubtitleCode: LocalSubtitleErrorCode,
    readonly stage: LocalSubtitleOperationStage,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

export interface LocalSubtitleMediaStructuralWindow {
  readonly windowKey: string;
  readonly rootPlanId: string;
  readonly rootWindowKey: string;
  readonly parentWindowKey?: string;
  readonly retryDepth: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly coreStartFrame: number;
  readonly coreEndFrame: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly coreStartMs: number;
  readonly coreEndMs: number;
}

export interface LocalSubtitleNormalizedPcm {
  readonly schemaVersion: 1;
  readonly normalizationId: string;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly displayName: string;
  readonly runtimeGeneration: string;
  readonly selectedStreamId: string;
  readonly sampleRateHz: 16_000;
  readonly channels: 1;
  readonly bitsPerSample: 16;
  readonly totalFrames: number;
  readonly durationMs: number;
  readonly dataSizeBytes: number;
}

export interface LocalSubtitleBrandedPcmWindow {
  readonly quietAudioGainDb?: number;
  readonly schemaVersion: 1;
  readonly windowId: string;
  readonly normalizationId: string;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly descriptor: LocalSubtitleMediaStructuralWindow;
  readonly frameCount: number;
  readonly durationMs: number;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface LocalSubtitleResolvedPcmWindow {
  readonly quietAudioGainDb?: number;
  readonly filePath: string;
  readonly fileIdentity: LocalSubtitleFileIdentity;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface LocalSubtitleMediaNormalizerOptions {
  readonly environment: LocalSubtitleResourceEnvironment;
  readonly managedResourceRoot: string;
  readonly inputAuthorizations: LocalSubtitleInputAuthorizationRegistry;
  readonly processRunner?: LocalSubtitleMediaCommandRunner;
  readonly signatureVerifier?: LocalSubtitleSignatureVerifier;
  readonly tokenFactory?: () => string;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly availableBytes?: (directory: string) => Promise<number>;
}

export type LocalSubtitleMediaCommandRunner = (
  request: LocalSubtitleMediaProcessRequest,
) => Promise<LocalSubtitleMediaProcessResult>;

export interface ProbeLocalSubtitleMediaOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly fileToken: string;
  readonly signal?: AbortSignal;
}

export interface VerifyLocalSubtitleMediaRuntimeOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly signal?: AbortSignal;
}

export interface LocalSubtitleMediaRuntimeVerification {
  readonly runtimeGeneration: string;
}

export interface NormalizeLocalSubtitleMediaOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly fileToken: string;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly audioStreamId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (percentage: number) => void;
}

export interface BindLocalSubtitleTaskMediaSelectionOptions {
  readonly owner: LocalSubtitleOwnerKey;
  readonly fileToken: string;
  readonly taskId: string;
  readonly audioStreamId: string;
  readonly inputIdentity: LocalSubtitleFileIdentity;
  readonly runtimeGeneration: string;
}

export interface MaterializeLocalSubtitlePcmWindowOptions {
  readonly conditionQuietAudio?: boolean;
  readonly normalized: LocalSubtitleNormalizedPcm;
  readonly descriptor: LocalSubtitleMediaStructuralWindow;
  readonly signal?: AbortSignal;
}

interface MediaTools {
  readonly bundle: LocalSubtitleVerifiedRuntimeBundle;
  readonly ffmpeg: LocalSubtitleVerifiedRuntimeArtifact;
  readonly ffprobe: LocalSubtitleVerifiedRuntimeArtifact;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly workingDirectory: string;
}

interface RawAudioTrack {
  readonly streamIndex: number;
  readonly ordinal: number;
  readonly isDefault: boolean;
  readonly language?: string;
  readonly title?: string;
  readonly codec?: string;
  readonly channels?: number;
  readonly sampleRateHz?: number;
  readonly signature: string;
}

interface ParsedMediaProbe {
  readonly durationMs: number;
  readonly tracks: readonly RawAudioTrack[];
  readonly autoSelectedOrdinal: number;
}

interface ProbeRecord {
  readonly ownerKey: string;
  readonly fileToken: string;
  readonly inputIdentity: LocalSubtitleFileIdentity;
  readonly runtimeGeneration: string;
  readonly durationMs: number;
  readonly trackTableSignature: string;
  readonly tracks: readonly (RawAudioTrack & { readonly streamId: string })[];
}

interface TaskTrackSelectionRecord {
  readonly ownerKey: string;
  readonly fileToken: string;
  readonly taskId: string;
  readonly inputIdentity: LocalSubtitleFileIdentity;
  readonly runtimeGeneration: string;
  readonly durationMs: number;
  readonly trackTableSignature: string;
  readonly selectedTrack: RawAudioTrack & { readonly streamId: string };
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly realPath: string;
}

interface MediaSession {
  readonly baseRoot: string;
  readonly baseIdentity: DirectoryIdentity;
  readonly root: string;
  readonly rootIdentity: DirectoryIdentity;
}

interface NormalizedPcmRecord {
  readonly ownerKey: string;
  readonly session: MediaSession;
  readonly filePath: string;
  readonly fileIdentity: LocalSubtitleFileIdentity;
  readonly metadata: LocalSubtitlePcm16WavMetadata;
  readonly windows: Set<LocalSubtitleBrandedPcmWindow>;
  state: "active" | "cleaning" | "faulted" | "removed";
  cleanupPromise?: Promise<{ readonly removed: boolean }>;
}

interface PcmWindowRecord {
  readonly normalized: LocalSubtitleNormalizedPcm;
  readonly filePath: string;
  readonly fileIdentity: LocalSubtitleFileIdentity;
  readonly descriptor: LocalSubtitleMediaStructuralWindow;
  readonly sha256: string;
  state: "active" | "cleaning" | "faulted" | "removed";
  cleanupPromise?: Promise<{ readonly removed: boolean }>;
}

interface MediaOwnerState {
  status: "active" | "faulted" | "released";
  readonly controllers: Set<AbortController>;
  readonly operationSettlements: Set<Promise<void>>;
  readonly pendingOperationSettlements: Set<Promise<void>>;
  readonly processCloseConfirmations: Set<Promise<void>>;
  readonly pendingSessions: Set<MediaSession>;
  readonly sessionCleanupPromises: Map<MediaSession, Promise<void>>;
  cleanupPromise?: Promise<void>;
}

interface MediaOwnerOperation {
  readonly signal: AbortSignal;
  readonly hasUnconfirmedClose: boolean;
  trackProcess(result: LocalSubtitleMediaProcessResult): void;
  waitForClose(): Promise<void>;
  finish(): void;
}

const ffprobeResponseSchema = z
  .object({
    streams: z
      .array(
        z
          .object({
            index: z.number().int().safe().nonnegative(),
            codec_type: z.string().optional(),
            codec_name: z.string().optional(),
            channels: z.number().int().safe().positive().optional(),
            sample_rate: z.union([z.string(), z.number()]).optional(),
            duration: z.union([z.string(), z.number()]).optional(),
            disposition: z
              .object({ default: z.union([z.literal(0), z.literal(1)]).optional() })
              .passthrough()
              .optional(),
            tags: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .max(LOCAL_SUBTITLE_LIMITS.maxMediaTracks * 2),
    format: z
      .object({ duration: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class LocalSubtitleMediaNormalizer {
  readonly #environment: LocalSubtitleResourceEnvironment;
  readonly #managedResourceRoot: string;
  readonly #inputAuthorizations: LocalSubtitleInputAuthorizationRegistry;
  readonly #processRunner: LocalSubtitleMediaCommandRunner;
  readonly #signatureVerifier?: LocalSubtitleSignatureVerifier;
  readonly #tokenFactory: () => string;
  readonly #sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly #availableBytes: (directory: string) => Promise<number>;
  readonly #probeRecords = new Map<string, ProbeRecord>();
  readonly #taskTrackSelections = new Map<string, TaskTrackSelectionRecord>();
  readonly #normalizedByOwner = new Map<string, Set<LocalSubtitleNormalizedPcm>>();
  readonly #ownerStates = new Map<string, MediaOwnerState>();
  readonly #backgroundCleanup = new Set<Promise<void>>();
  #shutdownOperation: Promise<void> | undefined;
  #shutdownSucceeded = false;
  #terminalFence = false;

  constructor(options: LocalSubtitleMediaNormalizerOptions) {
    if (
      !options ||
      !options.inputAuthorizations ||
      !path.isAbsolute(options.managedResourceRoot) ||
      path.parse(options.managedResourceRoot).root ===
        path.resolve(options.managedResourceRoot)
    ) {
      throw mediaFailure(
        "invalid_configuration",
        "runtime_protocol_mismatch",
        "preflight",
        "The local subtitle media service configuration is invalid.",
      );
    }
    this.#environment = options.environment;
    this.#managedResourceRoot = path.resolve(options.managedResourceRoot);
    this.#inputAuthorizations = options.inputAuthorizations;
    this.#processRunner = options.processRunner ?? runLocalSubtitleMediaProcess;
    this.#signatureVerifier = options.signatureVerifier;
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    this.#sourceEnvironment = options.sourceEnvironment;
    this.#availableBytes = options.availableBytes ?? availableFileSystemBytes;
  }

  async verifyRuntime(
    options: VerifyLocalSubtitleMediaRuntimeOptions,
  ): Promise<LocalSubtitleMediaRuntimeVerification> {
    assertOwner(options.owner);
    const operation = await this.#beginOwnerOperation(
      ownerKey(options.owner),
      options.signal,
      "runtime_launch_failed",
    );
    try {
      const tools = await this.#attestMediaRuntime(operation);
      throwIfAborted(operation.signal, "runtime_launch_failed");
      return Object.freeze({
        runtimeGeneration: tools.bundle.runtimeGeneration,
      });
    } finally {
      operation.finish();
    }
  }

  async probeDraft(
    options: ProbeLocalSubtitleMediaOptions,
  ): Promise<LocalSubtitleMediaProbeSummary> {
    assertOwner(options.owner);
    assertOpaqueId(options.fileToken, "file token");
    const operation = await this.#beginOwnerOperation(
      ownerKey(options.owner),
      options.signal,
      "probe_failed",
    );
    try {
      throwIfAborted(operation.signal, "probe_failed");
      const input = await this.#inputAuthorizations.resolveDraft(
        options.owner,
        options.fileToken,
        "probe",
      );
      const tools = await this.#attestMediaRuntime(operation);
      await assertResolvedInputCurrent(input);
      const parsed = await this.#probePath(
        input.filePath,
        tools,
        operation,
        input.identity,
      );
      await assertResolvedInputCurrent(input);
      throwIfAborted(operation.signal, "probe_failed");
      const record = createProbeRecord({
        owner: options.owner,
        fileToken: options.fileToken,
        input,
        runtimeGeneration: tools.bundle.runtimeGeneration,
        parsed,
        tokenFactory: this.#tokenFactory,
      });
      this.#storeProbeRecord(record);
      return probeSummary(record, input.displayName);
    } finally {
      operation.finish();
    }
  }

  bindTaskMediaSelection(
    options: BindLocalSubtitleTaskMediaSelectionOptions,
  ): void {
    assertOwner(options.owner);
    assertOpaqueId(options.fileToken, "file token");
    assertOpaqueId(options.taskId, "task id");
    assertOpaqueId(options.audioStreamId, "audio stream id");
    assertOpaqueId(options.runtimeGeneration, "media runtime generation");

    const ownedBy = ownerKey(options.owner);
    const record = this.#probeRecords.get(probeKey(options.owner, options.fileToken));
    const selectedTrack = record?.tracks.find(
      (track) => track.streamId === options.audioStreamId,
    );
    if (
      !record ||
      !selectedTrack ||
      record.ownerKey !== ownedBy ||
      record.runtimeGeneration !== options.runtimeGeneration ||
      !sameFileIdentity(record.inputIdentity, options.inputIdentity)
    ) {
      throw mediaFailure(
        "media_changed",
        "media_changed",
        "preflight",
        "The selected media stream is stale or belongs to another input.",
      );
    }

    const key = taskSelectionKey(options.owner, options.taskId);
    if (this.#taskTrackSelections.has(key)) {
      throw invalidMediaConfiguration("The media task selection is already bound.");
    }
    this.#taskTrackSelections.set(key, deepFreeze({
      ownerKey: record.ownerKey,
      fileToken: record.fileToken,
      taskId: options.taskId,
      inputIdentity: { ...record.inputIdentity },
      runtimeGeneration: record.runtimeGeneration,
      durationMs: record.durationMs,
      trackTableSignature: record.trackTableSignature,
      selectedTrack,
    }));
  }

  releaseTaskMediaSelection(
    owner: LocalSubtitleOwnerKey,
    taskId: string,
  ): void {
    assertOwner(owner);
    assertOpaqueId(taskId, "task id");
    this.#taskTrackSelections.delete(taskSelectionKey(owner, taskId));
  }

  async normalizeTask(
    options: NormalizeLocalSubtitleMediaOptions,
  ): Promise<LocalSubtitleNormalizedPcm> {
    assertOwner(options.owner);
    assertOpaqueId(options.fileToken, "file token");
    assertOpaqueId(options.taskId, "task id");
    if (
      !Number.isSafeInteger(options.taskGeneration) ||
      options.taskGeneration < 1
    ) {
      throw invalidMediaConfiguration("The media task generation is invalid.");
    }
    if (
      options.audioStreamId !== undefined &&
      !isOpaqueId(options.audioStreamId)
    ) {
      throw invalidMediaConfiguration("The selected media stream is invalid.");
    }
    const ownedBy = ownerKey(options.owner);
    const operation = await this.#beginOwnerOperation(
      ownedBy,
      options.signal,
      "decode_failed",
    );
    const emitProgress = monotonicProgressReporter(options.onProgress);
    try {
      throwIfAborted(operation.signal, "decode_failed");
      const input = await this.#inputAuthorizations.resolveTaskLease(
        options.owner,
        options.taskId,
        "transcribe",
        options.fileToken,
      );
      const tools = await this.#attestMediaRuntime(operation);
      const session = await createMediaSession(this.#managedResourceRoot);
      this.#ownerStates.get(ownedBy)!.pendingSessions.add(session);
      const sourceSnapshotPath = path.join(
        session.root,
        LOCAL_SUBTITLE_MEDIA_POLICY.sourceSnapshotLeaf,
      );
      const normalizedPath = path.join(
        session.root,
        LOCAL_SUBTITLE_MEDIA_POLICY.normalizedLeaf,
      );
      let completed = false;

      try {
        await this.#assertDiskSpace(
          session.root,
          input.byteSize + LOCAL_SUBTITLE_MEDIA_POLICY.diskReserveBytes,
        );
        const sourceSnapshotIdentity = await copyAuthorizedInputSnapshot({
          input,
          outputPath: sourceSnapshotPath,
          signal: operation.signal,
          onProgress: (completedBytes) => {
            const percentage = Math.floor(
              (completedBytes / input.byteSize) *
                LOCAL_SUBTITLE_MEDIA_POLICY.inputCopyProgressMaximum,
            );
            emitProgress(percentage);
          },
        });

        const parsed = await this.#probePath(
          sourceSnapshotPath,
          tools,
          operation,
          sourceSnapshotIdentity,
        );
        const selected = this.#resolveTrackSelection({
          owner: options.owner,
          fileToken: options.fileToken,
          taskId: options.taskId,
          input,
          runtimeGeneration: tools.bundle.runtimeGeneration,
          parsed,
          audioStreamId: options.audioStreamId,
        });
        const estimatedPcmBytes = estimatePcmBytes(parsed.durationMs);
        if (estimatedPcmBytes > LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes) {
          throw mediaFailure(
            "limit_exceeded",
            "limit_exceeded",
            "preparing_media",
            "The normalized media would exceed the versioned PCM limit.",
          );
        }
        const durationLimitMs = decodeDurationLimitMs(parsed.durationMs);
        const processDurationLimitMs =
          durationLimitMs + LOCAL_SUBTITLE_MEDIA_POLICY.decodeLimitSentinelMs;
        const outputLimitBytes = decodeOutputLimitBytes(processDurationLimitMs);
        await this.#assertDiskSpace(
          session.root,
          outputLimitBytes + LOCAL_SUBTITLE_MEDIA_POLICY.diskReserveBytes,
        );
        await this.#decodeSnapshot({
          inputPath: sourceSnapshotPath,
          outputPath: normalizedPath,
          streamIndex: selected.track.streamIndex,
          durationMs: parsed.durationMs,
          processDurationLimitMs,
          outputLimitBytes,
          tools,
          operation,
          inputIdentity: sourceSnapshotIdentity,
          onProgress: emitProgress,
        });
        await assertResolvedInputCurrent(input);
        const metadata = await inspectLocalSubtitlePcm16Wav(normalizedPath);
        if (
          metadata.sampleRateHz !== LOCAL_SUBTITLE_MEDIA_POLICY.sampleRateHz ||
          metadata.channels !== LOCAL_SUBTITLE_MEDIA_POLICY.channels ||
          metadata.bitsPerSample !== LOCAL_SUBTITLE_MEDIA_POLICY.bitsPerSample
        ) {
          throw mediaFailure(
            "decode_failed",
            "media_decode_failed",
            "preparing_media",
            "The normalized PCM output does not satisfy the media contract.",
          );
        }
        if (
          metadata.durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs ||
          (durationLimitMs > parsed.durationMs &&
            metadata.durationMs >= durationLimitMs) ||
          metadata.fileSize >= outputLimitBytes
        ) {
          throw mediaFailure(
            "limit_exceeded",
            "limit_exceeded",
            "preparing_media",
            "The normalized PCM output exceeded its trusted decode boundary.",
          );
        }
        await rm(sourceSnapshotPath, { force: false });
        throwIfAborted(operation.signal, "decode_failed");

        const normalizationId = mintOpaqueId("ls-pcm-", this.#tokenFactory);
        const facade = deepFreeze({
          schemaVersion: 1 as const,
          normalizationId,
          taskId: options.taskId,
          taskGeneration: options.taskGeneration,
          displayName: input.displayName,
          runtimeGeneration: tools.bundle.runtimeGeneration,
          selectedStreamId: selected.streamId,
          sampleRateHz: 16_000 as const,
          channels: 1 as const,
          bitsPerSample: 16 as const,
          totalFrames: metadata.totalFrames,
          durationMs: metadata.durationMs,
          dataSizeBytes: metadata.dataSize,
        });
        const record: NormalizedPcmRecord = {
          ownerKey: ownedBy,
          session,
          filePath: normalizedPath,
          fileIdentity: metadata.fileIdentity,
          metadata,
          windows: new Set(),
          state: "active",
        };
        NORMALIZED_PCM_PROOFS.set(facade, record);
        const owned = this.#normalizedByOwner.get(record.ownerKey) ?? new Set();
        owned.add(facade);
        this.#normalizedByOwner.set(record.ownerKey, owned);
        this.#ownerStates.get(ownedBy)!.pendingSessions.delete(session);
        completed = true;
        emitProgress(100);
        return facade;
      } catch (error) {
        if (error instanceof LocalSubtitleMediaError) throw error;
        if (error instanceof LocalSubtitlePcmWindowError) {
          if (error.reason === "limit_exceeded") {
            throw mediaFailure(
              "limit_exceeded",
              "limit_exceeded",
              "preparing_media",
              "The normalized PCM output exceeds the versioned media limit.",
              error,
            );
          }
          throw mediaFailure(
            "decode_failed",
            "media_decode_failed",
            "preparing_media",
            "The normalized PCM output is invalid.",
            error,
          );
        }
        throw mediaFailure(
          "decode_failed",
          "media_decode_failed",
          "preparing_media",
          "The media could not be normalized safely.",
          error,
        );
      } finally {
        if (!completed) {
          const ownerState = this.#ownerStates.get(ownedBy)!;
          if (operation.hasUnconfirmedClose) {
            this.#startSessionCleanup(
              ownedBy,
              ownerState,
              session,
              operation.waitForClose(),
            );
          } else {
            await this.#startSessionCleanup(ownedBy, ownerState, session);
          }
        }
      }
    } finally {
      operation.finish();
    }
  }

  async materializeWindow(
    options: MaterializeLocalSubtitlePcmWindowOptions,
  ): Promise<LocalSubtitleBrandedPcmWindow> {
    const record = requireNormalizedRecord(options.normalized);
    if (record.state !== "active") {
      throw invalidMediaConfiguration("The normalized PCM proof is inactive.");
    }
    const operation = await this.#beginOwnerOperation(
      record.ownerKey,
      options.signal,
      "decode_failed",
    );
    try {
      const descriptor = validateStructuralWindow(
        options.descriptor,
        record.metadata.totalFrames,
      );
      throwIfAborted(operation.signal, "decode_failed");
      const windowId = mintOpaqueId("ls-window-", this.#tokenFactory);
      const outputPath = path.join(record.session.root, `${windowId}.wav`);

      try {
        const written = await writeLocalSubtitlePcmWindow({
          sourcePath: record.filePath,
          sourceIdentity: record.fileIdentity,
          metadata: record.metadata,
          startFrame: descriptor.startFrame,
          endFrame: descriptor.endFrame,
          outputPath,
          signal: operation.signal,
          conditionQuietAudio: options.conditionQuietAudio === true,
        });
        const frameCount = descriptor.endFrame - descriptor.startFrame;
        if (written.metadata.totalFrames !== frameCount) {
          throw new LocalSubtitlePcmWindowError(
            "window_frame_mismatch",
            "The PCM window frame count is invalid.",
          );
        }
        throwIfAborted(operation.signal, "decode_failed");
        const facade = deepFreeze({
          schemaVersion: 1 as const,
          windowId,
          normalizationId: options.normalized.normalizationId,
          taskId: options.normalized.taskId,
          taskGeneration: options.normalized.taskGeneration,
          descriptor,
          frameCount,
          durationMs: framesToMilliseconds(frameCount),
          byteSize: written.metadata.fileSize,
          sha256: written.sha256,
          ...(written.quietAudioGainDb === undefined ? {} : {quietAudioGainDb: written.quietAudioGainDb}),
        });
        WINDOW_PROOFS.set(facade, {
          normalized: options.normalized,
          filePath: outputPath,
          fileIdentity: written.metadata.fileIdentity,
          descriptor,
          sha256: written.sha256,
          state: "active",
        });
        record.windows.add(facade);
        return facade;
      } catch (error) {
        await rm(outputPath, { force: true }).catch(() => undefined);
        if (error instanceof LocalSubtitleMediaError) throw error;
        if (
          error instanceof LocalSubtitlePcmWindowError &&
          [
            "source_unavailable",
            "source_identity_mismatch",
            "invalid_wav",
            "unsupported_wav",
            "limit_exceeded",
          ].includes(error.reason)
        ) {
          faultNormalizedRecord(record);
        }
        throw mediaFailure(
          "decode_failed",
          "media_decode_failed",
          "preparing_media",
          "The inference PCM window could not be materialized.",
          error,
        );
      }
    } finally {
      operation.finish();
    }
  }

  async resolveWindow(
    window: LocalSubtitleBrandedPcmWindow,
    expected: {
      readonly taskId: string;
      readonly taskGeneration: number;
      readonly descriptor: LocalSubtitleMediaStructuralWindow;
    },
  ): Promise<LocalSubtitleResolvedPcmWindow> {
    const record = requireWindowRecord(window);
    const normalizedRecord = requireNormalizedRecord(record.normalized);
    const operation = await this.#beginOwnerOperation(
      normalizedRecord.ownerKey,
      undefined,
      "decode_failed",
    );
    try {
      if (
        record.state !== "active" ||
        normalizedRecord.state !== "active" ||
        window.taskId !== expected.taskId ||
        window.taskGeneration !== expected.taskGeneration ||
        !sameStructuralWindow(record.descriptor, expected.descriptor)
      ) {
        throw invalidMediaConfiguration(
          "The inference PCM window binding is invalid.",
        );
      }
      let metadata: LocalSubtitlePcm16WavMetadata;
      let sha256: string;
      try {
        metadata = await inspectLocalSubtitlePcm16Wav(record.filePath);
        sha256 = await hashOwnedFile(
          record.filePath,
          record.fileIdentity,
          operation.signal,
        );
        throwIfAborted(operation.signal, "decode_failed");
      } catch (error) {
        if (
          error instanceof LocalSubtitleMediaError &&
          error.localSubtitleCode === "owner_released"
        ) {
          throw error;
        }
        record.state = "faulted";
        throw mediaFailure(
          "media_changed",
          "media_changed",
          "preparing_media",
          "The inference PCM window changed after it was branded.",
          error,
        );
      }
      if (
        !sameFileIdentity(metadata.fileIdentity, record.fileIdentity) ||
        metadata.fileSize !== window.byteSize ||
        metadata.totalFrames !== window.frameCount ||
        sha256 !== record.sha256
      ) {
        record.state = "faulted";
        throw mediaFailure(
          "media_changed",
          "media_changed",
          "preparing_media",
          "The inference PCM window changed after it was branded.",
        );
      }
      return deepFreeze({
        filePath: record.filePath,
        fileIdentity: { ...record.fileIdentity },
        byteSize: window.byteSize,
        sha256: record.sha256,
        ...(window.quietAudioGainDb === undefined ? {} : {quietAudioGainDb: window.quietAudioGainDb}),
      });
    } finally {
      operation.finish();
    }
  }

  async disposeWindow(
    window: LocalSubtitleBrandedPcmWindow,
  ): Promise<{ readonly removed: boolean }> {
    const record = requireWindowRecord(window);
    if (record.state === "removed") return deepFreeze({ removed: false });
    if (record.cleanupPromise) return record.cleanupPromise;
    record.state = "cleaning";
    record.cleanupPromise = (async () => {
      try {
        await assertPathFileIdentity(record.filePath, record.fileIdentity);
        await rm(record.filePath, { force: false });
        record.state = "removed";
        NORMALIZED_PCM_PROOFS.get(record.normalized)?.windows.delete(window);
        return deepFreeze({ removed: true });
      } catch (error) {
        const normalizedRecord = NORMALIZED_PCM_PROOFS.get(record.normalized);
        if (normalizedRecord) {
          faultNormalizedRecord(normalizedRecord);
          this.#faultOwner(normalizedRecord.ownerKey);
        } else {
          record.state = "faulted";
        }
        record.cleanupPromise = undefined;
        throw mediaFailure(
          "cleanup_failed",
          "cleanup_failed",
          "cleanup",
          "The inference PCM window could not be removed safely.",
          error,
        );
      }
    })();
    return record.cleanupPromise;
  }

  async disposeNormalized(
    normalized: LocalSubtitleNormalizedPcm,
  ): Promise<{ readonly removed: boolean }> {
    const record = requireNormalizedRecord(normalized);
    if (record.state === "removed") return deepFreeze({ removed: false });
    if (record.cleanupPromise) return record.cleanupPromise;
    record.state = "cleaning";
    for (const window of record.windows) {
      const windowRecord = WINDOW_PROOFS.get(window);
      if (windowRecord) windowRecord.state = "removed";
    }
    record.windows.clear();
    record.cleanupPromise = cleanupMediaSession(record.session)
      .then((result) => {
        record.state = "removed";
        this.#normalizedByOwner.get(record.ownerKey)?.delete(normalized);
        if (this.#normalizedByOwner.get(record.ownerKey)?.size === 0) {
          this.#normalizedByOwner.delete(record.ownerKey);
        }
        return result;
      })
      .catch((error) => {
        record.state = "faulted";
        this.#faultOwner(record.ownerKey);
        record.cleanupPromise = undefined;
        throw mediaFailure(
          "cleanup_failed",
          "cleanup_failed",
          "cleanup",
          "The private media session could not be removed safely.",
          error,
        );
      });
    return record.cleanupPromise;
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    assertOwner(owner);
    const key = ownerKey(owner);
    const state = this.#ownerStates.get(key) ?? createMediaOwnerState();
    this.#ownerStates.set(key, state);
    this.#invalidateOwnerProofs(key);
    if (state.status === "released") {
      this.#startOwnerCleanup(key, state);
      return;
    }
    state.status = "released";
    for (const controller of state.controllers) {
      controller.abort(OWNER_RELEASED_ABORT_REASON);
    }
    for (const probe of [...this.#probeRecords.keys()]) {
      if (probe.startsWith(`${key}:`)) this.#probeRecords.delete(probe);
    }
    for (const selection of [...this.#taskTrackSelections.keys()]) {
      if (selection.startsWith(`${key}:`)) this.#taskTrackSelections.delete(selection);
    }
    this.#startOwnerCleanup(key, state);
  }

  shutdown(
    _reason: "app_quit" | "update" | "fatal",
  ): Promise<void> {
    if (this.#shutdownSucceeded) return Promise.resolve();
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#terminalFence = true;

    for (const [key, state] of this.#ownerStates) {
      this.#invalidateOwnerProofs(key);
      if (state.status !== "released") {
        state.status = "released";
        for (const controller of state.controllers) {
          controller.abort(OWNER_RELEASED_ABORT_REASON);
        }
        for (const probe of [...this.#probeRecords.keys()]) {
          if (probe.startsWith(`${key}:`)) this.#probeRecords.delete(probe);
        }
        for (const selection of [...this.#taskTrackSelections.keys()]) {
          if (selection.startsWith(`${key}:`)) {
            this.#taskTrackSelections.delete(selection);
          }
        }
      }
    }

    let operation: Promise<void>;
    operation = (async () => {
      const results = await Promise.allSettled(
        [...this.#ownerStates].map(async ([key, state]) => {
          try {
            await this.#startOwnerCleanup(key, state);
          } catch {
            await this.#startOwnerCleanup(key, state);
          }
        }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        throw failure.reason;
      }
      this.#shutdownSucceeded = true;
    })().catch((error: unknown) => {
      if (this.#shutdownOperation === operation) {
        this.#shutdownOperation = undefined;
      }
      throw error;
    });
    this.#shutdownOperation = operation;
    return operation;
  }

  async #beginOwnerOperation(
    key: string,
    externalSignal: AbortSignal | undefined,
    abortFallback: "probe_failed" | "decode_failed" | "runtime_launch_failed",
  ): Promise<MediaOwnerOperation> {
    if (
      this.#terminalFence ||
      this.#shutdownOperation ||
      this.#shutdownSucceeded
    ) {
      throw ownerReleasedMediaFailure();
    }
    const state = this.#ownerStates.get(key) ?? createMediaOwnerState();
    this.#ownerStates.set(key, state);
    throwIfMediaOwnerUnavailable(state);
    if (
      state.pendingOperationSettlements.size >=
      LOCAL_SUBTITLE_MEDIA_POLICY.maxPendingOperationsPerOwner
    ) {
      throw mediaFailure(
        "resource_busy",
        "resource_busy",
        "preflight",
        "The local subtitle media operation queue is full.",
      );
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    state.controllers.add(controller);

    let settlePending!: () => void;
    const pendingSettlement = new Promise<void>((resolve) => {
      settlePending = resolve;
    });
    state.pendingOperationSettlements.add(pendingSettlement);

    try {
      while (
        state.operationSettlements.size >=
        LOCAL_SUBTITLE_MEDIA_POLICY.maxConcurrentOperationsPerOwner
      ) {
        await waitForOwnerOperationSlot(
          state.operationSettlements,
          controller.signal,
          abortFallback,
        );
        if (
          this.#terminalFence ||
          this.#shutdownOperation ||
          this.#shutdownSucceeded ||
          state.status !== "active"
        ) {
          throwIfMediaOwnerUnavailable(state);
          throw ownerReleasedMediaFailure();
        }
        throwIfAborted(controller.signal, abortFallback);
      }
      if (
        state.processCloseConfirmations.size > 0 ||
        state.sessionCleanupPromises.size > 0
      ) {
        throw mediaFailure(
          "runtime_launch_failed",
          "media_runtime_launch_failed",
          "preflight",
          "A prior native media process has not confirmed close.",
        );
      }

      let settle!: () => void;
      const settlement = new Promise<void>((resolve) => {
        settle = resolve;
      });
      state.operationSettlements.add(settlement);
      state.pendingOperationSettlements.delete(pendingSettlement);
      settlePending();
      const unconfirmedClose = new Set<Promise<void>>();
      let finished = false;
      return {
        signal: controller.signal,
        get hasUnconfirmedClose() {
          return unconfirmedClose.size > 0;
        },
        trackProcess: (result) => {
          if (result.status === "closed") return;
          const confirmation = result.closeConfirmed.catch(
            () => new Promise<void>(() => undefined),
          );
          unconfirmedClose.add(confirmation);
          state.processCloseConfirmations.add(confirmation);
          void confirmation.then(() => {
            state.processCloseConfirmations.delete(confirmation);
          });
        },
        waitForClose: () =>
          Promise.all([...unconfirmedClose]).then(() => undefined),
        finish: () => {
          if (finished) return;
          finished = true;
          externalSignal?.removeEventListener("abort", forwardAbort);
          state.controllers.delete(controller);
          state.operationSettlements.delete(settlement);
          settle();
        },
      };
    } catch (error) {
      externalSignal?.removeEventListener("abort", forwardAbort);
      state.controllers.delete(controller);
      state.pendingOperationSettlements.delete(pendingSettlement);
      settlePending();
      throw error;
    }
  }

  #startOwnerCleanup(key: string, state: MediaOwnerState): Promise<void> {
    if (state.cleanupPromise) return state.cleanupPromise;
    let cleanup: Promise<void>;
    cleanup = this.#cleanupOwner(key, state).catch((error: unknown) => {
      if (state.cleanupPromise === cleanup) state.cleanupPromise = undefined;
      throw error;
    });
    state.cleanupPromise = cleanup;
    const observed = cleanup.catch(() => undefined).finally(() => {
      this.#backgroundCleanup.delete(observed);
    });
    this.#backgroundCleanup.add(observed);
    return cleanup;
  }

  #startSessionCleanup(
    key: string,
    state: MediaOwnerState,
    session: MediaSession,
    ready: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const existing = state.sessionCleanupPromises.get(session);
    if (existing) return existing;

    let cleanup: Promise<void>;
    const run = ready.then(async () => {
      if (!state.pendingSessions.has(session)) return;
      await cleanupMediaSession(session);
      state.pendingSessions.delete(session);
    });
    cleanup = run
      .catch((error: unknown) => {
        this.#faultOwner(key);
        throw mediaFailure(
          "cleanup_failed",
          "cleanup_failed",
          "cleanup",
          "The failed media session could not be removed safely.",
          error,
        );
      })
      .finally(() => {
        if (state.sessionCleanupPromises.get(session) === cleanup) {
          state.sessionCleanupPromises.delete(session);
        }
      });
    state.sessionCleanupPromises.set(session, cleanup);
    const observed = cleanup.catch(() => undefined).finally(() => {
      this.#backgroundCleanup.delete(observed);
    });
    this.#backgroundCleanup.add(observed);
    return cleanup;
  }

  async #cleanupOwner(key: string, state: MediaOwnerState): Promise<void> {
    await Promise.allSettled([
      ...state.operationSettlements,
      ...state.pendingOperationSettlements,
    ]);
    await Promise.all([...state.processCloseConfirmations]);
    const failures: unknown[] = [];
    for (const normalized of [...(this.#normalizedByOwner.get(key) ?? [])]) {
      try {
        await this.disposeNormalized(normalized);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const session of [...state.pendingSessions]) {
      try {
        await this.#startSessionCleanup(key, state, session);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw mediaFailure(
        "cleanup_failed",
        "cleanup_failed",
        "cleanup",
        "One or more private media sessions could not be removed safely.",
        failures[0],
      );
    }
  }

  #invalidateOwnerProofs(key: string): void {
    for (const normalized of this.#normalizedByOwner.get(key) ?? []) {
      const record = NORMALIZED_PCM_PROOFS.get(normalized);
      if (record) deactivateNormalizedRecord(record);
    }
  }

  #faultOwner(key: string): void {
    const state = this.#ownerStates.get(key);
    if (state?.status !== "active") return;
    state.status = "faulted";
    this.#invalidateOwnerProofs(key);
    for (const controller of state.controllers) {
      controller.abort(OWNER_FAULTED_ABORT_REASON);
    }
    for (const probe of [...this.#probeRecords.keys()]) {
      if (probe.startsWith(`${key}:`)) this.#probeRecords.delete(probe);
    }
    for (const selection of [...this.#taskTrackSelections.keys()]) {
      if (selection.startsWith(`${key}:`)) this.#taskTrackSelections.delete(selection);
    }
  }

  #storeProbeRecord(record: ProbeRecord): void {
    const key = `${record.ownerKey}:${record.fileToken}`;
    this.#probeRecords.delete(key);
    const ownedKeys = [...this.#probeRecords]
      .filter(([, candidate]) => candidate.ownerKey === record.ownerKey)
      .map(([candidateKey]) => candidateKey);
    const overflow =
      ownedKeys.length - LOCAL_SUBTITLE_MEDIA_POLICY.maxProbeRecordsPerOwner + 1;
    for (const candidateKey of ownedKeys.slice(0, Math.max(0, overflow))) {
      this.#probeRecords.delete(candidateKey);
    }
    this.#probeRecords.set(key, record);
  }

  async #attestMediaRuntime(operation: MediaOwnerOperation): Promise<MediaTools> {
    const { signal } = operation;
    throwIfAborted(signal, "runtime_launch_failed");
    const workingDirectory = await ensureMediaBaseRoot(this.#managedResourceRoot);
    const first = await verifyLocalSubtitleRuntimeBundle({
      environment: this.#environment,
      scope: "media",
      ...(this.#signatureVerifier === undefined
        ? {}
        : { signatureVerifier: this.#signatureVerifier }),
    });
    const firstArtifacts = selectMediaTools(first);
    const environment = buildLocalSubtitleMediaEnvironment({
      platform: first.target.platform,
      mediaDirectory: path.dirname(firstArtifacts.ffmpeg.absolutePath),
      tempDirectory: workingDirectory,
      sourceEnvironment: this.#sourceEnvironment,
    });
    await this.#probeToolVersion(
      firstArtifacts.ffmpeg,
      "ffmpeg",
        workingDirectory,
        environment,
        operation,
    );
    await this.#probeToolVersion(
      firstArtifacts.ffprobe,
      "ffprobe",
        workingDirectory,
        environment,
        operation,
    );
    const second = await verifyLocalSubtitleRuntimeBundle({
      environment: this.#environment,
      scope: "media",
      ...(this.#signatureVerifier === undefined
        ? {}
        : { signatureVerifier: this.#signatureVerifier }),
    });
    if (second.runtimeGeneration !== first.runtimeGeneration) {
      throw mediaFailure(
        "runtime_launch_failed",
        "media_runtime_invalid",
        "preflight",
        "The bundled media runtime changed during launch verification.",
      );
    }
    const artifacts = selectMediaTools(second);
    return {
      bundle: second,
      ffmpeg: artifacts.ffmpeg,
      ffprobe: artifacts.ffprobe,
      environment,
      workingDirectory,
    };
  }

  async #probeToolVersion(
    artifact: LocalSubtitleVerifiedRuntimeArtifact,
    kind: "ffmpeg" | "ffprobe",
    cwd: string,
    environment: Readonly<Record<string, string | undefined>>,
    operation: MediaOwnerOperation,
  ): Promise<void> {
    const { signal } = operation;
    const result = await this.#processRunner({
      command: artifact.absolutePath,
      args: ["-hide_banner", "-version"],
      cwd,
      env: environment,
      timeoutMs: LOCAL_SUBTITLE_MEDIA_POLICY.runtimeProbeTimeoutMs,
      stdoutMaxBytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxProbeStdoutBytes,
      stderrMaxBytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxDiagnosticBytes,
      signal,
    });
    operation.trackProcess(result);
    throwIfAborted(signal, "runtime_launch_failed");
    const expected = new RegExp(
      `^${kind} version ${escapeRegExp(artifact.version)}(?:\\s|$)`,
      "mu",
    );
    if (
      !processSucceeded(result) ||
      !expected.test(`${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`)
    ) {
      throw mediaFailure(
        result.aborted ? "aborted" : "runtime_launch_failed",
        "media_runtime_launch_failed",
        "preflight",
        result.aborted
          ? "The bundled media runtime probe was aborted."
          : "The bundled media runtime could not be launched safely.",
      );
    }
  }

  async #probePath(
    inputPath: string,
    tools: MediaTools,
    operation: MediaOwnerOperation,
    expectedIdentity: LocalSubtitleFileIdentity,
  ): Promise<ParsedMediaProbe> {
    const { signal } = operation;
    await assertPathFileIdentity(inputPath, expectedIdentity);
    const result = await this.#processRunner({
      command: tools.ffprobe.absolutePath,
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index,codec_type,codec_name,channels,sample_rate,duration,start_time:stream_disposition=default:stream_tags=language,title:format=duration,start_time",
        "-of",
        "json",
        inputPath,
      ],
      cwd: tools.workingDirectory,
      env: tools.environment,
      timeoutMs: LOCAL_SUBTITLE_MEDIA_POLICY.probeTimeoutMs,
      stdoutMaxBytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxProbeStdoutBytes,
      stderrMaxBytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxDiagnosticBytes,
      signal,
    });
    operation.trackProcess(result);
    throwIfAborted(signal, "probe_failed");
    await assertPathFileIdentity(inputPath, expectedIdentity);
    if (!processSucceeded(result)) {
      if (!result.aborted && result.status === "spawn_error") {
        throw mediaFailure(
          "runtime_launch_failed",
          "media_runtime_launch_failed",
          "preflight",
          "The bundled media probe could not be launched safely.",
        );
      }
      throw mediaFailure(
        result.aborted ? "aborted" : result.timedOut ? "timeout" : "probe_failed",
        "media_probe_failed",
        "preparing_media",
        result.aborted
          ? "The media probe was aborted."
          : result.timedOut
            ? "The media probe timed out."
            : "The media container could not be probed.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(result.stdout.toString("utf8"));
    } catch (error) {
      throw mediaFailure(
        "probe_failed",
        "media_probe_failed",
        "preparing_media",
        "The media probe returned invalid JSON.",
        error,
      );
    }
    return parseMediaProbe(input);
  }

  #resolveTrackSelection(input: {
    readonly owner: LocalSubtitleOwnerKey;
    readonly fileToken: string;
    readonly taskId: string;
    readonly input: ResolvedLocalSubtitleInput;
    readonly runtimeGeneration: string;
    readonly parsed: ParsedMediaProbe;
    readonly audioStreamId?: string;
  }): { readonly streamId: string; readonly track: RawAudioTrack } {
    if (input.audioStreamId === undefined) {
      const track = input.parsed.tracks[input.parsed.autoSelectedOrdinal - 1]!;
      return {
        streamId: mintOpaqueId("ls-auto-stream-", this.#tokenFactory),
        track,
      };
    }
    const record = this.#taskTrackSelections.get(
      taskSelectionKey(input.owner, input.taskId),
    );
    const selected = record?.selectedTrack;
    if (
      !record ||
      !selected ||
      record.ownerKey !== ownerKey(input.owner) ||
      record.taskId !== input.taskId ||
      record.fileToken !== input.fileToken ||
      selected.streamId !== input.audioStreamId ||
      record.runtimeGeneration !== input.runtimeGeneration ||
      !sameInputFileIdentity(record.inputIdentity, input.input.identity) ||
      record.durationMs !== input.parsed.durationMs ||
      record.trackTableSignature !== trackTableSignature(input.parsed.tracks)
    ) {
      throw mediaFailure(
        "media_changed",
        "media_changed",
        "preparing_media",
        "The selected media stream is stale or belongs to another input.",
      );
    }
    const current = input.parsed.tracks.find(
      (track) => track.signature === selected.signature,
    );
    if (!current) {
      throw mediaFailure(
        "media_changed",
        "media_changed",
        "preparing_media",
        "The selected media stream changed after probing.",
      );
    }
    return { streamId: selected.streamId, track: current };
  }

  async #decodeSnapshot(input: {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly streamIndex: number;
    readonly durationMs: number;
    readonly processDurationLimitMs: number;
    readonly outputLimitBytes: number;
    readonly tools: MediaTools;
    readonly operation: MediaOwnerOperation;
    readonly inputIdentity: LocalSubtitleFileIdentity;
    readonly onProgress?: (percentage: number) => void;
  }): Promise<void> {
    const { signal } = input.operation;
    await assertPathFileIdentity(input.inputPath, input.inputIdentity);
    const progress = new FfmpegProgressParser(input.durationMs, (value) => {
      const scaled = LOCAL_SUBTITLE_MEDIA_POLICY.inputCopyProgressMaximum +
        Math.floor(
          (value / 100) *
            (LOCAL_SUBTITLE_MEDIA_POLICY.decodeProgressMaximum -
              LOCAL_SUBTITLE_MEDIA_POLICY.inputCopyProgressMaximum),
        );
      reportProgress(input.onProgress, Math.min(99, scaled));
    });
    let sawStreamedStdout = false;
    const result = await this.#processRunner({
      command: input.tools.ffmpeg.absolutePath,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-nostats",
        "-stats_period",
        "0.25",
        "-progress",
        "pipe:1",
        "-copyts",
        "-start_at_zero",
        "-i",
        input.inputPath,
        "-map",
        `0:${input.streamIndex}`,
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-af",
        "aresample=async=1000:first_pts=0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        formatFfmpegDuration(input.processDurationLimitMs),
        "-fs",
        String(input.outputLimitBytes),
        "-rf64",
        "auto",
        "-f",
        "wav",
        "-n",
        input.outputPath,
      ],
      cwd: input.tools.workingDirectory,
      env: input.tools.environment,
      timeoutMs: decodeTimeoutMs(input.durationMs),
      stdoutMaxBytes: 0,
      stderrMaxBytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxDiagnosticBytes,
      stdoutMode: "stream",
      signal,
      onStdoutChunk: (chunk) => {
        sawStreamedStdout = true;
        progress.push(Buffer.from(chunk).toString("utf8"));
      },
    });
    input.operation.trackProcess(result);
    throwIfAborted(signal, "decode_failed");
    await assertPathFileIdentity(input.inputPath, input.inputIdentity);
    if (!sawStreamedStdout) progress.push(result.stdout.toString("utf8"));
    progress.finish();
    if (!processSucceeded(result) || !progress.sawEnd) {
      if (!result.aborted && result.status === "spawn_error") {
        throw mediaFailure(
          "runtime_launch_failed",
          "media_runtime_launch_failed",
          "preflight",
          "The bundled media decoder could not be launched safely.",
        );
      }
      throw mediaFailure(
        result.aborted ? "aborted" : result.timedOut ? "timeout" : "decode_failed",
        "media_decode_failed",
        "preparing_media",
        result.aborted
          ? "Media normalization was aborted."
          : result.timedOut
            ? "Media normalization timed out."
            : "FFmpeg could not normalize the selected media stream.",
      );
    }
  }

  async #assertDiskSpace(directory: string, requiredBytes: number): Promise<void> {
    const available = await this.#availableBytes(directory);
    if (
      !Number.isSafeInteger(available) ||
      available < 0 ||
      !Number.isSafeInteger(requiredBytes) ||
      requiredBytes < 0
    ) {
      throw invalidMediaConfiguration("The media disk-space probe is invalid.");
    }
    if (available < requiredBytes) {
      throw mediaFailure(
        "insufficient_disk",
        "insufficient_disk",
        "preflight",
        "There is not enough disk space to prepare the selected media.",
      );
    }
  }
}

export function isLocalSubtitleNormalizedPcm(
  input: unknown,
): input is LocalSubtitleNormalizedPcm {
  const record =
    typeof input === "object" && input !== null
      ? NORMALIZED_PCM_PROOFS.get(input as LocalSubtitleNormalizedPcm)
      : undefined;
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    record?.state === "active"
  );
}

export function isLocalSubtitleBrandedPcmWindow(
  input: unknown,
): input is LocalSubtitleBrandedPcmWindow {
  const record =
    typeof input === "object" && input !== null
      ? WINDOW_PROOFS.get(input as LocalSubtitleBrandedPcmWindow)
      : undefined;
  const normalizedRecord = record
    ? NORMALIZED_PCM_PROOFS.get(record.normalized)
    : undefined;
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    record?.state === "active" &&
    normalizedRecord?.state === "active"
  );
}

function faultNormalizedRecord(record: NormalizedPcmRecord): void {
  setNormalizedRecordState(record, "faulted");
}

function deactivateNormalizedRecord(record: NormalizedPcmRecord): void {
  setNormalizedRecordState(record, "cleaning");
}

function setNormalizedRecordState(
  record: NormalizedPcmRecord,
  state: "cleaning" | "faulted",
): void {
  if (record.state === "removed") return;
  record.state = state;
  for (const window of record.windows) {
    const windowRecord = WINDOW_PROOFS.get(window);
    if (windowRecord && windowRecord.state !== "removed") {
      windowRecord.state = state;
    }
  }
}

function createProbeRecord(input: {
  readonly owner: LocalSubtitleOwnerKey;
  readonly fileToken: string;
  readonly input: ResolvedLocalSubtitleInput;
  readonly runtimeGeneration: string;
  readonly parsed: ParsedMediaProbe;
  readonly tokenFactory: () => string;
}): ProbeRecord {
  const streamIds = new Set<string>();
  const tracks = input.parsed.tracks.map((track) => {
    const streamId = mintOpaqueId("ls-stream-", input.tokenFactory);
    if (streamIds.has(streamId)) {
      throw invalidMediaConfiguration("The media stream identity source collided.");
    }
    streamIds.add(streamId);
    return deepFreeze({ ...track, streamId });
  });
  return deepFreeze({
    ownerKey: ownerKey(input.owner),
    fileToken: input.fileToken,
    inputIdentity: { ...input.input.identity },
    runtimeGeneration: input.runtimeGeneration,
    durationMs: input.parsed.durationMs,
    trackTableSignature: trackTableSignature(input.parsed.tracks),
    tracks,
  });
}

function probeSummary(
  record: ProbeRecord,
  displayName: string,
): LocalSubtitleMediaProbeSummary {
  const auto = record.tracks.find(
    (track) =>
      track.ordinal ===
      autoSelectedOrdinal(record.tracks),
  )!;
  return deepFreeze({
    fileToken: record.fileToken,
    displayName,
    durationMs: record.durationMs,
    audioTracks: record.tracks.map((track) => ({
      streamId: track.streamId,
      ordinal: track.ordinal,
      isDefault: track.isDefault,
      ...(track.language === undefined ? {} : { language: track.language }),
      ...(track.title === undefined ? {} : { title: track.title }),
      ...(track.codec === undefined ? {} : { codec: track.codec }),
      ...(track.channels === undefined ? {} : { channels: track.channels }),
      ...(track.sampleRateHz === undefined
        ? {}
        : { sampleRateHz: track.sampleRateHz }),
    })),
    autoSelectedStreamId: auto.streamId,
  });
}

function parseMediaProbe(input: unknown): ParsedMediaProbe {
  const parsed = ffprobeResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw mediaFailure(
      "probe_failed",
      "media_probe_failed",
      "preparing_media",
      "The media probe response does not match the expected structure.",
    );
  }
  const audio = parsed.data.streams.filter(
    (stream) => stream.codec_type === undefined || stream.codec_type === "audio",
  );
  if (audio.length === 0) {
    throw mediaFailure(
      "no_audio_stream",
      "no_audio_stream",
      "preparing_media",
      "The selected media does not contain an audio stream.",
    );
  }
  if (audio.length > LOCAL_SUBTITLE_LIMITS.maxMediaTracks) {
    throw mediaFailure(
      "limit_exceeded",
      "limit_exceeded",
      "preparing_media",
      "The selected media contains too many audio streams.",
    );
  }
  if (new Set(audio.map((stream) => stream.index)).size !== audio.length) {
    throw mediaFailure(
      "probe_failed",
      "media_probe_failed",
      "preparing_media",
      "The media probe returned duplicate stream indexes.",
    );
  }

  const budget = { bytes: LOCAL_SUBTITLE_MEDIA_POLICY.maxProbeMetadataBytes };
  const tracks = audio.map<RawAudioTrack>((stream, index) => {
    const language = sanitizeMetadata(stream.tags?.language, budget);
    const title = sanitizeMetadata(stream.tags?.title, budget);
    const codec = sanitizeMetadata(stream.codec_name, budget);
    const channels = optionalPositiveInteger(stream.channels, 256);
    const sampleRateHz = optionalPositiveInteger(
      numericValue(stream.sample_rate),
      1_536_000,
    );
    const value = {
      streamIndex: stream.index,
      ordinal: index + 1,
      isDefault: stream.disposition?.default === 1,
      ...(language === undefined ? {} : { language }),
      ...(title === undefined ? {} : { title }),
      ...(codec === undefined ? {} : { codec }),
      ...(channels === undefined ? {} : { channels }),
      ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
    };
    return deepFreeze({
      ...value,
      signature: JSON.stringify(value),
    });
  });
  const durationSeconds =
    positiveFiniteValue(parsed.data.format?.duration) ??
    tracks.reduce<number | undefined>((maximum, _track, index) => {
      const duration = positiveFiniteValue(audio[index]?.duration);
      if (duration === undefined) return maximum;
      return maximum === undefined ? duration : Math.max(maximum, duration);
    }, undefined);
  if (durationSeconds === undefined) {
    throw mediaFailure(
      "unsupported_media",
      "unsupported_media",
      "preparing_media",
      "The selected media does not have a positive bounded duration.",
    );
  }
  const durationMs = Math.round(durationSeconds * 1_000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw mediaFailure(
      "unsupported_media",
      "unsupported_media",
      "preparing_media",
      "The selected media duration is invalid.",
    );
  }
  if (durationMs > LOCAL_SUBTITLE_LIMITS.maxDurationMs) {
    throw mediaFailure(
      "limit_exceeded",
      "limit_exceeded",
      "preparing_media",
      "The selected media duration exceeds the versioned limit.",
    );
  }
  return deepFreeze({
    durationMs,
    tracks,
    autoSelectedOrdinal: autoSelectedOrdinal(tracks),
  });
}

function autoSelectedOrdinal(
  tracks: readonly Pick<RawAudioTrack, "ordinal" | "isDefault">[],
): number {
  const defaults = tracks.filter((track) => track.isDefault);
  return defaults.length === 1 ? defaults[0]!.ordinal : tracks[0]!.ordinal;
}

function sanitizeMetadata(
  input: unknown,
  budget: { bytes: number },
): string | undefined {
  if (typeof input !== "string") return undefined;
  const cleaned = Array.from(input, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint >= 0 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    ) {
      return " ";
    }
    return character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return undefined;
  let value = "";
  for (const character of Array.from(cleaned)) {
    if (
      value.length + character.length >
      LOCAL_SUBTITLE_LIMITS.maxMediaMetadataFieldChars
    ) {
      break;
    }
    value += character;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value || bytes > budget.bytes) return undefined;
  budget.bytes -= bytes;
  return value;
}

function trackTableSignature(tracks: readonly RawAudioTrack[]): string {
  return tracks.map((track) => track.signature).join("\n");
}

function positiveFiniteValue(value: unknown): number | undefined {
  const parsed = numericValue(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !/^(?:\d+\.?\d*|\.\d+)$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalPositiveInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 &&
    (value as number) <= maximum
    ? (value as number)
    : undefined;
}

function selectMediaTools(bundle: LocalSubtitleVerifiedRuntimeBundle): {
  readonly ffmpeg: LocalSubtitleVerifiedRuntimeArtifact;
  readonly ffprobe: LocalSubtitleVerifiedRuntimeArtifact;
} {
  if (
    !isLocalSubtitleVerifiedRuntimeBundle(bundle) ||
    (bundle.scope !== "media" && bundle.scope !== "all") ||
    bundle.noPathFallback !== true ||
    bundle.ready !== true
  ) {
    throw mediaFailure(
      "invalid_configuration",
      "media_runtime_invalid",
      "preflight",
      "The bundled media runtime proof is invalid.",
    );
  }
  const expectedVersion =
    LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions[bundle.target.platform];
  const artifacts = Object.values(bundle.artifactPaths);
  const ffmpeg = artifacts.filter((artifact) => artifact.kind === "ffmpeg");
  const ffprobe = artifacts.filter((artifact) => artifact.kind === "ffprobe");
  if (ffmpeg.length !== 1 || ffprobe.length !== 1) {
    throw mediaFailure(
      "invalid_configuration",
      "media_runtime_missing",
      "preflight",
      "The bundled media runtime artifacts are incomplete.",
    );
  }
  if (
    ffmpeg[0]!.backend !== "media" ||
    ffprobe[0]!.backend !== "media" ||
    ffmpeg[0]!.version !== expectedVersion ||
    ffprobe[0]!.version !== expectedVersion ||
    path.dirname(ffmpeg[0]!.absolutePath) !==
      path.dirname(ffprobe[0]!.absolutePath)
  ) {
    throw mediaFailure(
      "invalid_configuration",
      "media_runtime_invalid",
      "preflight",
      "The bundled media runtime artifacts do not match contract v1.",
    );
  }
  return { ffmpeg: ffmpeg[0]!, ffprobe: ffprobe[0]! };
}

function processSucceeded(result: LocalSubtitleMediaProcessResult): boolean {
  return (
    result.status === "closed" &&
    result.spawned &&
    result.exitCode === 0 &&
    result.signalCode === null &&
    !result.aborted &&
    !result.timedOut &&
    !result.outputExceeded &&
    result.spawnErrorCode === undefined &&
    result.stdioErrorCode === undefined
  );
}

class FfmpegProgressParser {
  #buffer = "";
  #lastPercentage = -1;
  readonly #durationUs: number;
  readonly #expectedOutputBytes: number;
  readonly #onProgress: (percentage: number) => void;
  sawEnd = false;

  constructor(durationMs: number, onProgress: (percentage: number) => void) {
    this.#durationUs = durationMs * 1_000;
    this.#expectedOutputBytes = estimatePcmBytes(durationMs) + 4_096;
    this.#onProgress = onProgress;
  }

  push(chunk: string): void {
    const lines = `${this.#buffer}${chunk}`.split("\n");
    this.#buffer = lines.pop() ?? "";
    if (this.#buffer.length > 16 * 1024) {
      throw mediaFailure(
        "decode_failed",
        "media_decode_failed",
        "preparing_media",
        "FFmpeg progress output exceeded its line buffer.",
      );
    }
    for (const rawLine of lines) {
      if (rawLine.length > 16 * 1024) {
        throw mediaFailure(
          "decode_failed",
          "media_decode_failed",
          "preparing_media",
          "FFmpeg progress output exceeded its line buffer.",
        );
      }
      this.#consume(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
  }

  finish(): void {
    if (this.#buffer) {
      this.#consume(
        this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer,
      );
    }
    this.#buffer = "";
  }

  #consume(line: string): void {
    if (line === "progress=end") {
      this.sawEnd = true;
      return;
    }
    const timeMatch = /^out_time_us=(\d+)$/u.exec(line);
    const sizeMatch = /^total_size=(\d+)$/u.exec(line);
    const observed = Number(timeMatch?.[1] ?? sizeMatch?.[1]);
    if (!Number.isSafeInteger(observed)) return;
    const denominator = timeMatch ? this.#durationUs : this.#expectedOutputBytes;
    const percentage = Math.max(
      0,
      Math.min(99, Math.floor((observed * 100) / denominator)),
    );
    if (percentage <= this.#lastPercentage) return;
    this.#lastPercentage = percentage;
    this.#onProgress(percentage);
  }
}

async function copyAuthorizedInputSnapshot(options: {
  readonly input: ResolvedLocalSubtitleInput;
  readonly outputPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedBytes: number) => void;
}): Promise<LocalSubtitleFileIdentity> {
  let source: FileHandle | undefined;
  let output: FileHandle | undefined;
  try {
    source = await open(options.input.filePath, READ_ONLY_NOFOLLOW);
    const sourceIdentity = await localSubtitleFileIdentityForHandle(source);
    if (!sameInputFileIdentity(sourceIdentity, options.input.identity)) {
      throw mediaChanged();
    }
    output = await open(
      options.outputPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    while (position < sourceIdentity.size) {
      throwIfAborted(options.signal, "decode_failed");
      const length = Math.min(buffer.length, sourceIdentity.size - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead !== length) throw mediaChanged();
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("Private media snapshot write stalled.");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
      options.onProgress?.(position);
    }
    await output.sync();
    const outputStat = await output.stat();
    const outputIdentity = await localSubtitleFileIdentityForHandle(output);
    if (
      !outputStat.isFile() ||
      outputIdentity.size !== sourceIdentity.size ||
      (process.platform !== "win32" &&
        (outputStat.mode & 0o777) !== PRIVATE_FILE_MODE)
    ) {
      throw new Error("Private media snapshot identity is invalid.");
    }
    if (
      !sameFileIdentity(
        await localSubtitleFileIdentityForHandle(source),
        sourceIdentity,
      )
    ) {
      throw mediaChanged();
    }
    await assertResolvedInputCurrent(options.input);
    await output.close();
    output = undefined;
    await source.close();
    source = undefined;
    await assertPathFileIdentity(options.outputPath, outputIdentity);
    return outputIdentity;
  } catch (error) {
    await Promise.allSettled([source?.close(), output?.close()]);
    source = undefined;
    output = undefined;
    await rm(options.outputPath, { force: true }).catch(() => undefined);
    if (error instanceof LocalSubtitleMediaError) throw error;
    throw mediaFailure(
      "decode_failed",
      "media_decode_failed",
      "preparing_media",
      "The authorized media could not be copied into a private snapshot.",
      error,
    );
  } finally {
    await Promise.allSettled([source?.close(), output?.close()]);
  }
}

async function assertResolvedInputCurrent(
  input: ResolvedLocalSubtitleInput,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(input.filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameInputFileIdentity(
        await localSubtitleFileIdentityForPath(input.filePath),
        input.identity,
      )
    ) {
      throw new Error();
    }
    handle = await open(input.filePath, READ_ONLY_NOFOLLOW);
    if (!sameInputFileIdentity(
      await localSubtitleFileIdentityForHandle(handle),
      input.identity,
    )) {
      throw new Error();
    }
  } catch {
    throw mediaChanged();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPathFileIdentity(
  filePath: string,
  expected: LocalSubtitleFileIdentity,
): Promise<void> {
  try {
    const current = await lstat(filePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(
        await localSubtitleFileIdentityForPath(filePath),
        expected,
      )
    ) {
      throw new Error();
    }
  } catch {
    throw mediaChanged();
  }
}

async function hashOwnedFile(
  filePath: string,
  expected: LocalSubtitleFileIdentity,
  signal?: AbortSignal,
): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, READ_ONLY_NOFOLLOW);
    const before = await localSubtitleFileIdentityForHandle(handle);
    if (!sameFileIdentity(before, expected)) throw new Error();

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      throwIfAborted(signal, "decode_failed");
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await localSubtitleFileIdentityForHandle(handle);
    if (!sameFileIdentity(after, expected)) throw new Error();
    await assertPathFileIdentity(filePath, expected);
    throwIfAborted(signal, "decode_failed");
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof LocalSubtitleMediaError) throw error;
    throw mediaFailure(
      "media_changed",
      "media_changed",
      "preparing_media",
      "The inference PCM window changed after it was branded.",
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureMediaBaseRoot(managedResourceRoot: string): Promise<string> {
  try {
    await ensurePrivateDirectory(managedResourceRoot, true);
    const managedIdentity = await directoryIdentity(managedResourceRoot);
    const tempRoot = path.join(managedResourceRoot, "temp");
    await ensurePrivateDirectory(tempRoot, false);
    const tempIdentity = await directoryIdentity(tempRoot);
    if (
      !sameDirectoryIdentity(
        await directoryIdentity(managedResourceRoot),
        managedIdentity,
      ) ||
      !isWithin(managedIdentity.realPath, tempIdentity.realPath)
    ) {
      throw new Error("The media temp parent escaped managed storage.");
    }

    const baseRoot = path.join(tempRoot, "media");
    await ensurePrivateDirectory(baseRoot, false);
    const baseIdentity = await directoryIdentity(baseRoot);
    if (
      !sameDirectoryIdentity(
        await directoryIdentity(managedResourceRoot),
        managedIdentity,
      ) ||
      !sameDirectoryIdentity(await directoryIdentity(tempRoot), tempIdentity) ||
      !isWithin(tempIdentity.realPath, baseIdentity.realPath)
    ) {
      throw new Error("The media temp root escaped managed storage.");
    }
    return baseIdentity.realPath;
  } catch (error) {
    if (error instanceof LocalSubtitleMediaError) throw error;
    throw invalidMediaConfiguration(
      "The private media temp root is unavailable or unsafe.",
    );
  }
}

async function createMediaSession(
  managedResourceRoot: string,
): Promise<MediaSession> {
  const baseRoot = await ensureMediaBaseRoot(managedResourceRoot);
  const baseIdentity = await directoryIdentity(baseRoot);
  const root = await mkdtemp(path.join(baseRoot, MEDIA_SESSION_PREFIX));
  const rootIdentity = await directoryIdentity(root);
  if (!isWithin(baseIdentity.realPath, rootIdentity.realPath)) {
    throw invalidMediaConfiguration("The media session escaped its temp root.");
  }
  return { baseRoot, baseIdentity, root, rootIdentity };
}

async function cleanupMediaSession(
  session: MediaSession,
): Promise<{ readonly removed: boolean }> {
  const base = await directoryIdentity(session.baseRoot);
  if (!sameDirectoryIdentity(base, session.baseIdentity)) {
    throw new Error("Media temp root identity changed.");
  }
  let target = session.root;
  const current = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current) {
    const identity = await directoryIdentity(target);
    if (!sameDirectoryIdentity(identity, session.rootIdentity)) {
      throw new Error("Media session identity changed.");
    }
    const quarantine = `${session.root}${CLEANUP_MARKER}${randomUUID().replaceAll("-", "")}`;
    await rename(session.root, quarantine);
    target = quarantine;
  } else {
    const prefix = `${path.basename(session.root)}${CLEANUP_MARKER}`;
    const candidates = (await readdir(session.baseRoot)).filter((entry) =>
      entry.startsWith(prefix),
    );
    const match = await findOwnedQuarantine(session, candidates);
    if (!match) throw new Error("Owned media session disappeared before cleanup.");
    target = match;
  }
  const targetIdentity = await directoryIdentity(target);
  if (
    !sameDirectoryObject(targetIdentity, session.rootIdentity) ||
    !isWithin(session.baseIdentity.realPath, targetIdentity.realPath)
  ) {
    throw new Error("Quarantined media session identity changed.");
  }
  await rm(target, {
    recursive: true,
    force: false,
    maxRetries: LOCAL_SUBTITLE_MEDIA_POLICY.cleanupMaxRetries,
    retryDelay: LOCAL_SUBTITLE_MEDIA_POLICY.cleanupRetryDelayMs,
  });
  return deepFreeze({ removed: true });
}

async function findOwnedQuarantine(
  session: MediaSession,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const target = path.join(session.baseRoot, candidate);
    try {
      const identity = await directoryIdentity(target);
      if (sameDirectoryObject(identity, session.rootIdentity)) return target;
    } catch {
      // Ignore unrelated or concurrently removed quarantine entries.
    }
  }
  return undefined;
}

async function ensurePrivateDirectory(
  directory: string,
  recursive: boolean,
): Promise<void> {
  try {
    await mkdir(directory, { recursive, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await directoryIdentity(directory);
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const before = await lstat(directory);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new Error("Private media directory identity is invalid.");
  }
  const resolved = await realpath(directory);
  const after = await lstat(directory);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeMs !== after.birthtimeMs ||
    (process.platform !== "win32" &&
      (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new Error("Private media directory identity changed.");
  }
  return {
    dev: after.dev,
    ino: after.ino,
    birthtimeMs: after.birthtimeMs,
    realPath: resolved,
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs &&
    left.realPath === right.realPath
  );
}

function sameDirectoryObject(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(
    relative &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`),
  );
}

function validateStructuralWindow(
  input: LocalSubtitleMediaStructuralWindow,
  totalFrames: number,
): LocalSubtitleMediaStructuralWindow {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidMediaConfiguration("The structural PCM window is invalid.");
  }
  const allowed = [
    "windowKey",
    "rootPlanId",
    "rootWindowKey",
    ...(input.parentWindowKey === undefined ? [] : ["parentWindowKey"]),
    "retryDepth",
    "startFrame",
    "endFrame",
    "coreStartFrame",
    "coreEndFrame",
    "startMs",
    "endMs",
    "coreStartMs",
    "coreEndMs",
  ];
  if (
    Object.keys(input).length !== allowed.length ||
    !Object.keys(input).every((key) => allowed.includes(key)) ||
    !isSafeId(input.windowKey) ||
    !isSafeId(input.rootPlanId) ||
    !isSafeId(input.rootWindowKey) ||
    (input.parentWindowKey !== undefined && !isSafeId(input.parentWindowKey)) ||
    !Number.isSafeInteger(input.retryDepth) ||
    input.retryDepth < 0 ||
    input.retryDepth > LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.maxRetryDepth ||
    !isFrameRange(input.startFrame, input.endFrame) ||
    !isFrameRange(input.coreStartFrame, input.coreEndFrame) ||
    input.coreStartFrame < input.startFrame ||
    input.coreEndFrame > input.endFrame ||
    input.endFrame > totalFrames ||
    input.endFrame - input.startFrame >
      (LOCAL_SUBTITLE_PRODUCTION_CONTRACT.transcript.pcmWindowMs * 16_000) /
        1_000 ||
    input.startMs !== framesToMilliseconds(input.startFrame) ||
    input.endMs !== framesToMilliseconds(input.endFrame) ||
    input.coreStartMs !== framesToMilliseconds(input.coreStartFrame) ||
    input.coreEndMs !== framesToMilliseconds(input.coreEndFrame) ||
    input.endMs <= input.startMs ||
    input.coreEndMs <= input.coreStartMs
  ) {
    throw invalidMediaConfiguration("The structural PCM window is invalid.");
  }
  return deepFreeze({ ...input });
}

function sameStructuralWindow(
  left: LocalSubtitleMediaStructuralWindow,
  right: LocalSubtitleMediaStructuralWindow,
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

function isFrameRange(start: unknown, end: unknown): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number)
  );
}

function framesToMilliseconds(frames: number): number {
  return Math.round((frames * 1_000) / LOCAL_SUBTITLE_MEDIA_POLICY.sampleRateHz);
}

function requireNormalizedRecord(
  normalized: LocalSubtitleNormalizedPcm,
): NormalizedPcmRecord {
  const record = NORMALIZED_PCM_PROOFS.get(normalized);
  if (!record || !Object.isFrozen(normalized)) {
    throw invalidMediaConfiguration("The normalized PCM proof is invalid.");
  }
  return record;
}

function requireWindowRecord(
  window: LocalSubtitleBrandedPcmWindow,
): PcmWindowRecord {
  const record = WINDOW_PROOFS.get(window);
  if (!record || !Object.isFrozen(window)) {
    throw invalidMediaConfiguration("The inference PCM window proof is invalid.");
  }
  return record;
}

async function availableFileSystemBytes(directory: string): Promise<number> {
  const stats = await statfs(directory, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(bytes);
}

function estimatePcmBytes(durationMs: number): number {
  const bytes =
    Math.ceil(
      (durationMs * LOCAL_SUBTITLE_MEDIA_POLICY.sampleRateHz) / 1_000,
    ) * 2;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw mediaFailure(
      "limit_exceeded",
      "limit_exceeded",
      "preflight",
      "The normalized PCM size estimate is invalid.",
    );
  }
  return bytes;
}

function decodeDurationLimitMs(durationMs: number): number {
  const limit = Math.min(
    LOCAL_SUBTITLE_LIMITS.maxDurationMs,
    durationMs + LOCAL_SUBTITLE_MEDIA_POLICY.decodeDurationToleranceMs,
  );
  if (!Number.isSafeInteger(limit) || limit < durationMs) {
    throw invalidMediaConfiguration("The media decode duration limit is invalid.");
  }
  return limit;
}

function decodeOutputLimitBytes(durationLimitMs: number): number {
  const bytes =
    estimatePcmBytes(durationLimitMs) +
    LOCAL_SUBTITLE_MEDIA_POLICY.maxNormalizedWavHeaderBytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw invalidMediaConfiguration("The media decode byte limit is invalid.");
  }
  return Math.min(bytes, LOCAL_SUBTITLE_LIMITS.maxNormalizedPcmBytes);
}

function formatFfmpegDuration(durationMs: number): string {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw invalidMediaConfiguration("The media decode duration is invalid.");
  }
  return (durationMs / 1_000).toFixed(3);
}

function decodeTimeoutMs(durationMs: number): number {
  return Math.min(
    LOCAL_SUBTITLE_MEDIA_POLICY.maximumDecodeTimeoutMs,
    Math.max(
      LOCAL_SUBTITLE_MEDIA_POLICY.minimumDecodeTimeoutMs,
      Math.ceil(durationMs * LOCAL_SUBTITLE_MEDIA_POLICY.decodeTimeoutRatio),
    ),
  );
}

function reportProgress(
  callback: ((percentage: number) => void) | undefined,
  percentage: number,
): void {
  if (!callback) return;
  try {
    const result = callback(
      Math.max(0, Math.min(100, Math.floor(percentage))),
    ) as unknown;
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Progress observers cannot change native media lifecycle semantics.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function monotonicProgressReporter(
  callback: ((percentage: number) => void) | undefined,
): (percentage: number) => void {
  let last = -1;
  return (percentage) => {
    const normalized = Math.max(0, Math.min(100, Math.floor(percentage)));
    if (normalized <= last) return;
    last = normalized;
    reportProgress(callback, normalized);
  };
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  fallback: "probe_failed" | "decode_failed" | "runtime_launch_failed",
): void {
  if (!signal?.aborted) return;
  if (signal.reason === OWNER_RELEASED_ABORT_REASON) {
    throw ownerReleasedMediaFailure();
  }
  if (signal.reason === OWNER_FAULTED_ABORT_REASON) {
    throw ownerFaultedMediaFailure();
  }
  const localSubtitleCode =
    fallback === "runtime_launch_failed"
      ? "media_runtime_launch_failed"
      : fallback === "probe_failed"
        ? "media_probe_failed"
        : "media_decode_failed";
  throw mediaFailure(
    "aborted",
    localSubtitleCode,
    fallback === "runtime_launch_failed" ? "preflight" : "preparing_media",
    "The local subtitle media operation was aborted.",
  );
}

async function waitForOwnerOperationSlot(
  activeSettlements: ReadonlySet<Promise<void>>,
  signal: AbortSignal,
  fallback: "probe_failed" | "decode_failed" | "runtime_launch_failed",
): Promise<void> {
  throwIfAborted(signal, fallback);
  if (activeSettlements.size === 0) return;

  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal, fallback);
        reject(new Error("The media operation abort signal is invalid."));
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.race([...activeSettlements]),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function ownerReleasedMediaFailure(): LocalSubtitleMediaError {
  return mediaFailure(
    "aborted",
    "owner_released",
    "cleanup",
    "The local subtitle media owner was released.",
  );
}

function ownerFaultedMediaFailure(): LocalSubtitleMediaError {
  return mediaFailure(
    "cleanup_failed",
    "cleanup_failed",
    "cleanup",
    "The local subtitle media owner is fenced after unsafe cleanup.",
  );
}

function createMediaOwnerState(): MediaOwnerState {
  return {
    status: "active",
    controllers: new Set(),
    operationSettlements: new Set(),
    pendingOperationSettlements: new Set(),
    processCloseConfirmations: new Set(),
    pendingSessions: new Set(),
    sessionCleanupPromises: new Map(),
  };
}

function throwIfMediaOwnerUnavailable(state: MediaOwnerState): void {
  if (state.status === "released") throw ownerReleasedMediaFailure();
  if (state.status === "faulted") throw ownerFaultedMediaFailure();
}

function mediaChanged(): LocalSubtitleMediaError {
  return mediaFailure(
    "media_changed",
    "media_changed",
    "preparing_media",
    "The authorized media changed during preparation.",
  );
}

function invalidMediaConfiguration(message: string): LocalSubtitleMediaError {
  return mediaFailure(
    "invalid_configuration",
    "runtime_protocol_mismatch",
    "preflight",
    message,
  );
}

function mediaFailure(
  code: LocalSubtitleMediaErrorCode,
  localSubtitleCode: LocalSubtitleErrorCode,
  stage: LocalSubtitleOperationStage,
  message: string,
  cause?: unknown,
): LocalSubtitleMediaError {
  return new LocalSubtitleMediaError(
    code,
    localSubtitleCode,
    stage,
    message,
    cause === undefined ? {} : { cause },
  );
}

function assertOwner(owner: LocalSubtitleOwnerKey): void {
  if (
    !owner ||
    !Number.isSafeInteger(owner.webContentsId) ||
    owner.webContentsId <= 0 ||
    !isOpaqueId(owner.ownerSessionId)
  ) {
    throw invalidMediaConfiguration("The local subtitle media owner is invalid.");
  }
}

function ownerKey(owner: LocalSubtitleOwnerKey): string {
  return `${owner.webContentsId}:${owner.ownerSessionId}`;
}

function probeKey(owner: LocalSubtitleOwnerKey, fileToken: string): string {
  return `${ownerKey(owner)}:${fileToken}`;
}

function taskSelectionKey(owner: LocalSubtitleOwnerKey, taskId: string): string {
  return `${ownerKey(owner)}:${taskId}`;
}

function assertOpaqueId(value: string, label: string): void {
  if (!isOpaqueId(value)) {
    throw invalidMediaConfiguration(`The local subtitle ${label} is invalid.`);
  }
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LOCAL_SUBTITLE_LIMITS.maxOpaqueRefChars &&
    SAFE_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LOCAL_SUBTITLE_LIMITS.maxIdChars &&
    SAFE_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function mintOpaqueId(prefix: string, factory: () => string): string {
  const suffix = factory();
  const value = `${prefix}${suffix}`;
  if (!isOpaqueId(value)) {
    throw invalidMediaConfiguration("The media identity source is invalid.");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
