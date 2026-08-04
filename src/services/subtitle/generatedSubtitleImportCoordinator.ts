import { createSubtitleTaskModelFields } from "@/agent/task-model-config";
import useSubtitleTranslatorConfigStore, {
  sanitizeSubtitleTranslatorConfigPreferences,
  type SubtitleTranslatorConfigPreferences,
} from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useModelStore from "@/store/useModelStore";
import type {
  AutomaticSubtitleTranslationHandoffMode,
  PrepareGeneratedSubtitleImportResult,
  SubtitleTranslationImportConfigSummary,
} from "@/type/generatedSubtitleImport";
import type { ModelProfile } from "@/type/model";
import type { SubtitleTranslatorTask } from "@/type/subtitle";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HYDRATION_TIMEOUT_MS = 10_000;

type SubtitleTaskModelFields = Pick<
  SubtitleTranslatorTask,
  | "apiKey"
  | "apiModel"
  | "endPoint"
  | "apiFormat"
  | "outputTokenParameter"
  | "maxOutputTokens"
>;

export interface GeneratedSubtitleImportHydrationSource<T> {
  isHydrated(): boolean;
  onHydrated(listener: () => void): () => void;
  read(): T;
}

export interface GeneratedSubtitleImportCustomDirectoryLease {
  readonly displayLabel: string;
  readonly privateLease: unknown;
  release(): void | Promise<void>;
}

export interface GeneratedSubtitleImportPrivateSnapshot {
  readonly summary: SubtitleTranslationImportConfigSummary;
  readonly expiresAt: number;
  readonly modelFields?: SubtitleTaskModelFields;
  readonly customDirectoryLease?: unknown;
}

export interface GeneratedSubtitleImportSnapshotCoordinatorOptions {
  readonly configSource: GeneratedSubtitleImportHydrationSource<
    SubtitleTranslatorConfigPreferences
  >;
  readonly modelSource: GeneratedSubtitleImportHydrationSource<
    ModelProfile | null
  >;
  readonly acquireCustomDirectoryLease?: (options: {
    readonly snapshotId: string;
    readonly expiresAt: number;
    readonly displayLabel: string | null;
  }) => Promise<GeneratedSubtitleImportCustomDirectoryLease | undefined>;
  readonly hydrationTimeoutMs?: number;
  readonly snapshotTtlMs?: number;
  readonly now?: () => number;
  readonly snapshotIdFactory?: () => string;
}

interface StoredGeneratedSubtitleImportSnapshot {
  readonly privateSnapshot: GeneratedSubtitleImportPrivateSnapshot;
  readonly customDirectoryLease?: GeneratedSubtitleImportCustomDirectoryLease;
}

export class GeneratedSubtitleImportCoordinatorError extends Error {
  readonly name = "GeneratedSubtitleImportCoordinatorError";

  constructor(
    readonly code: "invalid_snapshot" | "snapshot_expired",
    message: string,
  ) {
    super(message);
  }
}

export class GeneratedSubtitleImportSnapshotCoordinator {
  readonly #options: GeneratedSubtitleImportSnapshotCoordinatorOptions;
  readonly #snapshots = new Map<string, StoredGeneratedSubtitleImportSnapshot>();
  readonly #pendingSnapshotIds = new Set<string>();
  readonly #releaseOperations = new Map<string, Promise<void>>();

  constructor(options: GeneratedSubtitleImportSnapshotCoordinatorOptions) {
    if (
      !options ||
      !isHydrationSource(options.configSource) ||
      !isHydrationSource(options.modelSource)
    ) {
      throw new TypeError("Generated subtitle import config sources are invalid.");
    }
    this.#options = options;
  }

