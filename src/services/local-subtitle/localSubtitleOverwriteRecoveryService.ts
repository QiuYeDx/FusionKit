import type {
  LocalSubtitleError,
  LocalSubtitleFormat,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleOverwriteRecoveryCursor,
  LocalSubtitleOverwriteRecoverySummary,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";

// The 1 MiB repository can hold just over 4,100 minimum-size records.
const MAX_RECOVERY_LIST_PAGES = 64;

export interface LocalSubtitleOverwriteRecoveryItem {
  readonly recoveryId: string;
  readonly displayCode: string;
  readonly format: LocalSubtitleFormat;
  readonly direction: LocalSubtitleOverwriteRecoverySummary["direction"];
  readonly state: LocalSubtitleOverwriteRecoverySummary["state"];
  readonly createdAt: number;
  readonly requiresDirectorySelection: boolean;
}

export type LocalSubtitleOverwriteRecoveryRendererApi = Pick<
  LocalSubtitleRendererApi,
  "listOverwriteRecoveries" | "recoverOverwrite"
>;

export type LocalSubtitleOverwriteRecoveryAvailability =
  | "idle"
  | "ready"
  | "unavailable"
  | "blocked"
  | "error";

export type LocalSubtitleOverwriteRecoveryFeedback =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "recovered";
      readonly outcome: "finalized" | "rolled_back";
    }
  | { readonly kind: "error"; readonly code: string };

export interface LocalSubtitleOverwriteRecoveryViewState {
  readonly availability: LocalSubtitleOverwriteRecoveryAvailability;
  readonly refreshing: boolean;
  readonly items: readonly LocalSubtitleOverwriteRecoveryItem[];
  readonly actionRecoveryId: string | null;
  readonly feedback: LocalSubtitleOverwriteRecoveryFeedback | null;
  readonly queryErrorCode: string | null;
}

export interface LocalSubtitleOverwriteRecoveryServiceOptions {
  readonly getApi: () => LocalSubtitleOverwriteRecoveryRendererApi;
}

export class LocalSubtitleOverwriteRecoveryService {
  readonly #getApi: () => LocalSubtitleOverwriteRecoveryRendererApi;
  readonly #subscribers = new Set<() => void>();
  #state: LocalSubtitleOverwriteRecoveryViewState = initialState();
  #refreshOperation: Promise<boolean> | undefined;
  #recoveryOperation: Promise<LocalSubtitleOverwriteRecoveryFeedback> | undefined;
  #epoch = 0;

  constructor(options: LocalSubtitleOverwriteRecoveryServiceOptions) {
    this.#getApi = options.getApi;
  }

