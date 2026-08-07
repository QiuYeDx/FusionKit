import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, type Server as NetServer } from "node:net";
import path from "node:path";
import {
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleBackend,
  type LocalSubtitleDiagnostics,
  type LocalSubtitleErrorCode,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_POLICY,
  LocalSubtitleServerContractError,
  validateLocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceResponse,
  type LocalSubtitleServerSessionDisposition,
} from "./server-contract";
import {
  LocalSubtitleServerHttpClient,
  type LocalSubtitleServerHealthResponse,
  type LocalSubtitleServerHttpEndpoint,
} from "./server-http-client";
import {
  canReuseLocalSubtitleServerLoadIdentity,
  createLocalSubtitleServerEndpoint,
  createLocalSubtitleServerLoadIdentity,
  createLocalSubtitleServerProcessDescriptor,
  type CreateLocalSubtitleServerLoadIdentityOptions,
  type LocalSubtitleServerEndpoint,
  type LocalSubtitleServerLoadIdentity,
  type LocalSubtitleServerProcessDescriptor,
  type LocalSubtitleServerPurpose,
} from "./server-process-contract";
import {
  createLocalSubtitleServerDiagnosticCollector,
  type LocalSubtitleServerDiagnosticCollector,
} from "./server-diagnostics";
import {
  LocalSubtitleServerSessionError,
  cleanupLocalSubtitleServerSession,
  createLocalSubtitleServerSession,
  verifyLocalSubtitleServerSession,
  type LocalSubtitleServerSession,
} from "./server-session";
import type { LocalSubtitleOwnerKey } from "./authorizations";
import { snapshotLocalSubtitleFileIdentity } from "./filesystem-object-identity";

const LEASE_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.server-supervisor-lease",
);
const RUNTIME_PIN_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.server-supervisor-runtime-pin",
);
const REQUEST_TICKET_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.server-supervisor-request",
);
const OWNER_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_ABSOLUTE_PATH_CHARS = 32_768;
const MAX_BACKEND_EVIDENCE_BYTES_PER_STREAM = 64 * 1024;
const BACKEND_EVIDENCE_BRAND: unique symbol = Symbol(
  "fusionkit.local-subtitle.server-backend-evidence",
);
const BACKEND_EVIDENCE_RECORDS = new WeakMap<
  LocalSubtitleServerBackendEvidence,
  BackendEvidenceRecord
>();

export const LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY = Object.freeze({
  startupTimeoutMs: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.startupTimeoutMs,
  startupPollIntervalMs: 100,
  idleTimeoutMs: 5 * 60 * 1_000,
  abortGraceMs: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.abortGraceMs,
  terminateGraceMs: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.terminateGraceMs,
  forceKillGraceMs: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.forceKillGraceMs,
  maxStartAttempts: 2,
} as const);

export type LocalSubtitleServerSupervisorState =
  | "unloaded"
  | "starting"
  | "ready"
  | "stopping"
  | "faulted"
  | "disposed";

export type LocalSubtitleServerSupervisorErrorCode =
  | "invalid_configuration"
  | "owner_released"
  | "resource_busy"
  | "launch_failed"
  | "startup_timeout"
  | "runtime_crashed"
  | "runtime_unresponsive"
  | "backend_mismatch"
  | "backend_unverified"
  | "stale_process_epoch"
  | "shutdown";

export class LocalSubtitleServerSupervisorError extends Error {
  readonly code: LocalSubtitleServerSupervisorErrorCode;
  readonly localSubtitleCode: LocalSubtitleErrorCode;
  readonly processEpoch?: number;
  readonly diagnostics?: LocalSubtitleDiagnostics;

  constructor(
    code: LocalSubtitleServerSupervisorErrorCode,
    message: string,
    options: {
      readonly localSubtitleCode: LocalSubtitleErrorCode;
      readonly processEpoch?: number;
      readonly diagnostics?: LocalSubtitleDiagnostics;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalSubtitleServerSupervisorError";
    this.code = code;
    this.localSubtitleCode = options.localSubtitleCode;
    this.processEpoch = options.processEpoch;
    this.diagnostics = options.diagnostics;
  }
}

type LocalSubtitleServerSupervisorLoadOptionsFor<
  Options extends CreateLocalSubtitleServerLoadIdentityOptions,
> = Options extends CreateLocalSubtitleServerLoadIdentityOptions
  ? Omit<Options, "managedResourceRoot"> & {
      readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
    }
  : never;

export type LocalSubtitleServerSupervisorLoadOptions =
  LocalSubtitleServerSupervisorLoadOptionsFor<CreateLocalSubtitleServerLoadIdentityOptions>;

export type LocalSubtitleServerModelLoadSmokeOptions = Extract<
  LocalSubtitleServerSupervisorLoadOptions,
  { readonly purpose: "model_load_smoke" }
>;

export type LocalSubtitleServerVadLoadSmokeOptions = Extract<
  LocalSubtitleServerSupervisorLoadOptions,
  { readonly purpose: "vad_load_smoke" }
>;

export type LocalSubtitleServerInferenceLoadOptions = Extract<
  LocalSubtitleServerSupervisorLoadOptions,
  { readonly purpose: "inference" }
>;

export interface LocalSubtitleServerLease {
  readonly [LEASE_BRAND]: true;
}

export interface LocalSubtitleServerRuntimePin {
  readonly [RUNTIME_PIN_BRAND]: true;
}

export interface LocalSubtitleServerRequestTicket {
  readonly [REQUEST_TICKET_BRAND]: true;
}

export interface LocalSubtitleServerInferenceOperation {
  readonly ticket: LocalSubtitleServerRequestTicket;
  readonly result: Promise<LocalSubtitleServerSupervisorInferenceResponse>;
}

export interface LocalSubtitleServerSupervisorInferenceResponse {
  readonly processEpoch: number;
  readonly response: LocalSubtitleServerInferenceResponse;
}

export interface LocalSubtitleServerReadySummary {
  readonly processEpoch: number;
  readonly processId: number;
  readonly purpose: LocalSubtitleServerPurpose;
  readonly backend: LocalSubtitleBackend;
  readonly modelId: string;
  readonly vadModelId?: string;
  readonly runtimeGeneration: string;
  readonly serverArtifactId: string;
  readonly backendVerified: true;
}

export interface LocalSubtitleServerSupervisorSnapshot {
  readonly state: LocalSubtitleServerSupervisorState;
  readonly processEpoch?: number;
  readonly processId?: number;
  readonly purpose?: LocalSubtitleServerPurpose;
  readonly backend?: LocalSubtitleBackend;
  readonly modelId?: string;
  readonly vadModelId?: string;
  readonly runtimeGeneration?: string;
  readonly serverArtifactId?: string;
  readonly leaseCount: number;
  readonly runtimePinCount: number;
  readonly activeRequest: boolean;
  readonly lastDiagnostics?: LocalSubtitleDiagnostics;
}

export interface LocalSubtitleServerBackendAttestation {
  readonly verified: true;
  readonly processEpoch: number;
  readonly processId: number;
  readonly backend: Exclude<LocalSubtitleBackend, "cpu">;
  readonly runtimeGeneration: string;
  readonly serverArtifactId: string;
  readonly acceleratorResourceId?: string;
  readonly acceleratorPackGeneration?: string;
}

export interface LocalSubtitleServerBackendEvidence {
  readonly [BACKEND_EVIDENCE_BRAND]: true;
}

export interface LocalSubtitleServerBackendAttestationContext {
  readonly processEpoch: number;
  readonly processId: number;
  readonly backend: Exclude<LocalSubtitleBackend, "cpu">;
  readonly runtimeGeneration: string;
  readonly serverArtifactId: string;
  readonly acceleratorResourceId?: string;
  readonly acceleratorPackGeneration?: string;
  readonly evidence: LocalSubtitleServerBackendEvidence;
  readonly signal: AbortSignal;
}

export interface LocalSubtitleLoopbackPortReservation {
  readonly port: number;
  release(): Promise<void>;
}

export interface LocalSubtitleServerHttpClientLike {
  readonly sessionDisposition: LocalSubtitleServerSessionDisposition;
  probeReadiness(signal?: AbortSignal): Promise<LocalSubtitleServerHealthResponse>;
  health(signal?: AbortSignal): Promise<LocalSubtitleServerHealthResponse>;
  inference(
    request: LocalSubtitleServerInferenceRequest,
  ): Promise<LocalSubtitleServerInferenceResponse>;
}

export interface LocalSubtitleServerSupervisorDependencies {
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly reservePort?: () => Promise<LocalSubtitleLoopbackPortReservation>;
  readonly createHttpClient?: (
    endpoint: LocalSubtitleServerHttpEndpoint,
  ) => LocalSubtitleServerHttpClientLike;
  readonly createSession?: (
    managedResourceRoot: string,
  ) => Promise<LocalSubtitleServerSession>;
  readonly verifySession?: (
    session: LocalSubtitleServerSession,
    options?: { readonly requireEmpty?: boolean },
  ) => Promise<void>;
  readonly cleanupSession?: (
    session: LocalSubtitleServerSession,
  ) => Promise<{ readonly removed: boolean }>;
  readonly verifyBackend?: (
    context: Readonly<LocalSubtitleServerBackendAttestationContext>,
  ) => Promise<LocalSubtitleServerBackendAttestation>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface LocalSubtitleServerSupervisorOptions {
  readonly managedResourceRoot: string;
  readonly startupTimeoutMs?: number;
  readonly startupPollIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly abortGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly forceKillGraceMs?: number;
  readonly maxStartAttempts?: number;
  readonly dependencies?: LocalSubtitleServerSupervisorDependencies;
}

interface LeaseRecord {
  readonly lease: LocalSubtitleServerLease;
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerKey: string;
  readonly loadOptions: LocalSubtitleServerSupervisorLoadOptions;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly runtimePin?: RuntimePinRecord;
  active: boolean;
}

interface RuntimePinRecord {
  readonly pin: LocalSubtitleServerRuntimePin;
  readonly pinKey: string;
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerKey: string;
  readonly batchId: string;
  readonly loadOptions: LocalSubtitleServerInferenceLoadOptions;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly childLeases: Set<LeaseRecord>;
  active: boolean;
}

interface ActiveRequest {
  readonly ticket: LocalSubtitleServerRequestTicket;
  readonly lease: LeaseRecord;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  readonly forceFailure: Promise<LocalSubtitleServerSupervisorError>;
  readonly force: (error: LocalSubtitleServerSupervisorError) => void;
  detachExternalAbort: () => void;
  processEpoch?: number;
  tainted: boolean;
}

interface ChildCloseInfo {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly spawnError?: Error;
}

interface ServerProcessEpoch {
  readonly processEpoch: number;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly session: LocalSubtitleServerSession;
  readonly endpoint: LocalSubtitleServerEndpoint;
  readonly descriptor: LocalSubtitleServerProcessDescriptor;
  readonly child: ChildProcess;
  readonly client: LocalSubtitleServerHttpClientLike;
  readonly diagnostics: LocalSubtitleServerDiagnosticCollector;
  readonly backendEvidence: LocalSubtitleServerBackendEvidence;
  readonly closePromise: Promise<ChildCloseInfo>;
  readonly detachDiagnostics: () => void;
  state: "starting" | "ready" | "tainted" | "stopping" | "closed" | "faulted";
  closeInfo?: ChildCloseInfo;
  cleanupPromise?: Promise<void>;
  finalizePromise?: Promise<void>;
  requestCount: number;
  backendVerified: boolean;
}

interface BackendEvidenceRecord {
  readonly processEpoch: number;
  readonly processId: number;
  readonly backend: LocalSubtitleBackend;
  readonly runtimeGeneration: string;
  readonly serverArtifactId: string;
  readonly watchers: Set<() => void>;
  readonly retained: Record<"stdout" | "stderr", Buffer>;
  initializationObserved: boolean;
  deviceObserved: boolean;
  failureObserved: boolean;
  disposed: boolean;
}

export class LocalSubtitleServerSupervisor {
  readonly #managedResourceRoot: string;
  readonly #startupTimeoutMs: number;
  readonly #startupPollIntervalMs: number;
  readonly #idleTimeoutMs: number;
  readonly #abortGraceMs: number;
  readonly #terminateGraceMs: number;
  readonly #forceKillGraceMs: number;
  readonly #maxStartAttempts: number;
  readonly #spawnProcess: NonNullable<
    LocalSubtitleServerSupervisorDependencies["spawnProcess"]
  >;
  readonly #reservePort: NonNullable<
    LocalSubtitleServerSupervisorDependencies["reservePort"]
  >;
  readonly #createHttpClient: NonNullable<
    LocalSubtitleServerSupervisorDependencies["createHttpClient"]
  >;
  readonly #createSession: NonNullable<
    LocalSubtitleServerSupervisorDependencies["createSession"]
  >;
  readonly #verifySession: NonNullable<
    LocalSubtitleServerSupervisorDependencies["verifySession"]
  >;
  readonly #cleanupSession: NonNullable<
    LocalSubtitleServerSupervisorDependencies["cleanupSession"]
  >;
  readonly #verifyBackend:
    | LocalSubtitleServerSupervisorDependencies["verifyBackend"]
    | undefined;
  readonly #now: () => number;
  readonly #delay: NonNullable<LocalSubtitleServerSupervisorDependencies["delay"]>;
  readonly #leases = new Map<LocalSubtitleServerLease, LeaseRecord>();
  readonly #runtimePins = new Map<LocalSubtitleServerRuntimePin, RuntimePinRecord>();
  readonly #runtimePinKeys = new Set<string>();
  readonly #releasedOwners = new Set<string>();
  readonly #activeOwners = new Set<string>();
  readonly #backgroundCleanup = new Set<Promise<void>>();
  #state: LocalSubtitleServerSupervisorState = "unloaded";
  #epoch: ServerProcessEpoch | undefined;
  #nextProcessEpoch = 1;
  #activeRequest: ActiveRequest | undefined;
  #startOwnerKey: string | undefined;
  #startLease: LeaseRecord | undefined;
  #startController: AbortController | undefined;
  #startPromise: Promise<void> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #idleTimerToken: object | undefined;
  #disposed = false;
  #shutdownPromise: Promise<void> | undefined;
  #lastDiagnostics: LocalSubtitleDiagnostics | undefined;
  #orphanedSession: LocalSubtitleServerSession | undefined;
  #startupFault: Error | undefined;

