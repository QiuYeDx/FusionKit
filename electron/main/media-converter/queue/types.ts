import type {
  ConversionSettings, DiskSpace, EngineReasonCode, EngineStatus, ItemFailureCode, ItemPhase, ItemProgress, MediaInfo, OutputConflict, PlanSummary,
  PlanWarningCode,
} from '../../../../src/media-converter/contract';
import type { ProbeOutcome } from '../engine/probe';
import type { ConversionPlan, PlanOutcome, PlannerCapabilities } from '../plan/types';

/**
 * What the queue (design §6) depends on, as interfaces: the executor that runs one item end to end
 * (T-ENGINE-07), the capability table (T-ENGINE-03), the prober, the power blocker and a clock.
 * Each is injected, so the queue never imports electron and its tests run with fakes.
 */

// ── Executor ───────────────────────────────────────────────────────────────────────────────────

/** Where one output of the plan is published: its folder and encode's cleaned name (`outputFileName`), without the number a conflict adds. */
export interface OutputTargetName {
  readonly directory: string;
  readonly baseName: string;
  /** Without the dot. */
  readonly extension: string;
}

/** One item as the executor runs it. Everything is frozen: the settings and plan of the start, never the panel's later ones. */
export interface ExecutionJob {
  readonly itemId: string;
  /** The authorized input; only the main process ever holds it. */
  readonly inputPath: string;
  readonly media: MediaInfo;
  readonly settings: Readonly<ConversionSettings>;
  readonly plan: Readonly<ConversionPlan>;
  /** One per plan output, in plan order. */
  readonly targets: readonly OutputTargetName[];
  readonly conflict: OutputConflict;
  /**
   * Overwrite only: the file names (`name.ext`) the user confirmed may be moved to the recycle bin.
   * A file found under any other name is not replaced; the output is numbered instead (design §10).
   */
  readonly confirmedReplace: readonly string[];
  /** Read when the run starts: idle priority and about half the cores. */
  readonly lowUsage: boolean;
  /** Every input of the queue when the run starts: none is ever replaced (`output_is_input`). */
  readonly inputPaths: readonly string[];
}

export interface ExecutionHooks {
  /** Aborted by a cancel or the shutdown; the executor stops ffmpeg, removes its partials and work folder, then settles `cancelled`. */
  readonly signal: AbortSignal;
  phase(phase: ItemPhase): void;
  /** As often as the executor likes; the queue sends at most one per item every 250 ms. */
  progress(progress: ItemProgress): void;
}

export interface PublishedOutput {
  /** The output's position in the plan. */
  readonly index: number;
  readonly path: string;
  readonly sizeBytes: number;
  /** A file of that name was moved to the recycle bin for it. */
  readonly replaced: boolean;
}

/**
 * How a run ended. `summary` is the plan summary when the executor changed the plan
 * (`encoder_fallback`). A failure lists what it published before it failed ("partly done"), and its
 * redacted log tail; the executor reports the process's `unknown` as `encode_failed` and a failed
 * publish as `output_publish_failed`. `disk_space_low` carries the bytes needed and free
 * (AC-ENGINE-06-4). A cancel lists what an item of several outputs had published before it
 * ("all tracks"): those files stay, and the item can show them.
 */
export type ExecutionOutcome =
  | { readonly status: 'succeeded'; readonly outputs: readonly PublishedOutput[]; readonly warnings: readonly PlanWarningCode[]; readonly summary?: PlanSummary }
  | { readonly status: 'skipped'; readonly reason: 'not_smaller'; readonly summary?: PlanSummary }
  | {
    readonly status: 'failed'; readonly code: ItemFailureCode; readonly outputs: readonly PublishedOutput[]; readonly log: string | null;
    readonly warnings?: readonly PlanWarningCode[]; readonly summary?: PlanSummary; readonly space?: DiskSpace;
  }
  | { readonly status: 'cancelled'; readonly outputs?: readonly PublishedOutput[]; readonly warnings?: readonly PlanWarningCode[]; readonly summary?: PlanSummary };

export interface MediaExecutor {
  /** Never rejects for a failure of the conversion: that is a `failed` outcome. A rejection counts as `encode_failed`. */
  run(job: ExecutionJob, hooks: ExecutionHooks): Promise<ExecutionOutcome>;
  /** The batch is over: the output names it published may be taken again (`MediaOutputs.endBatch`). */
  endBatch?(): void;
}

// ── Engine ─────────────────────────────────────────────────────────────────────────────────────

export type CapabilitiesAnswer = { readonly ok: true; readonly capabilities: PlannerCapabilities } | { readonly ok: false; readonly code: EngineReasonCode };

/** The capability table and the engine status (T-ENGINE-03 implements it on top of the runtime). */
export interface QueueCapabilities {
  /** The table to plan with; waits for a detection in progress. A runtime or detection failure answers its code. */
  planner(): Promise<CapabilitiesAnswer>;
  /** While its capabilities are `detecting`, the queue starts nothing: test encodes would compete with the runs. */
  status(): EngineStatus;
  /** Calls `listener` whenever `status()` may have changed (a detection starting or ending included); returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface QueueProber {
  /** `MediaProber.probe`: never rejects; a failure is its code. */
  probe(filePath: string): Promise<ProbeOutcome>;
}

/** Electron's `powerSaveBlocker`, as the queue uses it. */
export interface QueuePowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

/** Wall time for the timestamps the renderer shows; a monotonic time and timers for the debounce, the progress gate and the shutdown wait. */
export interface QueueClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Milliseconds on a clock that never goes back (`performance.now`). */
  monotonic(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type QueuePlanner = (media: MediaInfo, settings: ConversionSettings, caps: PlannerCapabilities) => PlanOutcome;

/** A command the queue refuses as a whole; the IPC layer answers it as `{ok:false, error:{code}}`. */
export class MediaQueueError extends Error {
  constructor(readonly code: EngineReasonCode, message: string) {
    super(message);
    this.name = 'MediaQueueError';
  }
}