  getState = (): LocalSubtitleOverwriteRecoveryViewState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  };

  refresh(): Promise<boolean> {
    if (this.#refreshOperation) return this.#refreshOperation;
    const epoch = this.#epoch;
    const operation = this.#loadAllPages(epoch);
    this.#refreshOperation = operation;
    this.#publish({ refreshing: true, queryErrorCode: null });
    void operation.finally(() => {
      if (this.#refreshOperation !== operation) return;
      this.#refreshOperation = undefined;
      if (epoch === this.#epoch) this.#publish({ refreshing: false });
    });
    return operation;
  }

  async refreshAfterCurrent(): Promise<boolean> {
    const overlappingRefresh = this.#refreshOperation;
    if (overlappingRefresh) await overlappingRefresh;
    return this.refresh();
  }

  recover(
    recoveryId: string,
  ): Promise<LocalSubtitleOverwriteRecoveryFeedback> {
    if (this.#recoveryOperation) return this.#recoveryOperation;
    if (!this.#state.items.some((item) => item.recoveryId === recoveryId)) {
      return Promise.resolve({ kind: "error", code: "invalid_request" });
    }

    const epoch = this.#epoch;
    const operation = this.#runRecovery(recoveryId, epoch);
    this.#recoveryOperation = operation;
    this.#publish({
      actionRecoveryId: recoveryId,
      feedback: null,
    });
    void operation.finally(() => {
      if (this.#recoveryOperation !== operation) return;
      this.#recoveryOperation = undefined;
      if (epoch === this.#epoch) this.#publish({ actionRecoveryId: null });
    });
    return operation;
  }

  clearFeedback(): void {
    if (this.#state.feedback) this.#publish({ feedback: null });
  }

  disposeForTests(): void {
    this.#epoch += 1;
    this.#refreshOperation = undefined;
    this.#recoveryOperation = undefined;
    this.#state = initialState();
    this.#subscribers.clear();
  }

  async #loadAllPages(epoch: number): Promise<boolean> {
    try {
      const api = this.#getApi();
      const items: LocalSubtitleOverwriteRecoveryItem[] = [];
      const cursors = new Set<string>();
      let cursor: LocalSubtitleOverwriteRecoveryCursor | undefined;

      for (let page = 0; page < MAX_RECOVERY_LIST_PAGES; page += 1) {
        const response = await api.listOverwriteRecoveries(
          cursor ? { after: cursor } : undefined,
        );
        if (epoch !== this.#epoch) return false;
        if (!response.ok) {
          this.#publishQueryFailure(response.error);
          return false;
        }
        if (response.data.status !== "ready") {
          this.#publish({
            availability: response.data.status,
            items: Object.freeze([]),
            queryErrorCode: null,
          });
          return true;
        }

        items.push(...response.data.items.map(toViewItem));
        const nextCursor = response.data.nextCursor;
        if (!nextCursor) {
          this.#publish({
            availability: "ready",
            items: deduplicateItems(items),
            queryErrorCode: null,
          });
          return true;
        }
        const cursorKey = JSON.stringify(nextCursor);
        if (cursors.has(cursorKey)) {
          this.#publishQueryFailureCode("invalid_content");
          return false;
        }
        cursors.add(cursorKey);
        cursor = nextCursor;
      }

      this.#publishQueryFailureCode("invalid_content");
      return false;
    } catch {
      if (epoch === this.#epoch) {
        this.#publishQueryFailureCode("invalid_ipc_request");
      }
      return false;
    }
  }

  async #runRecovery(
    recoveryId: string,
    epoch: number,
  ): Promise<LocalSubtitleOverwriteRecoveryFeedback> {
    let feedback: LocalSubtitleOverwriteRecoveryFeedback;
    try {
      const response = await this.#getApi().recoverOverwrite(recoveryId);
      if (!response.ok) {
        feedback = { kind: "error", code: response.error.code };
      } else if (response.data.status === "cancelled") {
        feedback = { kind: "cancelled" };
      } else {
        feedback = {
          kind: "recovered",
          outcome: response.data.outcome,
        };
        if (epoch === this.#epoch) {
          this.#publish({
            items: Object.freeze(
              this.#state.items.filter(
                (item) => item.recoveryId !== recoveryId,
              ),
            ),
          });
        }
      }
    } catch {
      feedback = { kind: "error", code: "invalid_ipc_request" };
    }

    if (epoch === this.#epoch) this.#publish({ feedback });
    await this.refreshAfterCurrent();
    return feedback;
  }

  #publishQueryFailure(error: LocalSubtitleError): void {
    this.#publishQueryFailureCode(error.code);
  }

  #publishQueryFailureCode(code: string): void {
    this.#publish({
      availability: this.#state.items.length > 0 ? "ready" : "error",
      queryErrorCode: code,
    });
  }

  #publish(
    patch: Partial<LocalSubtitleOverwriteRecoveryViewState>,
  ): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const subscriber of this.#subscribers) {
      try {
        subscriber();
      } catch {
        // One renderer subscriber cannot block recovery state publication.
      }
    }
  }
}

function initialState(): LocalSubtitleOverwriteRecoveryViewState {
  return Object.freeze({
    availability: "idle",
    refreshing: false,
    items: Object.freeze([]),
    actionRecoveryId: null,
    feedback: null,
    queryErrorCode: null,
  });
}

function toViewItem(
  item: LocalSubtitleOverwriteRecoverySummary,
): LocalSubtitleOverwriteRecoveryItem {
  return Object.freeze({
    recoveryId: item.recoveryId,
    displayCode: item.displayCode,
    format: item.format,
    direction: item.direction,
    state: item.state,
    createdAt: item.createdAt,
    requiresDirectorySelection: item.requiresDirectorySelection,
  });
}

function deduplicateItems(
  items: readonly LocalSubtitleOverwriteRecoveryItem[],
): readonly LocalSubtitleOverwriteRecoveryItem[] {
  const byId = new Map<string, LocalSubtitleOverwriteRecoveryItem>();
  for (const item of items) byId.set(item.recoveryId, item);
  return Object.freeze(
    [...byId.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    ),
  );
}

let singleton: LocalSubtitleOverwriteRecoveryService | undefined;

export function getLocalSubtitleOverwriteRecoveryService(): LocalSubtitleOverwriteRecoveryService {
  singleton ??= new LocalSubtitleOverwriteRecoveryService({
    getApi: () => {
      if (typeof window === "undefined" || !window.localSubtitleApi) {
        throw new Error("Local subtitle recovery API is unavailable.");
      }
      return window.localSubtitleApi;
    },
  });
  return singleton;
}

export function resetLocalSubtitleOverwriteRecoveryServiceForTests(): void {
  singleton?.disposeForTests();
  singleton = undefined;
}