  constructor(options: LocalSubtitleServerSupervisorOptions) {
    this.#managedResourceRoot = validateManagedRoot(options.managedResourceRoot);
    this.#startupTimeoutMs = validateDuration(
      options.startupTimeoutMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.startupTimeoutMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.startupTimeoutMs,
      "startup timeout",
    );
    this.#startupPollIntervalMs = validateDuration(
      options.startupPollIntervalMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.startupPollIntervalMs,
      5_000,
      "startup poll interval",
    );
    this.#idleTimeoutMs = validateDuration(
      options.idleTimeoutMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.idleTimeoutMs,
      24 * 60 * 60 * 1_000,
      "idle timeout",
    );
    this.#abortGraceMs = validateDuration(
      options.abortGraceMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.abortGraceMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.abortGraceMs,
      "abort grace",
    );
    this.#terminateGraceMs = validateDuration(
      options.terminateGraceMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.terminateGraceMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.terminateGraceMs,
      "terminate grace",
    );
    this.#forceKillGraceMs = validateDuration(
      options.forceKillGraceMs,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.forceKillGraceMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.forceKillGraceMs,
      "force-kill grace",
    );
    this.#maxStartAttempts = validateCount(
      options.maxStartAttempts,
      LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.maxStartAttempts,
      4,
      "maximum start attempts",
    );

    const dependencies = options.dependencies ?? {};
    this.#spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
    this.#reservePort = dependencies.reservePort ?? reserveLocalSubtitleLoopbackPort;
    this.#createHttpClient =
      dependencies.createHttpClient ??
      ((endpoint) => new LocalSubtitleServerHttpClient(endpoint));
    this.#createSession =
      dependencies.createSession ?? createLocalSubtitleServerSession;
    this.#verifySession =
      dependencies.verifySession ?? verifyLocalSubtitleServerSession;
    this.#cleanupSession =
      dependencies.cleanupSession ?? cleanupLocalSubtitleServerSession;
    this.#verifyBackend = dependencies.verifyBackend;
    this.#now = dependencies.now ?? Date.now;
    this.#delay = dependencies.delay ?? delayWithSignal;
  }

  get snapshot(): LocalSubtitleServerSupervisorSnapshot {
    const epoch = this.#epoch;
    return deepFreeze({
      state: this.#state,
      ...(epoch === undefined
        ? {}
        : {
            processEpoch: epoch.processEpoch,
            ...(epoch.child.pid === undefined ? {} : { processId: epoch.child.pid }),
            purpose: epoch.loadIdentity.purpose,
            backend: epoch.loadIdentity.backend,
            modelId: epoch.loadIdentity.model.id,
            ...(epoch.loadIdentity.purpose === "model_load_smoke"
              ? {}
              : epoch.loadIdentity.vadModel === undefined
                ? {}
                : { vadModelId: epoch.loadIdentity.vadModel.id }),
            runtimeGeneration: epoch.loadIdentity.runtimeGeneration,
            serverArtifactId: epoch.loadIdentity.serverArtifact.id,
          }),
      leaseCount: this.#activeLeaseCount(),
      runtimePinCount: this.#activeRuntimePinCount(),
      activeRequest: this.#activeRequest !== undefined,
      ...(this.#lastDiagnostics === undefined
        ? {}
        : { lastDiagnostics: this.#lastDiagnostics }),
    });
  }

  isManagedAcceleratorBusy(resourceId: string): boolean {
    const matches = (identity: LocalSubtitleServerLoadIdentity) =>
      identity.purpose === "inference" &&
      identity.backend === "cuda" &&
      identity.acceleratorPack.resourceId === resourceId;
    return (
      (this.#epoch !== undefined && matches(this.#epoch.loadIdentity)) ||
      [...this.#runtimePins.values()].some(
        (record) => record.active && matches(record.loadIdentity),
      ) ||
      [...this.#leases.values()].some(
        (record) => record.active && matches(record.loadIdentity),
      )
    );
  }

  acquire(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerSupervisorLoadOptions,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerLease> {
    return this.#acquire(owner, loadOptions, signal);
  }

  async #acquire(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerSupervisorLoadOptions,
    signal?: AbortSignal,
    runtimePin?: RuntimePinRecord,
  ): Promise<LocalSubtitleServerLease> {
    this.#assertAvailable();
    if (this.#shutdownPromise) throw resourceBusyError();
    const ownerKey = validateOwner(owner);
    if (this.#releasedOwners.has(ownerKey)) throw ownerReleasedError();
    if (signal?.aborted) throw abortedSupervisorError();
    if (runtimePin) this.#assertRuntimePinCurrent(runtimePin);
    const canonicalLoadOptions = snapshotLoadOptions(loadOptions);
    const loadIdentity = createSupervisorLoadIdentity(
      canonicalLoadOptions,
      this.#managedResourceRoot,
    );
    if (
      runtimePin &&
      (runtimePin.ownerKey !== ownerKey ||
        !canReuseLocalSubtitleServerLoadIdentity(
          runtimePin.loadIdentity,
          loadIdentity,
        ))
    ) {
      throw ownerReleasedError();
    }
    this.#assertLoadCompatibleWithLeases(loadIdentity);
    this.#assertLoadCompatibleWithRuntimePins(loadIdentity);

    const lease = createLease();
    const record: LeaseRecord = {
      lease,
      owner: Object.freeze({ ...owner }),
      ownerKey,
      loadOptions: canonicalLoadOptions,
      loadIdentity,
      ...(runtimePin === undefined ? {} : { runtimePin }),
      active: true,
    };
    this.#leases.set(lease, record);
    runtimePin?.childLeases.add(record);

    const current = this.#epoch;
    if (
      loadIdentity.purpose === "inference" &&
      current?.state === "ready" &&
      canReuseLocalSubtitleServerLoadIdentity(current.loadIdentity, loadIdentity)
    ) {
      if (signal?.aborted) {
        this.#deactivateLease(record);
        throw abortedSupervisorError();
      }
      this.#registerActiveInferenceOwners(current);
      this.#scheduleIdleShutdown();
      return lease;
    }
    if (this.#startController || this.#activeRequest) {
      this.#deactivateLease(record);
      throw resourceBusyError();
    }

    const controller = new AbortController();
    const detach = forwardAbort(signal, controller, () => undefined);
    this.#startOwnerKey = ownerKey;
    this.#startLease = record;
    this.#startController = controller;
    let resolveStartOperation!: () => void;
    const startOperation = new Promise<void>((resolve) => {
      resolveStartOperation = resolve;
    });
    this.#startPromise = startOperation;
    const start = this.#ensureEpoch(record, controller.signal, false);
    let smokeRetirementStarted = false;
    try {
      const epoch = await start;
      this.#assertLeaseCurrent(record);
      if (record.loadIdentity.purpose !== "inference") {
        if (
          this.#epoch !== epoch ||
          epoch.state !== "ready" ||
          epoch.closeInfo !== undefined
        ) {
          throw crashedError(epoch);
        }
        smokeRetirementStarted = true;
        const retirement = this.#retireEpoch(
          epoch,
          `${record.loadIdentity.purpose}_complete`,
        );
        await retirement;
        this.#assertLeaseCurrent(record);
      } else {
        this.#registerActiveInferenceOwners(epoch);
        this.#scheduleIdleShutdown();
      }
      return lease;
    } catch (error) {
      this.#deactivateLease(record);
      let failure: unknown = error;
      if (
        this.#activeLeaseCount() === 0 &&
        !smokeRetirementStarted &&
        this.#epoch?.state !== "faulted"
      ) {
        await this.#retireCurrentEpoch("acquire_failed").catch((cleanupError) => {
          failure = cleanupError;
        });
      }
      throw this.#normalizeError(failure, this.#epoch);
    } finally {
      detach();
      if (this.#startPromise === startOperation) this.#startPromise = undefined;
      resolveStartOperation();
      if (this.#startController === controller) {
        this.#startController = undefined;
        this.#startOwnerKey = undefined;
        this.#startLease = undefined;
      }
    }
  }

  async acquireBatchRuntimePin(
    owner: LocalSubtitleOwnerKey,
    batchId: string,
    loadOptions: LocalSubtitleServerInferenceLoadOptions,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerRuntimePin> {
    this.#assertAvailable();
    if (this.#shutdownPromise) throw resourceBusyError();
    const ownerKey = validateOwner(owner);
    if (this.#releasedOwners.has(ownerKey)) throw ownerReleasedError();
    if (signal?.aborted) throw abortedSupervisorError();
    const canonicalBatchId = validateBatchId(batchId);
    const canonicalLoadOptions = snapshotLoadOptions(
      loadOptions,
    ) as LocalSubtitleServerInferenceLoadOptions;
    if (canonicalLoadOptions.purpose !== "inference") {
      throw invalidConfigurationError(
        "A batch runtime pin must use an inference load identity.",
      );
    }
    const loadIdentity = createSupervisorLoadIdentity(
      canonicalLoadOptions,
      this.#managedResourceRoot,
    );
    this.#assertLoadCompatibleWithLeases(loadIdentity);
    this.#assertLoadCompatibleWithRuntimePins(loadIdentity);
    const pinKey = `${ownerKey}\u0000${canonicalBatchId}`;
    if (this.#runtimePinKeys.has(pinKey)) throw resourceBusyError();

    const pin = createRuntimePin();
    const record: RuntimePinRecord = {
      pin,
      pinKey,
      owner: Object.freeze({ ...owner }),
      ownerKey,
      batchId: canonicalBatchId,
      loadOptions: canonicalLoadOptions,
      loadIdentity,
      childLeases: new Set<LeaseRecord>(),
      active: true,
    };
    this.#runtimePins.set(pin, record);
    this.#runtimePinKeys.add(pinKey);
    this.#clearIdleTimer();

    let lease: LocalSubtitleServerLease | undefined;
    try {
      lease = await this.#acquire(owner, canonicalLoadOptions, signal, record);
      this.#assertRuntimePinCurrent(record);
      const leaseRecord = this.#requireLease(lease);
      if (
        !canReuseLocalSubtitleServerLoadIdentity(
          record.loadIdentity,
          leaseRecord.loadIdentity,
        )
      ) {
        throw invalidConfigurationError(
          "The pinned local inference load identity changed during startup.",
        );
      }
      this.#deactivateLease(leaseRecord);
      lease = undefined;
      this.#clearIdleTimer();
      return pin;
    } catch (error) {
      let failure: unknown = error;
      if (lease !== undefined) {
        try {
          await this.release(lease);
        } catch (cleanupError) {
          failure = cleanupError;
        }
      }
      this.#deactivateRuntimePin(record);
      this.#scheduleIdleShutdown();
      throw this.#normalizeError(failure, this.#epoch);
    }
  }

  async acquirePinnedTaskLease(
    pin: LocalSubtitleServerRuntimePin,
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerLease> {
    const record = this.#requireRuntimePin(pin);
    this.#assertRuntimePinCurrent(record);
    if (signal?.aborted) throw abortedSupervisorError();
    const lease = await this.#acquire(
      record.owner,
      record.loadOptions,
      signal,
      record,
    );
    try {
      this.#assertRuntimePinCurrent(record);
      const leaseRecord = this.#requireLease(lease);
      if (
        !canReuseLocalSubtitleServerLoadIdentity(
          record.loadIdentity,
          leaseRecord.loadIdentity,
        )
      ) {
        throw invalidConfigurationError(
          "The task lease does not match its pinned runtime identity.",
        );
      }
      return lease;
    } catch (error) {
      await this.release(lease);
      throw error;
    }
  }

  releaseBatchRuntimePin(pin: LocalSubtitleServerRuntimePin): void {
    if (!isRuntimePin(pin)) return;
    const record = this.#runtimePins.get(pin);
    if (!record?.active) return;
    this.#deactivateRuntimePin(record);
    this.#scheduleIdleShutdown();
  }

  async smokeModelLoad(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerModelLoadSmokeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    let lease: LocalSubtitleServerLease | undefined;
    try {
      lease = await this.acquire(owner, loadOptions, signal);
    } finally {
      if (lease !== undefined) await this.release(lease);
    }
  }

  async smokeVadLoad(
    owner: LocalSubtitleOwnerKey,
    loadOptions: LocalSubtitleServerVadLoadSmokeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    let lease: LocalSubtitleServerLease | undefined;
    try {
      lease = await this.acquire(owner, loadOptions, signal);
    } finally {
      if (lease !== undefined) await this.release(lease);
    }
  }

  beginInference(
    lease: LocalSubtitleServerLease,
    request: LocalSubtitleServerInferenceRequest,
  ): LocalSubtitleServerInferenceOperation {
    this.#assertAvailable();
    const leaseRecord = this.#requireLease(lease);
    this.#assertLeaseCurrent(leaseRecord);
    if (leaseRecord.loadIdentity.purpose !== "inference") {
      throw invalidConfigurationError(
        "A load smoke lease cannot run inference.",
      );
    }
    if (this.#activeRequest || this.#startController || this.#shutdownPromise) {
      throw resourceBusyError();
    }
    validateLocalSubtitleServerInferenceRequest(request);
    const canonicalRequest = snapshotInferenceRequest(request);
    if (
      canonicalRequest.vadEnabled !==
        (leaseRecord.loadIdentity.vadModel !== undefined)
    ) {
      throw invalidConfigurationError(
        "The inference VAD request does not match the loaded VAD identity.",
      );
    }
    this.#clearIdleTimer();

    const ticket = createRequestTicket();
    const controller = new AbortController();
    const settledDeferred = createDeferred<void>();
    const forceDeferred = createDeferred<LocalSubtitleServerSupervisorError>();
    const active: ActiveRequest = {
      ticket,
      lease: leaseRecord,
      controller,
      settled: settledDeferred.promise,
      settle: () => settledDeferred.resolve(undefined),
      forceFailure: forceDeferred.promise,
      force: (error) => forceDeferred.resolve(error),
      detachExternalAbort: () => undefined,
      tainted: false,
    };
    active.detachExternalAbort = forwardAbort(
      canonicalRequest.signal,
      controller,
      () => {
        this.#fenceActiveRequest(active);
      },
    );
    this.#activeRequest = active;

    const result = this.#runInference(active, canonicalRequest).finally(() => {
      active.detachExternalAbort();
      if (this.#activeRequest === active) this.#activeRequest = undefined;
      active.settle();
      this.#scheduleIdleShutdown();
    });
    return Object.freeze({ ticket, result });
  }

  async cancelRequest(ticket: LocalSubtitleServerRequestTicket): Promise<void> {
    const active = this.#activeRequest;
    if (!active || active.ticket !== ticket || !isRequestTicket(ticket)) return;
    this.#fenceActiveRequest(active);
    active.controller.abort();
    if (await settlesWithin(active.settled, this.#abortGraceMs)) return;

    let retirementError: unknown;
    try {
      await this.#retireCurrentEpoch("cancel_timeout");
    } catch (error) {
      retirementError = error;
    }
    active.force(
      retirementError instanceof LocalSubtitleServerSupervisorError
        ? retirementError
        : new LocalSubtitleServerSupervisorError(
            "runtime_unresponsive",
            "The local inference request did not settle after cancellation.",
            {
              localSubtitleCode: "runtime_unresponsive",
              processEpoch: active.processEpoch,
              cause: retirementError,
            },
          ),
    );
    await active.settled;
  }

  async release(lease: LocalSubtitleServerLease): Promise<void> {
    const record = this.#leases.get(lease);
    if (!record?.active || !isLease(lease)) return;
    const start = this.#startPromise;
    this.#deactivateLease(record);
    const active = this.#activeRequest;
    if (active?.lease === record) {
      this.#fenceActiveRequest(active);
      active.controller.abort();
      await this.cancelRequest(active.ticket);
    }
    await start;
    if (this.#activeLeaseCount() === 0) {
      this.#scheduleIdleShutdown();
    }
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    const ownerKey = validateOwner(owner);
    this.#releasedOwners.add(ownerKey);
    this.#activeOwners.delete(ownerKey);
    for (const record of this.#runtimePins.values()) {
      if (record.ownerKey === ownerKey) this.#deactivateRuntimePin(record);
    }
    for (const record of this.#leases.values()) {
      if (record.ownerKey === ownerKey) this.#deactivateLease(record);
    }
    if (this.#startOwnerKey === ownerKey) this.#startController?.abort();

    const active = this.#activeRequest;
    if (active?.lease.ownerKey === ownerKey) {
      this.#fenceActiveRequest(active);
      active.controller.abort();
    }
    const cleanup = this.#cleanupAfterOwnerRelease(
      active,
      ownerKey,
      this.#startPromise,
    );
    this.#trackBackgroundCleanup(cleanup);
  }

  shutdown(
    reason: "idle" | "last_owner" | "app_quit" | "update" | "fatal" = "app_quit",
  ): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    const terminal =
      reason === "app_quit" || reason === "update" || reason === "fatal";
    if (!terminal && this.#activeRuntimePinCount() > 0) {
      return Promise.reject(resourceBusyError());
    }
    let resolveOperation!: () => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#shutdownPromise = operation;

    void (async () => {
      if (terminal) {
        this.#disposed = true;
        this.#state = "disposed";
        this.#activeOwners.clear();
        for (const record of this.#runtimePins.values()) {
          this.#deactivateRuntimePin(record);
        }
        for (const record of this.#leases.values()) this.#deactivateLease(record);
      }
      this.#clearIdleTimer();
      this.#startController?.abort();
      const start = this.#startPromise;
      const active = this.#activeRequest;
      if (active) {
        this.#fenceActiveRequest(active);
        active.controller.abort();
      }

      await start;
      if (active && !(await settlesWithin(active.settled, this.#abortGraceMs))) {
        let retirementError: unknown;
        try {
          await this.#retireCurrentEpoch(reason);
        } catch (error) {
          retirementError = error;
        }
        active.force(
          retirementError instanceof LocalSubtitleServerSupervisorError
            ? retirementError
            : shutdownError(active.processEpoch, retirementError),
        );
        await active.settled;
      }
      await this.#retireCurrentEpoch(reason);
      await this.#cleanupOrphanedSession();
      await this.drainBackgroundCleanup();
      if (!this.#disposed) this.#state = "unloaded";
    })().then(
      () => {
        if (this.#shutdownPromise === operation) this.#shutdownPromise = undefined;
        if (this.#disposed) this.#state = "disposed";
        resolveOperation();
      },
      (error: unknown) => {
        if (this.#shutdownPromise === operation) this.#shutdownPromise = undefined;
        if (this.#disposed) this.#state = "disposed";
        rejectOperation(error);
      },
    );
    return operation;
  }

  async drainBackgroundCleanup(): Promise<void> {
    while (this.#backgroundCleanup.size > 0) {
      await Promise.allSettled([...this.#backgroundCleanup]);
    }
  }

  async #runInference(
    active: ActiveRequest,
    request: LocalSubtitleServerInferenceRequest,
  ): Promise<LocalSubtitleServerSupervisorInferenceResponse> {
    const work = this.#executeInference(active, request).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const forced = active.forceFailure.then((error) => ({
      status: "rejected" as const,
      error,
    }));
    const outcome = await Promise.race([work, forced]);
    if (outcome.status === "rejected") throw outcome.error;
    return outcome.value;
  }

  async #executeInference(
    active: ActiveRequest,
    request: LocalSubtitleServerInferenceRequest,
  ): Promise<LocalSubtitleServerSupervisorInferenceResponse> {
    let epoch: ServerProcessEpoch | undefined;
    try {
      if (active.controller.signal.aborted) {
        throw abortedSupervisorError();
      }
      const current = this.#epoch;
      if (
        current?.state === "ready" &&
        canReuseLocalSubtitleServerLoadIdentity(
          current.loadIdentity,
          active.lease.loadIdentity,
        )
      ) {
        active.processEpoch = current.processEpoch;
      }
      epoch = await this.#ensureEpoch(
        active.lease,
        active.controller.signal,
        true,
      );
      active.processEpoch = epoch.processEpoch;
      this.#assertActiveRequest(active, epoch);
      this.#registerActiveInferenceOwners(epoch);

      const response = await epoch.client.inference(Object.freeze({
        ...request,
        signal: active.controller.signal,
      }));
      this.#assertActiveRequest(active, epoch);
      epoch.requestCount += 1;
      return deepFreeze({ processEpoch: epoch.processEpoch, response });
    } catch (error) {
      if (
        epoch &&
        (active.tainted ||
          epoch.state === "tainted" ||
          epoch.state === "closed" ||
          requiresRestart(error))
      ) {
        await this.#retireEpoch(epoch, "inference_failed").catch((cleanupError) => {
          error = cleanupError;
        });
      }
      throw this.#normalizeError(error, epoch);
    }
  }

  async #ensureEpoch(
    lease: LeaseRecord,
    signal: AbortSignal,
    checkRuntimeHealth: boolean,
  ): Promise<ServerProcessEpoch> {
    this.#assertLeaseCurrent(lease);
    if (signal.aborted) throw abortedSupervisorError();
    const current = this.#epoch;
    if (current?.state === "faulted") {
      throw new LocalSubtitleServerSupervisorError(
        "runtime_unresponsive",
        "The prior local inference process did not close safely.",
        {
          localSubtitleCode: "runtime_unresponsive",
          processEpoch: current.processEpoch,
          diagnostics: this.#lastDiagnostics,
        },
      );
    }
    if (
      current?.state === "ready" &&
      canReuseLocalSubtitleServerLoadIdentity(
        current.loadIdentity,
        lease.loadIdentity,
      )
    ) {
      if (checkRuntimeHealth) {
        try {
          await current.client.health(signal);
        } catch (error) {
          current.state = "tainted";
          await this.#retireEpoch(current, "runtime_health_failed");
          throw error;
        }
      }
      return current;
    }
    if (current) {
      await this.#retireEpoch(current, "load_identity_changed");
      this.#assertLeaseAndSignal(lease, signal);
    }
    return this.#startEpoch(lease, signal);
  }

  #startEpoch(
    lease: LeaseRecord,
    signal: AbortSignal,
  ): Promise<ServerProcessEpoch> {
    return this.#runStartEpoch(lease, signal);
  }

  async #runStartEpoch(
    lease: LeaseRecord,
    signal: AbortSignal,
  ): Promise<ServerProcessEpoch> {
    const deadline = this.#now() + this.#startupTimeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxStartAttempts; attempt += 1) {
      this.#state = "starting";
      try {
        return await this.#startEpochAttempt(lease, signal, deadline);
      } catch (error) {
        lastError = error;
        if (
          attempt >= this.#maxStartAttempts ||
          this.#now() >= deadline ||
          !isRetryableStartFailure(error)
        ) {
          throw error;
        }
        this.#assertLeaseAndSignal(lease, signal);
      }
    }
    throw lastError;
  }

  async #startEpochAttempt(
    lease: LeaseRecord,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ServerProcessEpoch> {
    const processEpoch = this.#nextProcessEpoch;
    this.#nextProcessEpoch += 1;
    let reservation: LocalSubtitleLoopbackPortReservation | undefined;
    let session: LocalSubtitleServerSession | undefined;
    let epoch: ServerProcessEpoch | undefined;

    try {
      this.#assertLeaseAndSignal(lease, signal);
      session = await this.#createSession(this.#managedResourceRoot);
      this.#assertLeaseAndSignal(lease, signal);
      reservation = await this.#reservePort();
      this.#assertLeaseAndSignal(lease, signal);
      const endpoint = createLocalSubtitleServerEndpoint({
        port: reservation.port,
      });
      const descriptor = createSupervisorProcessDescriptor(lease.loadOptions, {
        endpoint,
        managedResourceRoot: this.#managedResourceRoot,
        sessionRoot: session.root,
        emptyPublicDirectory: session.publicDirectory,
        temporaryDirectory: session.temporaryDirectory,
      });
      if (
        !canReuseLocalSubtitleServerLoadIdentity(
          descriptor.loadIdentity,
          lease.loadIdentity,
        )
      ) {
        throw invalidConfigurationError(
          "The local inference load identity changed before launch.",
        );
      }
      await this.#verifySession(session, { requireEmpty: true });
      this.#assertLeaseAndSignal(lease, signal);
      await reservation.release();
      reservation = undefined;
      await this.#verifySession(session, { requireEmpty: true });
      this.#assertLeaseAndSignal(lease, signal);

      const diagnostics = createLocalSubtitleServerDiagnosticCollector({
        privateValues: [
          descriptor.command,
          descriptor.loadIdentity.runtimeRoot,
          descriptor.loadIdentity.managedResourceRoot,
          descriptor.loadIdentity.model.absolutePath,
          ...(descriptor.loadIdentity.purpose === "inference" &&
            descriptor.loadIdentity.backend === "cuda"
            ? [descriptor.loadIdentity.acceleratorPack.root]
            : []),
          ...(descriptor.loadIdentity.purpose === "inference" &&
            descriptor.loadIdentity.vadModel !== undefined
            ? [descriptor.loadIdentity.vadModel.absolutePath]
            : []),
          session.baseRoot,
          session.root,
          session.publicDirectory,
          session.temporaryDirectory,
          endpoint.privatePath,
          String(endpoint.port),
        ],
      });
      const client = this.#createHttpClient(endpoint);
      let child: ChildProcess;
      try {
        const spawnOptions: SpawnOptions = {
          cwd: descriptor.spawnOptions.cwd,
          env: { ...descriptor.spawnOptions.env } as NodeJS.ProcessEnv,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        };
        child = this.#spawnProcess(
          descriptor.command,
          descriptor.args,
          spawnOptions,
        );
      } catch (error) {
        throw new LocalSubtitleServerSupervisorError(
          "launch_failed",
          "The local inference process could not be launched.",
          {
            localSubtitleCode: "runtime_crashed",
            processEpoch,
            cause: error,
          },
        );
      }
      epoch = createEpoch({
        processEpoch,
        loadIdentity: lease.loadIdentity,
        session,
        endpoint,
        descriptor,
        child,
        client,
        diagnostics,
      });
      this.#epoch = epoch;
      if (this.#activeRequest?.lease === lease) {
        this.#activeRequest.processEpoch = epoch.processEpoch;
      }
      this.#observeEpochClose(epoch);
      if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) < 1) {
        throw new LocalSubtitleServerSupervisorError(
          "launch_failed",
          "The local inference process did not expose a valid process id.",
          {
            localSubtitleCode: "runtime_crashed",
            processEpoch,
          },
        );
      }
      await this.#waitUntilReady(epoch, signal, deadline);
      this.#assertLeaseAndSignal(lease, signal);
      await this.#verifyBackendAttestation(epoch, signal, deadline);
      this.#assertLeaseAndSignal(lease, signal);
      if (epoch.closeInfo) throw crashedError(epoch);
      epoch.state = "ready";
      this.#state = "ready";
      return epoch;
    } catch (error) {
      let failure: unknown = error;
      await reservation?.release().catch((cleanupError) => {
        failure = cleanupError;
      });
      if (epoch) {
        await this.#retireEpoch(epoch, "startup_failed").catch((cleanupError) => {
          failure = cleanupError;
        });
      } else if (session) {
        try {
          await this.#cleanupSession(session);
          if (!this.#disposed) this.#state = "unloaded";
        } catch (cleanupError) {
          failure = this.#normalizeError(cleanupError, undefined);
          this.#orphanedSession = session;
          this.#startupFault = failure as Error;
          if (!this.#disposed) this.#state = "faulted";
        }
      }
      throw failure;
    }
  }

  async #waitUntilReady(
    epoch: ServerProcessEpoch,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    const closeFailure = epoch.closePromise.then(() => {
      throw crashedError(epoch);
    });
    while (this.#now() < deadline) {
      if (signal.aborted) throw abortedSupervisorError();
      if (epoch.closeInfo) throw crashedError(epoch);
      try {
        await Promise.race([
          epoch.client.probeReadiness(signal),
          closeFailure,
        ]);
        if (epoch.closeInfo) throw crashedError(epoch);
        return;
      } catch (error) {
        if (signal.aborted) throw abortedSupervisorError();
        if (epoch.closeInfo) throw crashedError(epoch);
        if (!isRetryableReadinessError(error)) throw error;
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) break;
      await Promise.race([
        this.#delay(
          Math.min(this.#startupPollIntervalMs, remaining),
          signal,
        ),
        closeFailure,
      ]);
    }
    throw new LocalSubtitleServerSupervisorError(
      "startup_timeout",
      "The local inference process did not become ready before the deadline.",
      {
        localSubtitleCode: "runtime_unresponsive",
        processEpoch: epoch.processEpoch,
      },
    );
  }

  async #verifyBackendAttestation(
    epoch: ServerProcessEpoch,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    const backend = epoch.loadIdentity.backend;
    if (backend === "cpu") {
      if (
        !epoch.loadIdentity.process.noGpu ||
        epoch.descriptor.args.filter((value) => value === "--no-gpu").length !== 1
      ) {
        throw backendUnverifiedError(epoch);
      }
      epoch.backendVerified = true;
      return;
    }
    if (!this.#verifyBackend) throw backendUnverifiedError(epoch);
    if (
      !Number.isSafeInteger(epoch.child.pid) ||
      (epoch.child.pid ?? 0) < 1
    ) {
      throw backendUnverifiedError(epoch);
    }
    if (signal.aborted) throw abortedSupervisorError();
    const attestationController = new AbortController();
    const detachAbort = forwardAbort(
      signal,
      attestationController,
      () => undefined,
    );
    const expected = {
      processEpoch: epoch.processEpoch,
      processId: epoch.child.pid!,
      backend,
      runtimeGeneration: epoch.loadIdentity.runtimeGeneration,
      serverArtifactId: epoch.loadIdentity.serverArtifact.id,
      ...(epoch.loadIdentity.purpose === "inference" &&
        epoch.loadIdentity.backend === "cuda"
        ? {
            acceleratorResourceId:
              epoch.loadIdentity.acceleratorPack.resourceId,
            acceleratorPackGeneration:
              epoch.loadIdentity.acceleratorPack.packGeneration,
          }
        : {}),
      evidence: epoch.backendEvidence,
      signal: attestationController.signal,
    } as const;
    let attestation: LocalSubtitleServerBackendAttestation;
    try {
      attestation = await waitForBackendAttestation({
        operation: this.#verifyBackend(expected),
        epoch,
        controller: attestationController,
        deadlineMs: Math.max(0, deadline - this.#now()),
      });
    } catch (error) {
      if (
        error instanceof LocalSubtitleServerSupervisorError ||
        error instanceof LocalSubtitleServerContractError
      ) {
        throw error;
      }
      throw backendUnverifiedError(epoch, error);
    } finally {
      detachAbort();
    }
    const attestationRecord = typeof attestation === "object" && attestation !== null
      ? attestation as unknown as Record<string, unknown>
      : undefined;
    if (
      attestationRecord?.verified === true &&
      (attestationRecord.backend !== expected.backend ||
        attestationRecord.runtimeGeneration !== expected.runtimeGeneration ||
        attestationRecord.serverArtifactId !== expected.serverArtifactId ||
        attestationRecord.acceleratorResourceId !==
          expected.acceleratorResourceId ||
        attestationRecord.acceleratorPackGeneration !==
          expected.acceleratorPackGeneration)
    ) {
      throw backendMismatchError(epoch);
    }
    if (
      typeof attestation !== "object" ||
      attestation === null ||
      attestation.verified !== true ||
      attestation.processEpoch !== expected.processEpoch ||
      attestation.processId !== expected.processId ||
      attestation.backend !== expected.backend ||
      attestation.runtimeGeneration !== expected.runtimeGeneration ||
      attestation.serverArtifactId !== expected.serverArtifactId ||
      attestation.acceleratorResourceId !== expected.acceleratorResourceId ||
      attestation.acceleratorPackGeneration !==
        expected.acceleratorPackGeneration ||
      Object.keys(attestation).sort().join(",") !==
        [
          "backend",
          "processEpoch",
          "processId",
          "runtimeGeneration",
          "serverArtifactId",
          "verified",
          ...(expected.backend === "cuda"
            ? ["acceleratorPackGeneration", "acceleratorResourceId"]
            : []),
        ]
          .sort()
          .join(",")
    ) {
      throw backendUnverifiedError(epoch);
    }
    epoch.backendVerified = true;
  }

  async #retireCurrentEpoch(reason: string): Promise<void> {
    const epoch = this.#epoch;
    if (!epoch) {
      if (!this.#disposed && !this.#startupFault) this.#state = "unloaded";
      return;
    }
    return this.#retireEpoch(epoch, reason);
  }

  async #retireEpoch(epoch: ServerProcessEpoch, _reason: string): Promise<void> {
    if (epoch.cleanupPromise) return epoch.cleanupPromise;
    if (epoch.state === "closed") return;
    epoch.state = "stopping";
    if (this.#epoch === epoch && !this.#disposed) this.#state = "stopping";
    if (this.#epoch === epoch) this.#clearIdleTimer();

    const cleanup = (async () => {
      if (!epoch.closeInfo) {
        try {
          epoch.child.kill();
        } catch {
          // The close deadline below is authoritative.
        }
        if (!(await settlesWithin(epoch.closePromise, this.#terminateGraceMs))) {
          try {
            epoch.child.kill("SIGKILL");
          } catch {
            // The close deadline below is authoritative.
          }
          if (!(await settlesWithin(epoch.closePromise, this.#forceKillGraceMs))) {
            epoch.state = "faulted";
            if (this.#epoch === epoch) this.#state = "faulted";
            throw new LocalSubtitleServerSupervisorError(
              "runtime_unresponsive",
              "The local inference process did not close after force termination.",
              {
                localSubtitleCode: "runtime_unresponsive",
                processEpoch: epoch.processEpoch,
              },
            );
          }
        }
      }
      await this.#finalizeClosedEpoch(epoch);
    })();
    epoch.cleanupPromise = cleanup.catch((error) => {
      epoch.cleanupPromise = undefined;
      throw error;
    });
    return epoch.cleanupPromise;
  }

  async #finalizeClosedEpoch(epoch: ServerProcessEpoch): Promise<void> {
    if (epoch.finalizePromise) return epoch.finalizePromise;
    const finalize = (async () => {
      if (!epoch.closeInfo) await epoch.closePromise;
      epoch.detachDiagnostics();
      const diagnostics = epoch.diagnostics.finish();
      this.#lastDiagnostics = diagnostics;
      try {
        await this.#cleanupSession(epoch.session);
      } catch (error) {
        epoch.state = "faulted";
        if (this.#epoch === epoch) this.#state = "faulted";
        throw error instanceof LocalSubtitleServerSessionError
          ? this.#normalizeError(error, epoch)
          : new LocalSubtitleServerSupervisorError(
              "runtime_unresponsive",
              "The local inference session could not be cleaned up safely.",
              {
                localSubtitleCode: "runtime_unresponsive",
                processEpoch: epoch.processEpoch,
                diagnostics: this.#lastDiagnostics,
                cause: error,
              },
            );
      }
      epoch.state = "closed";
      if (this.#epoch === epoch) {
        this.#epoch = undefined;
        this.#activeOwners.clear();
        if (!this.#disposed) this.#state = "unloaded";
      }
    })();
    const observed = finalize.catch((error) => {
      if (epoch.finalizePromise === observed) epoch.finalizePromise = undefined;
      throw error;
    });
    epoch.finalizePromise = observed;
    return observed;
  }

  #observeEpochClose(epoch: ServerProcessEpoch): void {
    void epoch.closePromise.then(() => {
      if (epoch.state === "closed") return;
      const expectedClose = epoch.state === "stopping";
      if (expectedClose) return;
      const runtimeClose = epoch.state === "ready";
      if (epoch.state !== "faulted") {
        epoch.state = "tainted";
        if (this.#epoch === epoch && !this.#disposed) this.#state = "stopping";
        const active = runtimeClose ? this.#activeRequest : undefined;
        if (active?.processEpoch === epoch.processEpoch) {
          this.#fenceActiveRequest(active);
          active.controller.abort();
          active.force(crashedError(epoch));
        }
      }
      const cleanup = this.#retireEpoch(epoch, "unexpected_close").catch(
        () => undefined,
      );
      this.#trackBackgroundCleanup(cleanup);
    });
  }

  #fenceActiveRequest(active: ActiveRequest): void {
    active.tainted = true;
    const epoch =
      active.processEpoch !== undefined &&
        this.#epoch?.processEpoch === active.processEpoch
        ? this.#epoch
        : undefined;
    if (epoch) epoch.state = "tainted";
  }

  #assertActiveRequest(active: ActiveRequest, epoch: ServerProcessEpoch): void {
    if (
      this.#activeRequest !== active ||
      active.tainted ||
      active.controller.signal.aborted ||
      this.#epoch !== epoch ||
      epoch.state !== "ready" ||
      epoch.closeInfo
    ) {
      throw new LocalSubtitleServerSupervisorError(
        "stale_process_epoch",
        "A stale local inference result was discarded.",
        {
          localSubtitleCode: "runtime_crashed",
          processEpoch: epoch.processEpoch,
        },
      );
    }
  }

  #assertLeaseAndSignal(lease: LeaseRecord, signal: AbortSignal): void {
    this.#assertLeaseCurrent(lease);
    if (signal.aborted) throw abortedSupervisorError();
  }

  #assertLeaseCurrent(record: LeaseRecord): void {
    if (
      !record.active ||
      this.#leases.get(record.lease) !== record ||
      this.#releasedOwners.has(record.ownerKey) ||
      (record.runtimePin !== undefined &&
        (!record.runtimePin.active ||
          this.#runtimePins.get(record.runtimePin.pin) !== record.runtimePin))
    ) {
      throw ownerReleasedError();
    }
  }

  #requireLease(lease: LocalSubtitleServerLease): LeaseRecord {
    if (!isLease(lease)) throw ownerReleasedError();
    const record = this.#leases.get(lease);
    if (!record) throw ownerReleasedError();
    return record;
  }

  #assertLoadCompatibleWithLeases(
    requested: LocalSubtitleServerLoadIdentity,
  ): void {
    for (const record of this.#leases.values()) {
      if (
        record.active &&
        !canReuseLocalSubtitleServerLoadIdentity(record.loadIdentity, requested)
      ) {
        throw resourceBusyError();
      }
    }
  }

  #assertLoadCompatibleWithRuntimePins(
    requested: LocalSubtitleServerLoadIdentity,
  ): void {
    for (const record of this.#runtimePins.values()) {
      if (
        record.active &&
        !canReuseLocalSubtitleServerLoadIdentity(record.loadIdentity, requested)
      ) {
        throw resourceBusyError();
      }
    }
  }

  #deactivateLease(record: LeaseRecord): void {
    if (!record.active) return;
    record.active = false;
    this.#leases.delete(record.lease);
    record.runtimePin?.childLeases.delete(record);
  }

  #requireRuntimePin(pin: LocalSubtitleServerRuntimePin): RuntimePinRecord {
    if (!isRuntimePin(pin)) throw ownerReleasedError();
    const record = this.#runtimePins.get(pin);
    if (!record) throw ownerReleasedError();
    return record;
  }

  #assertRuntimePinCurrent(record: RuntimePinRecord): void {
    if (
      !record.active ||
      this.#runtimePins.get(record.pin) !== record ||
      this.#releasedOwners.has(record.ownerKey)
    ) {
      throw ownerReleasedError();
    }
  }

  #deactivateRuntimePin(record: RuntimePinRecord): void {
    if (!record.active) return;
    record.active = false;
    this.#runtimePins.delete(record.pin);
    this.#runtimePinKeys.delete(record.pinKey);
    if (this.#startLease?.runtimePin === record) this.#startController?.abort();
    const active = this.#activeRequest;
    for (const lease of [...record.childLeases]) this.#deactivateLease(lease);
    if (active?.lease.runtimePin === record) {
      this.#fenceActiveRequest(active);
      active.controller.abort();
      this.#trackBackgroundCleanup(this.cancelRequest(active.ticket));
    }
  }

  #activeLeaseCount(): number {
    let count = 0;
    for (const record of this.#leases.values()) {
      if (record.active) count += 1;
    }
    return count;
  }

  #activeRuntimePinCount(): number {
    let count = 0;
    for (const record of this.#runtimePins.values()) {
      if (record.active) count += 1;
    }
    return count;
  }

  #registerActiveInferenceOwners(epoch: ServerProcessEpoch): void {
    if (this.#epoch !== epoch || epoch.state !== "ready") return;
    for (const record of this.#leases.values()) {
      if (
        record.active &&
        record.loadIdentity.purpose === "inference" &&
        canReuseLocalSubtitleServerLoadIdentity(
          epoch.loadIdentity,
          record.loadIdentity,
        )
      ) {
        this.#activeOwners.add(record.ownerKey);
      }
    }
    for (const record of this.#runtimePins.values()) {
      if (
        record.active &&
        canReuseLocalSubtitleServerLoadIdentity(
          epoch.loadIdentity,
          record.loadIdentity,
        )
      ) {
        this.#activeOwners.add(record.ownerKey);
      }
    }
  }

  async #cleanupAfterOwnerRelease(
    active: ActiveRequest | undefined,
    ownerKey: string,
    start: Promise<void> | undefined,
  ): Promise<void> {
    await start;
    if (active?.lease.ownerKey === ownerKey) {
      await this.cancelRequest(active.ticket).catch(() => undefined);
    }
    if (
      this.#activeLeaseCount() === 0 &&
      this.#activeRuntimePinCount() === 0 &&
      this.#activeOwners.size === 0
    ) {
      await this.#retireCurrentEpoch("owner_released");
    } else {
      this.#scheduleIdleShutdown();
    }
  }

  #trackBackgroundCleanup(promise: Promise<void>): void {
    const observed = promise.catch(() => undefined).finally(() => {
      this.#backgroundCleanup.delete(observed);
    });
    this.#backgroundCleanup.add(observed);
  }

  #scheduleIdleShutdown(): void {
    this.#clearIdleTimer();
    if (
      this.#disposed ||
      this.#activeRequest ||
      this.#activeRuntimePinCount() > 0 ||
      !this.#epoch ||
      this.#epoch.state !== "ready"
    ) {
      return;
    }
    const capturedEpoch = this.#epoch;
    const token = {};
    this.#idleTimerToken = token;
    this.#idleTimer = setTimeout(() => {
      if (this.#idleTimerToken !== token) return;
      this.#idleTimer = undefined;
      this.#idleTimerToken = undefined;
      if (
        this.#epoch !== capturedEpoch ||
        this.#activeRequest ||
        this.#activeRuntimePinCount() > 0 ||
        capturedEpoch.state !== "ready"
      ) {
        return;
      }
      this.#trackBackgroundCleanup(
        this.#retireEpoch(capturedEpoch, "idle_timeout"),
      );
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    this.#idleTimerToken = undefined;
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw shutdownError(this.#epoch?.processEpoch);
    if (this.#startupFault) throw this.#startupFault;
  }

  async #cleanupOrphanedSession(): Promise<void> {
    const session = this.#orphanedSession;
    if (!session) return;
    try {
      await this.#cleanupSession(session);
      if (this.#orphanedSession === session) {
        this.#orphanedSession = undefined;
        this.#startupFault = undefined;
        if (!this.#disposed && !this.#epoch) this.#state = "unloaded";
      }
    } catch (error) {
      const normalized = this.#normalizeError(error, undefined);
      this.#startupFault = normalized;
      if (!this.#disposed) this.#state = "faulted";
      throw normalized;
    }
  }

  #normalizeError(
    error: unknown,
    epoch: ServerProcessEpoch | undefined,
  ): Error {
    if (
      error instanceof LocalSubtitleServerSupervisorError ||
      error instanceof LocalSubtitleServerContractError
    ) {
      return error;
    }
    if (error instanceof LocalSubtitleServerSessionError) {
      return new LocalSubtitleServerSupervisorError(
        error.code === "session_cleanup_failed"
          ? "runtime_unresponsive"
          : "invalid_configuration",
        error.message,
        {
          localSubtitleCode: error.localSubtitleCode,
          processEpoch: epoch?.processEpoch,
          diagnostics: this.#lastDiagnostics,
          cause: error,
        },
      );
    }
    return new LocalSubtitleServerSupervisorError(
      epoch?.closeInfo ? "runtime_crashed" : "runtime_unresponsive",
      epoch?.closeInfo
        ? "The local inference process closed unexpectedly."
        : "The local inference supervisor operation failed.",
      {
        localSubtitleCode: epoch?.closeInfo
          ? "runtime_crashed"
          : "runtime_unresponsive",
        processEpoch: epoch?.processEpoch,
        diagnostics: this.#lastDiagnostics,
        cause: error,
      },
    );
  }
}