  async prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult> {
    if (
      mode !== "enqueue_translation" &&
      mode !== "enqueue_and_start_translation"
    ) {
      throw new TypeError("Generated subtitle import mode is invalid.");
    }
    const hydrated = await waitForHydration(
      [this.#options.configSource, this.#options.modelSource],
      this.#options.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS,
    );
    if (!hydrated) return prepareFailure("configuration_not_ready");

    const preferences = sanitizeSubtitleTranslatorConfigPreferences(
      this.#options.configSource.read(),
    );
    const profile = validTaskProfile(this.#options.modelSource.read());
    if (mode === "enqueue_and_start_translation" && !profile) {
      return prepareFailure("profile_required");
    }

    const now = this.#options.now ?? Date.now;
    const createdAt = now();
    const expiresAt = createdAt + positiveSafeInteger(
      this.#options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
      "snapshotTtlMs",
    );
    const snapshotId = mintSnapshotId(
      this.#options.snapshotIdFactory ?? defaultSnapshotId,
      this.#snapshots,
      this.#pendingSnapshotIds,
      this.#releaseOperations,
    );
    this.#pendingSnapshotIds.add(snapshotId);
    let directoryLease: GeneratedSubtitleImportCustomDirectoryLease | undefined;
    try {
      if (preferences.outputMode === "custom") {
        const acquire = this.#options.acquireCustomDirectoryLease;
        if (!acquire) return prepareFailure("directory_authorization_required");
        directoryLease = await acquire({
          snapshotId,
          expiresAt,
          displayLabel: preferences.outputDirectoryDisplayLabel,
        });
        if (!validDirectoryLease(directoryLease)) {
          await releaseLease(directoryLease);
          return prepareFailure("directory_authorization_required");
        }
      }

      const executionBinding = profile
        ? Object.freeze({
            status: "ready" as const,
            taskProfileId: profile.id,
            taskProfileLabel: profile.name,
          })
        : Object.freeze({ status: "needs_configuration" as const });
      const summary = Object.freeze({
        snapshotId,
        createdAt,
        handoffMode: mode,
        executionBinding,
        sourceLang: preferences.sourceLang,
        targetLang: preferences.targetLang,
        translationOutputMode: preferences.translationOutputMode,
        sliceType: preferences.sliceType,
        ...(preferences.sliceType === "CUSTOM"
          ? { customSliceLength: preferences.customSliceLength }
          : {}),
        outputMode: preferences.outputMode,
        ...(directoryLease
          ? { outputDirectoryLabel: directoryLease.displayLabel }
          : {}),
        conflictPolicy: preferences.conflictPolicy,
        concurrentSlices: preferences.concurrentSlices,
      }) satisfies SubtitleTranslationImportConfigSummary;
      const privateSnapshot = Object.freeze({
        summary,
        expiresAt,
        ...(profile
          ? { modelFields: Object.freeze(createSubtitleTaskModelFields(profile)) }
          : {}),
        ...(directoryLease
          ? { customDirectoryLease: directoryLease.privateLease }
          : {}),
      }) satisfies GeneratedSubtitleImportPrivateSnapshot;
      this.#snapshots.set(snapshotId, {
        privateSnapshot,
        ...(directoryLease ? { customDirectoryLease: directoryLease } : {}),
      });
      return Object.freeze({
        ok: true,
        snapshot: summary,
        canAutoStart: profile !== null,
        warnings: Object.freeze(
          profile ? [] : ["configuration_required"],
        ),
      });
    } finally {
      this.#pendingSnapshotIds.delete(snapshotId);
    }
  }

