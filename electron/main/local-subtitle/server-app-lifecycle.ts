import { LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY } from "./server-supervisor";

export const LOCAL_SUBTITLE_SERVER_APP_LIFECYCLE_POLICY = Object.freeze({
  shutdownTimeoutMs:
    LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.abortGraceMs +
    LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.terminateGraceMs +
    LOCAL_SUBTITLE_SERVER_SUPERVISOR_POLICY.forceKillGraceMs +
    5_000,
} as const);

export type LocalSubtitleServerTerminalReason =
  | "app_quit"
  | "update"
  | "fatal";

export interface LocalSubtitleServerShutdownTarget {
  shutdown(reason: LocalSubtitleServerTerminalReason): Promise<void>;
}

export interface LocalSubtitleBeforeQuitEvent {
  preventDefault(): void;
}

export interface LocalSubtitleBeforeQuitHost {
  onBeforeQuit(
    listener: (event: LocalSubtitleBeforeQuitEvent) => void,
  ): void;
  quit(): void;
}

export class LocalSubtitleServerAppLifecycleError extends Error {
  readonly code = "shutdown_timeout";

  constructor() {
    super("The local inference runtime did not finish shutting down in time.");
    this.name = "LocalSubtitleServerAppLifecycleError";
  }
}

export class LocalSubtitleServerAppLifecycle {
  readonly #target: LocalSubtitleServerShutdownTarget;
  readonly #shutdownTimeoutMs: number;
  #host: LocalSubtitleBeforeQuitHost | undefined;
  #shutdownOperation: Promise<void> | undefined;
  #shutdownSucceeded = false;
  #allowQuit = false;
  #quitRetryScheduled = false;

  constructor(
    target: LocalSubtitleServerShutdownTarget,
    options: { readonly shutdownTimeoutMs?: number } = {},
  ) {
    if (!target || typeof target.shutdown !== "function") {
      throw new TypeError("A local inference shutdown target is required.");
    }
    const timeout =
      options.shutdownTimeoutMs ??
      LOCAL_SUBTITLE_SERVER_APP_LIFECYCLE_POLICY.shutdownTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
      throw new TypeError("The local inference shutdown timeout is invalid.");
    }
    this.#target = target;
    this.#shutdownTimeoutMs = timeout;
  }

  install(host: LocalSubtitleBeforeQuitHost): void {
    if (this.#host) {
      if (this.#host !== host) {
        throw new TypeError("The local inference lifecycle is already installed.");
      }
      return;
    }
    this.#host = host;
    host.onBeforeQuit((event) => this.#handleBeforeQuit(event));
  }

  async prepareUpdateInstall(): Promise<void> {
    await this.shutdown("update");
    this.#allowQuit = true;
  }

  shutdown(reason: LocalSubtitleServerTerminalReason): Promise<void> {
    if (this.#shutdownSucceeded) return Promise.resolve();

    if (!this.#shutdownOperation) {
      let resolveOperation!: () => void;
      let rejectOperation!: (reason?: unknown) => void;
      const operation = new Promise<void>((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });
      this.#shutdownOperation = operation;
      let targetOperation: Promise<void>;
      try {
        targetOperation = this.#target.shutdown(reason);
      } catch (error) {
        targetOperation = Promise.reject(error);
      }
      void targetOperation.then(
        () => {
          this.#shutdownSucceeded = true;
          resolveOperation();
        },
        (error: unknown) => {
          if (this.#shutdownOperation === operation) {
            this.#shutdownOperation = undefined;
          }
          rejectOperation(error);
        },
      );
    }
    return settleBeforeTimeout(
      this.#shutdownOperation,
      this.#shutdownTimeoutMs,
    );
  }

  #handleBeforeQuit(event: LocalSubtitleBeforeQuitEvent): void {
    if (this.#allowQuit) return;
    event.preventDefault();
    if (this.#quitRetryScheduled) return;
    this.#quitRetryScheduled = true;

    void this.shutdown("app_quit")
      .catch((error: unknown) =>
        error instanceof LocalSubtitleServerAppLifecycleError
          ? undefined
          : this.shutdown("app_quit").catch(() => undefined),
      )
      .finally(() => {
        this.#allowQuit = true;
        this.#host?.quit();
      });
  }
}

function settleBeforeTimeout(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new LocalSubtitleServerAppLifecycleError()),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