export async function reserveLocalSubtitleLoopbackPort(): Promise<
  LocalSubtitleLoopbackPortReservation
> {
  const server: NetServer = createServer({ pauseOnConnect: true });
  server.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server).catch(() => undefined);
    throw new LocalSubtitleServerSupervisorError(
      "launch_failed",
      "A private loopback port could not be reserved.",
      { localSubtitleCode: "runtime_unresponsive" },
    );
  }
  let released = false;
  return Object.freeze({
    port: address.port,
    release: async () => {
      if (released) return;
      released = true;
      await closeServer(server);
    },
  });
}

function createEpoch(options: {
  readonly processEpoch: number;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly session: LocalSubtitleServerSession;
  readonly endpoint: LocalSubtitleServerEndpoint;
  readonly descriptor: LocalSubtitleServerProcessDescriptor;
  readonly child: ChildProcess;
  readonly client: LocalSubtitleServerHttpClientLike;
  readonly diagnostics: LocalSubtitleServerDiagnosticCollector;
}): ServerProcessEpoch {
  let spawnError: Error | undefined;
  let resolveClose!: (value: ChildCloseInfo) => void;
  const closePromise = new Promise<ChildCloseInfo>((resolve) => {
    resolveClose = resolve;
  });
  const backendEvidence = createBackendEvidence(options);
  const onStdout = (chunk: Buffer | string) => {
    options.diagnostics.append("stdout", toDiagnosticBytes(chunk));
    appendBackendEvidence(backendEvidence, "stdout", chunk);
  };
  const onStderr = (chunk: Buffer | string) => {
    options.diagnostics.append("stderr", toDiagnosticBytes(chunk));
    appendBackendEvidence(backendEvidence, "stderr", chunk);
  };
  options.child.stdout?.on("data", onStdout);
  options.child.stderr?.on("data", onStderr);

  const epoch: ServerProcessEpoch = {
    ...options,
    backendEvidence,
    closePromise,
    detachDiagnostics: () => {
      options.child.stdout?.removeListener("data", onStdout);
      options.child.stderr?.removeListener("data", onStderr);
      disposeBackendEvidence(backendEvidence);
    },
    state: "starting",
    requestCount: 0,
    backendVerified: false,
  };
  options.child.once("error", (error) => {
    spawnError = error;
  });
  options.child.once("close", (exitCode, signalCode) => {
    const info = Object.freeze({
      exitCode,
      signalCode,
      ...(spawnError === undefined ? {} : { spawnError }),
    });
    epoch.closeInfo = info;
    resolveClose(info);
  });
  return epoch;
}

