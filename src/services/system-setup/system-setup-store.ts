import { useEffect, useSyncExternalStore } from "react";
import type { GpuInfo, SystemSetupApi, VcRuntimeRepairResult, VcRuntimeStatus } from "../../system-setup/contract";

/**
 * The renderer's view of what local transcription needs from this computer: the VC++ runtime
 * (Windows) and the graphics card. Shared by Subtitle Studio, the classic transcriber and the
 * welcome wizard, so a repair in one place clears the banner everywhere.
 */
export interface SystemSetupSnapshot {
  /** Last known runtime state; null until the first check answers (or without the API). */
  readonly vc: VcRuntimeStatus | null;
  readonly vcChecking: boolean;
  readonly repairing: boolean;
  /** The last repair's result, until the next check or repair. */
  readonly repair: VcRuntimeRepairResult | null;
  readonly gpu: GpuInfo | null;
}

/** The runtime is missing or too old: local transcription cannot start until it is repaired. */
export function vcRuntimeNeedsRepair(status: VcRuntimeStatus | null | undefined): boolean {
  return status?.status === "missing" || status?.status === "outdated";
}

/**
 * Local transcription failures a missing or too old VC++ runtime produces on Windows: the
 * transcription program crashes as it starts or loads, or never answers; a load check that fails
 * on a verified download reports model_incompatible. Downloads, files, media (FFmpeg does not use
 * the runtime) and the bundled program's own files have other causes.
 */
const VC_RUNTIME_FAILURE_CODES = new Set(["runtime_crashed", "runtime_unresponsive", "model_incompatible"]);

export function vcRuntimeMayExplain(code: string | undefined): boolean {
  return !!code && VC_RUNTIME_FAILURE_CODES.has(code);
}

export interface SystemSetupStoreOptions {
  readonly getApi?: () => SystemSetupApi | undefined;
  readonly now?: () => number;
  /** A check younger than this is reused unless forced. */
  readonly maxAgeMs?: number;
}

export class SystemSetupStore {
  readonly #getApi: () => SystemSetupApi | undefined;
  readonly #now: () => number;
  readonly #maxAge: number;
  readonly #listeners = new Set<() => void>();
  #snapshot: SystemSetupSnapshot = Object.freeze({ vc: null, vcChecking: false, repairing: false, repair: null, gpu: null });
  #vcCheckedAt = -Infinity;
  #vcCheck?: Promise<VcRuntimeStatus | null>;
  #repair?: Promise<VcRuntimeRepairResult | null>;
  #gpu?: Promise<GpuInfo | null>;

  constructor(options: SystemSetupStoreOptions = {}) {
    this.#getApi = options.getApi ?? (() => (typeof window === "undefined" ? undefined : window.systemSetup));
    this.#now = options.now ?? Date.now;
    this.#maxAge = options.maxAgeMs ?? 30_000;
  }

  getSnapshot = (): SystemSetupSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #emit(change: Partial<SystemSetupSnapshot>) {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...change });
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* A view cannot stop the others. */ } }
  }

  /** Reads the runtime state; a recent answer is reused unless `force`. Null when it cannot be read. */
  checkVcRuntime = (options: { force?: boolean } = {}): Promise<VcRuntimeStatus | null> => {
    if (this.#vcCheck) return this.#vcCheck;
    if (!options.force && this.#snapshot.vc && this.#now() - this.#vcCheckedAt < this.#maxAge) return Promise.resolve(this.#snapshot.vc);
    const api = this.#getApi();
    if (!api) return Promise.resolve(null);
    this.#vcCheck = api.getVcRuntimeStatus().then((vc) => {
      this.#vcCheckedAt = this.#now();
      this.#emit({ vc, repair: vcRuntimeNeedsRepair(vc) ? this.#snapshot.repair : null });
      return vc;
    }, () => null).finally(() => {
      this.#vcCheck = undefined;
      this.#emit({ vcChecking: false });
    });
    this.#emit({ vcChecking: true });
    return this.#vcCheck;
  };

  /**
   * Whether local resources can be prepared now: true unless the runtime is known to be missing or
   * too old (an unreadable state does not block). Always asks again so a repair elsewhere counts.
   */
  vcRuntimeReady = async (): Promise<boolean> => !vcRuntimeNeedsRepair(await this.checkVcRuntime({ force: true }));

  /** The runtime state when it was read within `maxAgeMs` (no check in flight), else null. */
  freshVcRuntime = (maxAgeMs = this.#maxAge): VcRuntimeStatus | null =>
    !this.#vcCheck && this.#snapshot.vc && this.#now() - this.#vcCheckedAt < maxAgeMs ? this.#snapshot.vc : null;

  repairVcRuntime = (): Promise<VcRuntimeRepairResult | null> => {
    if (this.#repair) return this.#repair;
    const api = this.#getApi();
    if (!api) return Promise.resolve(null);
    this.#repair = api.repairVcRuntime().then((repair) => {
      this.#vcCheckedAt = this.#now();
      this.#emit({ repair, vc: repair.status });
      return repair;
    }, () => {
      const repair: VcRuntimeRepairResult = { outcome: "failed", status: this.#snapshot.vc ?? { status: "unknown", bundled: false } };
      this.#emit({ repair });
      return repair;
    }).finally(() => {
      this.#repair = undefined;
      this.#emit({ repairing: false });
    });
    this.#emit({ repairing: true, repair: null });
    return this.#repair;
  };

  /** The graphics card, detected once per session unless `refresh`. */
  detectGpu = (options: { refresh?: boolean } = {}): Promise<GpuInfo | null> => {
    if (this.#gpu && !options.refresh) return this.#gpu;
    const api = this.#getApi();
    if (!api) return Promise.resolve(null);
    this.#gpu = api.detectGpu(options).then((gpu) => { this.#emit({ gpu }); return gpu; }, () => null);
    return this.#gpu;
  };
}

let store: SystemSetupStore | undefined;
export function getSystemSetupStore(): SystemSetupStore {
  return store ??= new SystemSetupStore();
}

/**
 * The shared snapshot; `vc` checks the runtime and `gpu` detects the card when the view appears.
 */
export function useSystemSetup(options: { vc?: boolean; gpu?: boolean } = {}): SystemSetupSnapshot {
  const setup = getSystemSetupStore();
  const snapshot = useSyncExternalStore(setup.subscribe, setup.getSnapshot);
  const { vc = false, gpu = false } = options;
  useEffect(() => { if (vc) void setup.checkVcRuntime(); }, [setup, vc]);
  useEffect(() => { if (gpu) void setup.detectGpu(); }, [setup, gpu]);
  return snapshot;
}
