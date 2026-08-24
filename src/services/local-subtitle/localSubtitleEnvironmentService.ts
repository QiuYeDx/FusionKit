import {
  createLocalSubtitleError,
  type LocalSubtitleError,
} from "@/type/localSubtitle";
import {
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
  type LocalSubtitleBackendPreviewRequest,
  type LocalSubtitleBackendPreviewSummary,
  type LocalSubtitleIpcResult,
  type LocalSubtitleManagedResourceSummary,
  type LocalSubtitleRendererApi,
  type LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";

export interface LocalSubtitleEnvironmentState {
  readonly loading: boolean;
  readonly runtime: LocalSubtitleRuntimeSummary | null;
  readonly resources: readonly LocalSubtitleManagedResourceSummary[];
  readonly error: LocalSubtitleError | null;
  readonly backendPreviewRevision: number;
}

export interface LocalSubtitleEnvironmentServiceOptions {
  readonly getApi: () => LocalSubtitleRendererApi;
}

export class LocalSubtitleEnvironmentService {
  readonly #getApi: () => LocalSubtitleRendererApi;
  readonly #subscribers = new Set<() => void>();
  readonly #backendPreviews = new Map<
    string,
    LocalSubtitleBackendPreviewSummary
  >();
  readonly #backendPreviewRequests = new Map<
    string,
    Promise<LocalSubtitleIpcResult<LocalSubtitleBackendPreviewSummary>>
  >();
  #state: LocalSubtitleEnvironmentState = Object.freeze({
    loading: true,
    runtime: null,
    resources: [],
    error: null,
    backendPreviewRevision: 0,
  });
  #initialized = false;
  #refreshPromise: Promise<LocalSubtitleEnvironmentState> | undefined;
  #resourceRefreshPromise:
    | Promise<LocalSubtitleIpcResult<LocalSubtitleManagedResourceSummary[]>>
    | undefined;
  #backendPreviewEpoch = 0;

  constructor(options: LocalSubtitleEnvironmentServiceOptions) {
    this.#getApi = options.getApi;
  }

  getState = (): LocalSubtitleEnvironmentState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  };

  ensureInitialized(): Promise<LocalSubtitleEnvironmentState> {
    if (this.#initialized && !this.#refreshPromise) {
      return Promise.resolve(this.#state);
    }
    return this.#runRefresh(false);
  }

  refresh(): Promise<LocalSubtitleEnvironmentState> {
    this.#invalidateBackendPreviews(false);
    return this.#runRefresh(true);
  }

  refreshManagedResources(): Promise<
    LocalSubtitleIpcResult<LocalSubtitleManagedResourceSummary[]>
  > {
    if (this.#resourceRefreshPromise) return this.#resourceRefreshPromise;

    let request!: Promise<
      LocalSubtitleIpcResult<LocalSubtitleManagedResourceSummary[]>
    >;
    request = Promise.resolve()
      .then(() => this.#getApi().listManagedResources())
      .catch((error: unknown) => localSubtitleIpcFailure(
        transportError("Unable to read local subtitle resources.", error),
      ))
      .then((result) => {
        if (result.ok) {
          this.#invalidateBackendPreviews(false);
          this.#publish({ ...this.#state, resources: result.data });
        }
        return result;
      })
      .finally(() => {
        if (this.#resourceRefreshPromise === request) {
          this.#resourceRefreshPromise = undefined;
        }
      });
    this.#resourceRefreshPromise = request;
    return request;
  }

  getCachedBackendPreview(
    key: string,
  ): LocalSubtitleBackendPreviewSummary | undefined {
    return this.#backendPreviews.get(key);
  }

  requestBackendPreview(
    key: string,
    request: LocalSubtitleBackendPreviewRequest,
  ): Promise<LocalSubtitleIpcResult<LocalSubtitleBackendPreviewSummary>> {
    const cached = this.#backendPreviews.get(key);
    if (cached) return Promise.resolve(localSubtitleIpcSuccess(cached));
    const existing = this.#backendPreviewRequests.get(key);
    if (existing) return existing;

    const epoch = this.#backendPreviewEpoch;
    let operation!: Promise<
      LocalSubtitleIpcResult<LocalSubtitleBackendPreviewSummary>
    >;
    operation = Promise.resolve()
      .then(() => this.#getApi().previewBackend(request))
      .catch((error: unknown) => localSubtitleIpcFailure(
        transportError("Unable to preview the local subtitle backend.", error),
      ))
      .then((result) => {
        if (
          result.ok &&
          epoch === this.#backendPreviewEpoch &&
          result.data.modelId === request.modelId &&
          result.data.devicePreference === request.devicePreference
        ) {
          this.#backendPreviews.set(key, result.data);
        }
        return result;
      })
      .finally(() => {
        if (this.#backendPreviewRequests.get(key) === operation) {
          this.#backendPreviewRequests.delete(key);
        }
      });
    this.#backendPreviewRequests.set(key, operation);
    return operation;
  }

  clearBackendPreviews(): void {
    this.#invalidateBackendPreviews(true);
  }

  #invalidateBackendPreviews(publish: boolean): void {
    this.#backendPreviewEpoch += 1;
    this.#backendPreviews.clear();
    const state = {
      ...this.#state,
      backendPreviewRevision: this.#state.backendPreviewRevision + 1,
    };
    if (publish) this.#publish(state);
    else this.#state = Object.freeze(state);
  }

  resetForTests(): void {
    this.#initialized = false;
    this.#refreshPromise = undefined;
    this.#resourceRefreshPromise = undefined;
    this.#backendPreviewEpoch += 1;
    this.#backendPreviews.clear();
    this.#backendPreviewRequests.clear();
    this.#state = Object.freeze({
      loading: true,
      runtime: null,
      resources: [],
      error: null,
      backendPreviewRevision: 0,
    });
    this.#subscribers.clear();
  }

  #runRefresh(force: boolean): Promise<LocalSubtitleEnvironmentState> {
    if (this.#refreshPromise) return this.#refreshPromise;
    if (!force && this.#initialized) return Promise.resolve(this.#state);

    this.#publish({ ...this.#state, loading: true, error: null });
    let operation!: Promise<LocalSubtitleEnvironmentState>;
    operation = Promise.resolve()
      .then(async () => {
        const api = this.#getApi();
        const [runtimeResult, resourceResult] = await Promise.all([
          api.probeRuntime(),
          api.listManagedResources(),
        ]);
        return Object.freeze({
          loading: false,
          runtime: runtimeResult.ok ? runtimeResult.data : null,
          resources: resourceResult.ok ? resourceResult.data : [],
          error: runtimeResult.ok
            ? (resourceResult.ok ? null : resourceResult.error)
            : runtimeResult.error,
          backendPreviewRevision: this.#state.backendPreviewRevision,
        });
      })
      .catch((error: unknown) => Object.freeze({
        loading: false,
        runtime: null,
        resources: [],
        error: transportError(
          "Unable to inspect the local subtitle environment.",
          error,
        ),
        backendPreviewRevision: this.#state.backendPreviewRevision,
      }))
      .then((state) => {
        this.#initialized = true;
        this.#publish(state);
        return state;
      })
      .finally(() => {
        if (this.#refreshPromise === operation) {
          this.#refreshPromise = undefined;
        }
      });
    this.#refreshPromise = operation;
    return operation;
  }

  #publish(state: LocalSubtitleEnvironmentState): void {
    this.#state = Object.freeze(state);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber();
      } catch {
        // Environment observers cannot own or interrupt app-level runtime work.
      }
    }
  }
}

let environmentService: LocalSubtitleEnvironmentService | undefined;

export function getLocalSubtitleEnvironmentService(): LocalSubtitleEnvironmentService {
  environmentService ??= new LocalSubtitleEnvironmentService({
    getApi: getRendererApi,
  });
  return environmentService;
}

export function resetLocalSubtitleEnvironmentServiceForTests(): void {
  environmentService?.resetForTests();
  environmentService = undefined;
}

function getRendererApi(): LocalSubtitleRendererApi {
  if (typeof window === "undefined" || !window.localSubtitleApi) {
    throw new Error(
      "Local subtitle IPC is only available in the Electron renderer.",
    );
  }
  return window.localSubtitleApi;
}

function transportError(message: string, error: unknown) {
  return createLocalSubtitleError("runtime_unresponsive", message, {
    stage: "ipc",
    details: {
      summary: error instanceof Error
        ? "The renderer transport rejected the request."
        : "The renderer transport failed without an Error object.",
      truncated: false,
    },
  });
}