function createLease(): LocalSubtitleServerLease {
  const lease = {};
  Object.defineProperty(lease, LEASE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(lease) as LocalSubtitleServerLease;
}

function createRuntimePin(): LocalSubtitleServerRuntimePin {
  const pin = {};
  Object.defineProperty(pin, RUNTIME_PIN_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(pin) as LocalSubtitleServerRuntimePin;
}

function createRequestTicket(): LocalSubtitleServerRequestTicket {
  const ticket = {};
  Object.defineProperty(ticket, REQUEST_TICKET_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(ticket) as LocalSubtitleServerRequestTicket;
}

export function waitForLocalSubtitleMetalBackendEvidence(
  evidence: LocalSubtitleServerBackendEvidence,
  expected: Readonly<{
    processEpoch: number;
    processId: number;
    runtimeGeneration: string;
    serverArtifactId: string;
  }>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const record = BACKEND_EVIDENCE_RECORDS.get(evidence);
  if (
    !record ||
    record.backend !== "metal" ||
    record.processEpoch !== expected.processEpoch ||
    record.processId !== expected.processId ||
    record.runtimeGeneration !== expected.runtimeGeneration ||
    record.serverArtifactId !== expected.serverArtifactId ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    return Promise.reject(
      new Error("The Metal backend evidence identity is invalid."),
    );
  }
  if (record.failureObserved || record.disposed) {
    return Promise.reject(
      new Error("The Metal backend evidence did not verify."),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      record.watchers.delete(observe);
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const observe = () => {
      if (record.failureObserved || record.disposed) {
        finish(() =>
          reject(new Error("The Metal backend evidence did not verify.")),
        );
      }
    };
    const onAbort = () =>
      finish(() =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      );

    if (signal.aborted) {
      onAbort();
      return;
    }
    record.watchers.add(observe);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      if (record.initializationObserved && record.deviceObserved) {
        finish(resolve);
      } else {
        finish(() => reject(new Error("The Metal backend evidence timed out.")));
      }
    }, timeoutMs);
    timeout.unref?.();
    observe();
  });
}

function createBackendEvidence(options: {
  readonly processEpoch: number;
  readonly loadIdentity: LocalSubtitleServerLoadIdentity;
  readonly child: ChildProcess;
}): LocalSubtitleServerBackendEvidence {
  const evidence = Object.create(null) as LocalSubtitleServerBackendEvidence;
  Object.defineProperty(evidence, BACKEND_EVIDENCE_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(evidence);
  BACKEND_EVIDENCE_RECORDS.set(evidence, {
    processEpoch: options.processEpoch,
    processId: options.child.pid ?? 0,
    backend: options.loadIdentity.backend,
    runtimeGeneration: options.loadIdentity.runtimeGeneration,
    serverArtifactId: options.loadIdentity.serverArtifact.id,
    watchers: new Set(),
    retained: {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    },
    initializationObserved: false,
    deviceObserved: false,
    failureObserved: false,
    disposed: false,
  });
  return evidence;
}

function appendBackendEvidence(
  evidence: LocalSubtitleServerBackendEvidence,
  stream: "stdout" | "stderr",
  value: Buffer | string,
): void {
  const record = BACKEND_EVIDENCE_RECORDS.get(evidence);
  if (!record || record.disposed || record.backend !== "metal") return;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const combined = Buffer.concat([record.retained[stream], bytes]);
  record.retained[stream] = Buffer.from(
    combined.subarray(-MAX_BACKEND_EVIDENCE_BYTES_PER_STREAM),
  );
  const text = record.retained[stream].toString("utf8");
  record.initializationObserved ||=
    /(?:ggml_metal_init|ggml_backend_metal_(?:device_)?init)/iu.test(text);
  record.deviceObserved ||=
    /(?:found device|GPU name|using Metal backend|Metal device)/iu.test(text);
  record.failureObserved ||= text.split(/\r?\n/u).some((line) => {
    const hasMetalContext =
      /\bggml_(?:backend_)?metal\w*\b/iu.test(line) ||
      /\bMetal (?:backend|device)\b/iu.test(line);
    return hasMetalContext && (
      /\berror\s*:|\b(?:failed|failure|unavailable|unsupported|fatal|nil)\b/iu.test(
        line,
      ) ||
      /(?:\bMetal backend\b[^\n]*\bdisabled\b|\bdisabled\b[^\n]*\bMetal backend\b)/iu.test(
        line,
      )
    );
  });
  for (const watcher of [...record.watchers]) watcher();
}

function disposeBackendEvidence(evidence: LocalSubtitleServerBackendEvidence): void {
  const record = BACKEND_EVIDENCE_RECORDS.get(evidence);
  if (!record || record.disposed) return;
  record.disposed = true;
  record.retained.stdout = Buffer.alloc(0);
  record.retained.stderr = Buffer.alloc(0);
  for (const watcher of [...record.watchers]) watcher();
  record.watchers.clear();
}

function isLease(input: unknown): input is LocalSubtitleServerLease {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    (input as { readonly [LEASE_BRAND]?: unknown })[LEASE_BRAND] === true
  );
}

function isRuntimePin(input: unknown): input is LocalSubtitleServerRuntimePin {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    (input as { readonly [RUNTIME_PIN_BRAND]?: unknown })[RUNTIME_PIN_BRAND] === true
  );
}

