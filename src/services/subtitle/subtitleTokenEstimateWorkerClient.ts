import type { SubtitleTokenEstimateResult } from "@/utils/subtitleTokenEstimateCore";
import type {
  TokenEstimateWorkerRequest,
  TokenEstimateWorkerResponse,
} from "@/workers/subtitleTokenEstimate.worker";
import { SubtitleSliceType } from "@/type/subtitle";
import type { TokenPricing } from "@/type/model";
import { DEFAULT_SLICE_LENGTH_MAP } from "@/constants/subtitle";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EstimateJob = {
  jobId: string;
  estimateKey: string;
  fileName: string;
  content: string;
  maxTokens: number;
  tokenPricing?: {
    inputTokensPerMillion?: number;
    outputTokensPerMillion?: number;
  };
  sourceLang?: string;
  targetLang?: string;
  translationOutputMode?: "bilingual" | "target_only";
  onResult: (estimate: SubtitleTokenEstimateResult) => void;
  onError: (error: string) => void;
};

export type EnqueueEstimateOptions = {
  fileName: string;
  content: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  tokenPricing?: TokenPricing;
  sourceLang?: string;
  targetLang?: string;
  translationOutputMode?: "bilingual" | "target_only";
  onResult: (estimate: SubtitleTokenEstimateResult) => void;
  onError: (error: string) => void;
};

// ---------------------------------------------------------------------------
// estimateKey: used to detect stale results
// ---------------------------------------------------------------------------

export function buildEstimateKey(
  fileName: string,
  sliceType: SubtitleSliceType,
  customSliceLength: number | undefined,
  sourceLang: string | undefined,
  targetLang: string | undefined,
  translationOutputMode: string | undefined,
): string {
  return `${fileName}|${sliceType}|${customSliceLength ?? ""}|${sourceLang ?? ""}|${targetLang ?? ""}|${translationOutputMode ?? ""}`;
}

// ---------------------------------------------------------------------------
// Resolve maxTokens from slice config
// ---------------------------------------------------------------------------

function resolveMaxTokens(
  sliceType: SubtitleSliceType,
  customSliceLength?: number,
): number {
  const fallback = DEFAULT_SLICE_LENGTH_MAP[sliceType];
  const value =
    sliceType === SubtitleSliceType.CUSTOM ? customSliceLength : fallback;
  return Number.isFinite(value) && value && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Worker client singleton
// ---------------------------------------------------------------------------

let jobCounter = 0;

class SubtitleTokenEstimateWorkerClient {
  private worker: Worker;
  private queue: EstimateJob[] = [];
  private activeJob: EstimateJob | null = null;
  private pendingCallbacks = new Map<
    string,
    { onResult: EstimateJob["onResult"]; onError: EstimateJob["onError"] }
  >();
  private cancelledJobs = new Set<string>();

  constructor() {
    this.worker = new Worker(
      new URL(
        "../../workers/subtitleTokenEstimate.worker.ts",
        import.meta.url,
      ),
      { type: "module" },
    );
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = this.handleWorkerError;
  }

  enqueue(options: EnqueueEstimateOptions): string {
    const jobId = `est_${++jobCounter}_${Date.now()}`;
    const maxTokens = resolveMaxTokens(
      options.sliceType,
      options.customSliceLength,
    );
    const estimateKey = buildEstimateKey(
      options.fileName,
      options.sliceType,
      options.customSliceLength,
      options.sourceLang,
      options.targetLang,
      options.translationOutputMode,
    );

    const job: EstimateJob = {
      jobId,
      estimateKey,
      fileName: options.fileName,
      content: options.content,
      maxTokens,
      tokenPricing: options.tokenPricing,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      translationOutputMode: options.translationOutputMode,
      onResult: options.onResult,
      onError: options.onError,
    };

    this.queue.push(job);
    this.flush();
    return jobId;
  }

  cancelByFileName(fileName: string): void {
    this.queue = this.queue.filter((j) => j.fileName !== fileName);
    if (this.activeJob?.fileName === fileName) {
      this.cancelledJobs.add(this.activeJob.jobId);
    }
    for (const [jobId, _] of this.pendingCallbacks) {
      if (this.activeJob?.jobId === jobId && this.activeJob.fileName === fileName) {
        this.cancelledJobs.add(jobId);
      }
    }
  }

  cancelByJobId(jobId: string): void {
    this.queue = this.queue.filter((j) => j.jobId !== jobId);
    this.cancelledJobs.add(jobId);
  }

  destroy(): void {
    this.worker.terminate();
    this.queue = [];
    this.activeJob = null;
    this.pendingCallbacks.clear();
    this.cancelledJobs.clear();
  }

  private flush = () => {
    if (this.activeJob || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.activeJob = job;

    this.pendingCallbacks.set(job.jobId, {
      onResult: job.onResult,
      onError: job.onError,
    });

    const request: TokenEstimateWorkerRequest = {
      jobId: job.jobId,
      fileName: job.fileName,
      content: job.content,
      maxTokens: job.maxTokens,
      tokenPricing: job.tokenPricing,
      sourceLang: job.sourceLang,
      targetLang: job.targetLang,
      translationOutputMode: job.translationOutputMode,
    };

    this.worker.postMessage(request);
  };

  private handleMessage = (e: MessageEvent<TokenEstimateWorkerResponse>) => {
    const { jobId, estimate, error } = e.data;

    this.activeJob = null;

    const callbacks = this.pendingCallbacks.get(jobId);
    this.pendingCallbacks.delete(jobId);

    if (this.cancelledJobs.has(jobId)) {
      this.cancelledJobs.delete(jobId);
    } else if (callbacks) {
      if (estimate) {
        callbacks.onResult(estimate);
      } else if (error) {
        callbacks.onError(error);
      }
    }

    this.flush();
  };

  private handleWorkerError = (e: ErrorEvent) => {
    console.error("[TokenEstimateWorker] error:", e.message);

    if (this.activeJob) {
      const callbacks = this.pendingCallbacks.get(this.activeJob.jobId);
      this.pendingCallbacks.delete(this.activeJob.jobId);
      this.activeJob = null;
      callbacks?.onError(e.message || "Worker error");
    }

    this.flush();
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let clientInstance: SubtitleTokenEstimateWorkerClient | null = null;

export function getEstimateWorkerClient(): SubtitleTokenEstimateWorkerClient {
  if (!clientInstance) {
    clientInstance = new SubtitleTokenEstimateWorkerClient();
  }
  return clientInstance;
}

export function destroyEstimateWorkerClient(): void {
  clientInstance?.destroy();
  clientInstance = null;
}