  async withSnapshot<T>(
    snapshotId: string,
    consumer: (snapshot: GeneratedSubtitleImportPrivateSnapshot) => T | Promise<T>,
  ): Promise<T> {
    if (typeof consumer !== "function") {
      throw new TypeError("Generated subtitle import snapshot consumer is invalid.");
    }
    const stored = this.#snapshots.get(snapshotId);
    if (!stored) throw invalidSnapshot();
    if (stored.privateSnapshot.expiresAt <= (this.#options.now ?? Date.now)()) {
      await this.releaseBatch(snapshotId);
      throw new GeneratedSubtitleImportCoordinatorError(
        "snapshot_expired",
        "Generated subtitle import snapshot expired.",
      );
    }
    return consumer(stored.privateSnapshot);
  }

  async releaseBatch(snapshotId: string): Promise<void> {
    const pending = this.#releaseOperations.get(snapshotId);
    if (pending) return pending;
    const stored = this.#snapshots.get(snapshotId);
    if (!stored) return;
    this.#snapshots.delete(snapshotId);
    const operation = releaseLease(stored.customDirectoryLease)
      .catch((error: unknown) => {
        if (!this.#snapshots.has(snapshotId)) {
          this.#snapshots.set(snapshotId, stored);
        }
        throw error;
      })
      .finally(() => {
        if (this.#releaseOperations.get(snapshotId) === operation) {
          this.#releaseOperations.delete(snapshotId);
        }
      });
    this.#releaseOperations.set(snapshotId, operation);
    return operation;
  }
}

let sharedCoordinator: GeneratedSubtitleImportSnapshotCoordinator | undefined;

export function getGeneratedSubtitleImportSnapshotCoordinator():
  GeneratedSubtitleImportSnapshotCoordinator {
  sharedCoordinator ??= new GeneratedSubtitleImportSnapshotCoordinator({
    configSource: persistedStoreSource(
      useSubtitleTranslatorConfigStore,
      () => useSubtitleTranslatorConfigStore.getState().preferences,
      () =>
        useSubtitleTranslatorConfigStore.getState().migrationStatus === "ready",
    ),
    modelSource: persistedStoreSource(
      useModelStore,
      () => useModelStore.getState().getTaskProfile(),
    ),
  });
  return sharedCoordinator;
}

function persistedStoreSource<T>(
  store: {
    readonly persist: {
      hasHydrated(): boolean;
      onFinishHydration(listener: () => void): () => void;
    };
  },
  read: () => T,
  isReady: () => boolean = () => true,
): GeneratedSubtitleImportHydrationSource<T> {
  return {
    isHydrated: () => store.persist.hasHydrated() && isReady(),
    onHydrated: (listener) => store.persist.onFinishHydration(listener),
    read,
  };
}

async function waitForHydration(
  sources: readonly GeneratedSubtitleImportHydrationSource<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  positiveSafeInteger(timeoutMs, "hydrationTimeoutMs");
  if (sources.every((source) => source.isHydrated())) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribers: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve(result);
    };
    unsubscribers = sources.map((source) =>
      source.onHydrated(() => {
        queueMicrotask(() => {
          if (sources.every((candidate) => candidate.isHydrated())) finish(true);
        });
      }),
    );
    timer = setTimeout(() => finish(false), timeoutMs);
    if (sources.every((source) => source.isHydrated())) finish(true);
  });
}

function prepareFailure(
  code:
    | "configuration_not_ready"
    | "directory_authorization_required"
    | "profile_required",
): PrepareGeneratedSubtitleImportResult {
  return Object.freeze({
    ok: false,
    code,
    warnings: Object.freeze([]),
  });
}

function validTaskProfile(profile: ModelProfile | null): ModelProfile | null {
  return profile &&
    safeId(profile.id) &&
    safeSummaryLabel(profile.name) &&
    nonBlank(profile.apiKey) &&
    nonBlank(profile.modelKey) &&
    nonBlank(profile.baseUrl)
    ? Object.freeze({ ...profile })
    : null;
}

function mintSnapshotId(
  factory: () => string,
  snapshots: ReadonlyMap<string, unknown>,
  pendingSnapshotIds: ReadonlySet<string>,
  releaseOperations: ReadonlyMap<string, unknown>,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `subtitle-import-snapshot-${factory()}`;
    if (
      safeId(candidate) &&
      !snapshots.has(candidate) &&
      !pendingSnapshotIds.has(candidate) &&
      !releaseOperations.has(candidate)
    ) {
      return candidate;
    }
  }
  throw new TypeError("Generated subtitle import snapshot ID source is invalid.");
}

function validDirectoryLease(
  lease: GeneratedSubtitleImportCustomDirectoryLease | undefined,
): lease is GeneratedSubtitleImportCustomDirectoryLease {
  return Boolean(
    lease &&
    safeDisplayLabel(lease.displayLabel) &&
    lease.privateLease !== undefined &&
    lease.privateLease !== null &&
    typeof lease.release === "function",
  );
}

function defaultSnapshotId(): string {
  return globalThis.crypto.randomUUID();
}

async function releaseLease(
  lease: GeneratedSubtitleImportCustomDirectoryLease | undefined,
): Promise<void> {
  if (lease) await lease.release();
}

function invalidSnapshot(): GeneratedSubtitleImportCoordinatorError {
  return new GeneratedSubtitleImportCoordinatorError(
    "invalid_snapshot",
    "Generated subtitle import snapshot is invalid.",
  );
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Generated subtitle import ${field} is invalid.`);
  }
  return value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value);
}

function safeDisplayLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim().length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function safeSummaryLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHydrationSource(
  source: GeneratedSubtitleImportHydrationSource<unknown> | undefined,
): source is GeneratedSubtitleImportHydrationSource<unknown> {
  return Boolean(
    source &&
    typeof source.isHydrated === "function" &&
    typeof source.onHydrated === "function" &&
    typeof source.read === "function",
  );
}