function isRequestTicket(
  input: unknown,
): input is LocalSubtitleServerRequestTicket {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.isFrozen(input) &&
    (input as { readonly [REQUEST_TICKET_BRAND]?: unknown })[
      REQUEST_TICKET_BRAND
    ] === true
  );
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

function validateManagedRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ABSOLUTE_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.parse(value).root === value
  ) {
    throw invalidConfigurationError("The managed resource root is invalid.");
  }
  return value;
}

function snapshotLoadOptions(
  options: LocalSubtitleServerSupervisorLoadOptions,
): LocalSubtitleServerSupervisorLoadOptions {
  const sourceEnvironment = options.sourceEnvironment === undefined
    ? undefined
    : Object.freeze({ ...options.sourceEnvironment });
  const common = {
    verifiedRuntime: options.verifiedRuntime,
    serverArtifactId: options.serverArtifactId,
    threads: options.threads,
    ...(sourceEnvironment === undefined ? {} : { sourceEnvironment }),
  };
  if (options.purpose === "model_load_smoke") {
    if (Object.prototype.hasOwnProperty.call(options, "vadModel")) {
      throw invalidConfigurationError(
        "A model load smoke cannot include a VAD model.",
      );
    }
    return Object.freeze({
      ...common,
      purpose: options.purpose,
      backend: options.backend,
      model: Object.freeze({ ...options.model }),
    });
  }
  if (options.purpose === "vad_load_smoke") {
    return Object.freeze({
      ...common,
      purpose: options.purpose,
      backend: options.backend,
      model: Object.freeze({ ...options.model }),
      vadModel: Object.freeze({ ...options.vadModel }),
    });
  }
  if (options.backend === "cuda") {
    return Object.freeze({
      ...common,
      purpose: options.purpose,
      backend: options.backend,
      model: Object.freeze({ ...options.model }),
      acceleratorPack: options.acceleratorPack,
      ...(options.vadModel === undefined
        ? {}
        : { vadModel: Object.freeze({ ...options.vadModel }) }),
    });
  }
  return Object.freeze({
    ...common,
    purpose: options.purpose,
    backend: options.backend,
    model: Object.freeze({ ...options.model }),
    ...(options.vadModel === undefined
      ? {}
      : { vadModel: Object.freeze({ ...options.vadModel }) }),
  });
}

function createSupervisorLoadIdentity(
  options: LocalSubtitleServerSupervisorLoadOptions,
  managedResourceRoot: string,
): LocalSubtitleServerLoadIdentity {
  if (options.purpose === "model_load_smoke") {
    return createLocalSubtitleServerLoadIdentity({
      ...options,
      managedResourceRoot,
    });
  }
  if (options.purpose === "vad_load_smoke") {
    return createLocalSubtitleServerLoadIdentity({
      ...options,
      managedResourceRoot,
    });
  }
  return createLocalSubtitleServerLoadIdentity({
    ...options,
    managedResourceRoot,
  });
}

function createSupervisorProcessDescriptor(
  options: LocalSubtitleServerSupervisorLoadOptions,
  session: Readonly<{
    endpoint: LocalSubtitleServerEndpoint;
    managedResourceRoot: string;
    sessionRoot: string;
    emptyPublicDirectory: string;
    temporaryDirectory: string;
  }>,
): LocalSubtitleServerProcessDescriptor {
  if (options.purpose === "model_load_smoke") {
    return createLocalSubtitleServerProcessDescriptor({ ...options, ...session });
  }
  if (options.purpose === "vad_load_smoke") {
    return createLocalSubtitleServerProcessDescriptor({ ...options, ...session });
  }
  return createLocalSubtitleServerProcessDescriptor({ ...options, ...session });
}

function snapshotInferenceRequest(
  request: LocalSubtitleServerInferenceRequest,
): LocalSubtitleServerInferenceRequest {
  const expectedFileIdentity = snapshotLocalSubtitleFileIdentity(
    request.expectedFileIdentity,
  );
  if (!expectedFileIdentity) {
    throw new TypeError("The normalized inference window identity is invalid.");
  }
  return Object.freeze({
    requestGeneration: request.requestGeneration,
    filePath: request.filePath,
    expectedFileIdentity,
    language: request.language,
    taskMode: request.taskMode,
    beamSize: request.beamSize,
    temperature: request.temperature,
    vadEnabled: request.vadEnabled,
    vadMinSilenceMs: request.vadMinSilenceMs,
    ...(request.initialPrompt === undefined
      ? {}
      : { initialPrompt: request.initialPrompt }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function validateOwner(owner: LocalSubtitleOwnerKey): string {
  if (
    typeof owner !== "object" ||
    owner === null ||
    !Number.isSafeInteger(owner.webContentsId) ||
    owner.webContentsId < 1 ||
    typeof owner.ownerSessionId !== "string" ||
    owner.ownerSessionId.length < 1 ||
    owner.ownerSessionId.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !OWNER_SESSION_ID_PATTERN.test(owner.ownerSessionId) ||
    Object.keys(owner).sort().join(",") !== "ownerSessionId,webContentsId"
  ) {
    throw invalidConfigurationError("The local inference owner is invalid.");
  }
  return `${owner.webContentsId}:${owner.ownerSessionId}`;
}

function validateBatchId(batchId: string): string {
  if (
    typeof batchId !== "string" ||
    batchId.length < 1 ||
    batchId.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    !SAFE_ID_PATTERN.test(batchId)
  ) {
    throw invalidConfigurationError("The local inference batch id is invalid.");
  }
  return batchId;
}

function validateDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw invalidConfigurationError(`The ${label} is invalid.`);
  }
  return resolved;
}

function validateCount(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw invalidConfigurationError(`The ${label} is invalid.`);
  }
  return resolved;
}

function isRetryableReadinessError(error: unknown): boolean {
  return (
    error instanceof LocalSubtitleServerContractError &&
    error.sessionDisposition === "reusable" &&
    (error.code === "transport_failed" ||
      error.code === "timeout" ||
      (error.code === "http_error" && error.httpStatus === 503))
  );
}

function isRetryableStartFailure(error: unknown): boolean {
  return (
    error instanceof LocalSubtitleServerSupervisorError &&
    error.code === "runtime_crashed"
  );
}

function requiresRestart(error: unknown): boolean {
  return (
    error instanceof LocalSubtitleServerContractError &&
    error.sessionDisposition === "restart_required"
  );
}

function resourceBusyError(): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "resource_busy",
    "The local inference server is busy with another operation or load identity.",
    { localSubtitleCode: "resource_busy" },
  );
}

function ownerReleasedError(): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "owner_released",
    "The local inference owner has been released.",
    { localSubtitleCode: "owner_released" },
  );
}

function invalidConfigurationError(
  message: string,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "invalid_configuration",
    message,
    { localSubtitleCode: "runtime_protocol_mismatch" },
  );
}

function abortedSupervisorError(): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "owner_released",
    "The local inference operation was cancelled before completion.",
    { localSubtitleCode: "transcription_failed" },
  );
}

function backendUnverifiedError(
  epoch: ServerProcessEpoch,
  cause?: unknown,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "backend_unverified",
    "The selected local inference backend could not be verified.",
    {
      localSubtitleCode: "backend_unverified",
      processEpoch: epoch.processEpoch,
      cause,
    },
  );
}

function backendMismatchError(
  epoch: ServerProcessEpoch,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "backend_mismatch",
    "The running local inference backend does not match the selected backend.",
    {
      localSubtitleCode: "backend_mismatch",
      processEpoch: epoch.processEpoch,
    },
  );
}

function crashedError(
  epoch: ServerProcessEpoch,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "runtime_crashed",
    epoch.backendVerified
      ? "The local inference process closed unexpectedly."
      : "The local inference process closed before becoming ready.",
    {
      localSubtitleCode: "runtime_crashed",
      processEpoch: epoch.processEpoch,
    },
  );
}

function startupTimeoutError(
  epoch: ServerProcessEpoch,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "startup_timeout",
    "The local inference process did not become ready before the deadline.",
    {
      localSubtitleCode: "runtime_unresponsive",
      processEpoch: epoch.processEpoch,
    },
  );
}

function shutdownError(
  processEpoch?: number,
  cause?: unknown,
): LocalSubtitleServerSupervisorError {
  return new LocalSubtitleServerSupervisorError(
    "shutdown",
    "The local inference supervisor is shutting down.",
    {
      localSubtitleCode: "owner_released",
      processEpoch,
      cause,
    },
  );
}

function forwardAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
  beforeAbort: () => void,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => {
    beforeAbort();
    controller.abort();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function delayWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedSupervisorError());
      return;
    }
    const timeout = setTimeout(() => {
      detach();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      detach();
      reject(abortedSupervisorError());
    };
    const detach = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function waitForBackendAttestation<T>(options: {
  readonly operation: Promise<T>;
  readonly epoch: ServerProcessEpoch;
  readonly controller: AbortController;
  readonly deadlineMs: number;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = options.controller.signal;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortedSupervisorError()));

    if (signal.aborted) {
      onAbort();
      return;
    }
    if (options.deadlineMs < 1) {
      finish(() => {
        options.controller.abort();
        reject(startupTimeoutError(options.epoch));
      });
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () =>
        finish(() => {
          options.controller.abort();
          reject(startupTimeoutError(options.epoch));
        }),
      options.deadlineMs,
    );
    timeout.unref?.();
    options.epoch.closePromise.then(() => {
      finish(() => {
        options.controller.abort();
        reject(crashedError(options.epoch));
      });
    });
    options.operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function toDiagnosticBytes(chunk: Buffer | string): Uint8Array | string {
  return typeof chunk === "string" ? chunk : chunk;
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
