import path from "node:path";

export type LocalSubtitleOverwriteTransactionState =
  | "open"
  | "finalized"
  | "rolled_back";

export type LocalSubtitleOverwriteTransactionErrorCode =
  | "invalid_backend"
  | "invalid_request"
  | "invalid_receipt"
  | "invalid_state";

export class LocalSubtitleOverwriteTransactionError extends Error {
  readonly name = "LocalSubtitleOverwriteTransactionError";

  constructor(
    readonly code: LocalSubtitleOverwriteTransactionErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface LocalSubtitleOverwriteDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

export interface LocalSubtitleOverwriteFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

export interface LocalSubtitleOverwriteTransactionRequest {
  readonly directoryPath: string;
  readonly expectedDirectoryIdentity: LocalSubtitleOverwriteDirectoryIdentity;
  readonly partialLeaf: string;
  readonly finalLeaf: string;
  readonly expectedPartialIdentity: LocalSubtitleOverwriteFileIdentity;
  readonly expectedByteSize: number;
}

export interface LocalSubtitleOverwriteTransactionBackendReceipt {
  readonly expectedFinalIdentity: LocalSubtitleOverwriteFileIdentity;
  /**
   * Releases the recoverable victim backup relative to the directory handle
   * retained by begin(). A thrown error must leave the transaction open,
   * rollback-capable, and must not redirect cleanup through a fresh path.
   */
  finalize(): void;
  /**
   * Restores both the original final target (or its prior absence) and the
   * exact partial leaf relative to the retained directory handle so the
   * exporter can perform identity-bound cleanup. A thrown error must leave the
   * transaction open and retryable by the backend's recovery authority.
   */
  rollback(): void;
}

export interface LocalSubtitleOverwriteTransactionBackend {
  /**
   * Pins and verifies one directory object, then atomically installs the
   * identity-matching partial leaf and retains any no-follow regular-file
   * victim for rollback. The same directory handle must remain authoritative
   * until finalize() or rollback(); the implementation must not return until
   * the final leaf and recovery receipt are fully established. If begin()
   * throws or returns an invalid value, it must already have restored the
   * victim and original partial leaf and released every backup and handle.
   */
  begin(
    request: LocalSubtitleOverwriteTransactionRequest,
  ): LocalSubtitleOverwriteTransactionBackendReceipt;
}

const coordinatorInstances = new WeakSet<object>();

export class LocalSubtitleOverwriteTransactionReceipt {
  readonly expectedFinalIdentity: LocalSubtitleOverwriteFileIdentity;

  #state: LocalSubtitleOverwriteTransactionState = "open";
  #terminalOperation: "finalize" | "rollback" | undefined;
  readonly #finalizeBackend: () => unknown;
  readonly #rollbackBackend: () => unknown;

  constructor(rawReceipt: LocalSubtitleOverwriteTransactionBackendReceipt) {
    const validated = validateBackendReceipt(rawReceipt);
    this.expectedFinalIdentity = freezeIdentity(validated.expectedFinalIdentity);
    this.#finalizeBackend = () => validated.finalize.call(rawReceipt);
    this.#rollbackBackend = () => validated.rollback.call(rawReceipt);
    Object.freeze(this);
  }

  get state(): LocalSubtitleOverwriteTransactionState {
    return this.#state;
  }

  finalize(): void {
    if (this.#state === "finalized") return;
    if (this.#state === "rolled_back") {
      throw invalidState("A rolled-back overwrite transaction cannot be finalized.");
    }
    this.#invokeTerminalOnce(this.#finalizeBackend, "finalize");
    this.#state = "finalized";
  }

  rollback(): void {
    if (this.#state === "rolled_back") return;
    if (this.#state === "finalized") {
      throw invalidState("A finalized overwrite transaction cannot be rolled back.");
    }
    this.#invokeTerminalOnce(this.#rollbackBackend, "rollback");
    this.#state = "rolled_back";
  }

  #invokeTerminalOnce(
    operation: () => unknown,
    name: "finalize" | "rollback",
  ): void {
    if (this.#terminalOperation) {
      throw invalidState(
        `The overwrite transaction is already ${this.#terminalOperation === "finalize" ? "finalizing" : "rolling back"}.`,
      );
    }
    this.#terminalOperation = name;
    try {
      const result = operation();
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw invalidReceipt(`The overwrite transaction ${name} method must be synchronous.`);
      }
    } finally {
      this.#terminalOperation = undefined;
    }
  }
}

Object.freeze(LocalSubtitleOverwriteTransactionReceipt.prototype);

export class LocalSubtitleOverwriteTransactionCoordinator {
  readonly #beginBackend: (
    request: LocalSubtitleOverwriteTransactionRequest,
  ) => unknown;

  constructor(backend: LocalSubtitleOverwriteTransactionBackend) {
    const begin = validateBackend(backend);
    this.#beginBackend = (request) => begin.call(backend, request);
    coordinatorInstances.add(this);
    Object.freeze(this);
  }

  begin(
    request: LocalSubtitleOverwriteTransactionRequest,
  ): LocalSubtitleOverwriteTransactionReceipt {
    const snapshot = snapshotRequest(request);
    const rawReceipt = this.#beginBackend(snapshot);
    if (isThenable(rawReceipt)) {
      void Promise.resolve(rawReceipt).catch(() => undefined);
      throw invalidReceipt("The overwrite transaction backend begin method must be synchronous.");
    }
    return new LocalSubtitleOverwriteTransactionReceipt(
      rawReceipt as LocalSubtitleOverwriteTransactionBackendReceipt,
    );
  }
}

Object.freeze(LocalSubtitleOverwriteTransactionCoordinator.prototype);

export function createLocalSubtitleOverwriteTransactionCoordinator(
  backend: LocalSubtitleOverwriteTransactionBackend,
): LocalSubtitleOverwriteTransactionCoordinator {
  return new LocalSubtitleOverwriteTransactionCoordinator(backend);
}

export function isLocalSubtitleOverwriteTransactionCoordinator(
  value: unknown,
): value is LocalSubtitleOverwriteTransactionCoordinator {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    coordinatorInstances.has(value) &&
    Object.getPrototypeOf(value) === LocalSubtitleOverwriteTransactionCoordinator.prototype
  );
}

function snapshotRequest(
  request: LocalSubtitleOverwriteTransactionRequest,
): LocalSubtitleOverwriteTransactionRequest {
  if (
    !isExactRecord(request, [
      "directoryPath",
      "expectedDirectoryIdentity",
      "partialLeaf",
      "finalLeaf",
      "expectedPartialIdentity",
      "expectedByteSize",
    ])
  ) {
    throw invalidRequest("The overwrite transaction request is invalid.");
  }
  if (
    typeof request.directoryPath !== "string" ||
    !path.isAbsolute(request.directoryPath) ||
    request.directoryPath.includes("\0")
  ) {
    throw invalidRequest("The overwrite transaction directory path must be absolute.");
  }
  assertLeaf(request.partialLeaf, "partial");
  assertLeaf(request.finalLeaf, "final");
  if (request.partialLeaf === request.finalLeaf) {
    throw invalidRequest("The overwrite transaction leaves must be different.");
  }
  assertIdentity(request.expectedDirectoryIdentity, "request");
  assertIdentity(request.expectedPartialIdentity, "request");
  if (
    !Number.isSafeInteger(request.expectedByteSize) ||
    request.expectedByteSize <= 0
  ) {
    throw invalidRequest("The overwrite transaction byte size is invalid.");
  }

  return deepFreeze({
    directoryPath: request.directoryPath,
    expectedDirectoryIdentity: { ...request.expectedDirectoryIdentity },
    partialLeaf: request.partialLeaf,
    finalLeaf: request.finalLeaf,
    expectedPartialIdentity: { ...request.expectedPartialIdentity },
    expectedByteSize: request.expectedByteSize,
  });
}

function validateBackend(
  backend: LocalSubtitleOverwriteTransactionBackend,
): LocalSubtitleOverwriteTransactionBackend["begin"] {
  if (
    (typeof backend !== "object" && typeof backend !== "function") ||
    backend === null
  ) {
    throw new LocalSubtitleOverwriteTransactionError(
      "invalid_backend",
      "A synchronous overwrite transaction backend is required.",
    );
  }
  const begin = Reflect.get(backend, "begin");
  if (typeof begin !== "function") {
    throw new LocalSubtitleOverwriteTransactionError(
      "invalid_backend",
      "A synchronous overwrite transaction backend is required.",
    );
  }
  return begin as LocalSubtitleOverwriteTransactionBackend["begin"];
}

function validateBackendReceipt(
  receipt: LocalSubtitleOverwriteTransactionBackendReceipt,
): LocalSubtitleOverwriteTransactionBackendReceipt {
  if (!isExactRecord(receipt, ["expectedFinalIdentity", "finalize", "rollback"])) {
    throw invalidReceipt("The overwrite transaction backend receipt is invalid.");
  }
  const expectedFinalIdentity = Reflect.get(receipt, "expectedFinalIdentity");
  const finalize = Reflect.get(receipt, "finalize");
  const rollback = Reflect.get(receipt, "rollback");
  if (typeof finalize !== "function" || typeof rollback !== "function") {
    throw invalidReceipt("The overwrite transaction backend receipt is invalid.");
  }
  assertIdentity(expectedFinalIdentity, "receipt");
  return {
    expectedFinalIdentity,
    finalize,
    rollback,
  };
}

function assertIdentity(
  identity: LocalSubtitleOverwriteDirectoryIdentity | LocalSubtitleOverwriteFileIdentity,
  source: "request" | "receipt",
): void {
  if (
    !isExactRecord(identity, ["dev", "ino", "birthtimeMs"]) ||
    !isNonNegativeSafeInteger(identity.dev) ||
    !isNonNegativeSafeInteger(identity.ino) ||
    typeof identity.birthtimeMs !== "number" ||
    !Number.isFinite(identity.birthtimeMs) ||
    identity.birthtimeMs < 0
  ) {
    const message = source === "request"
      ? "The overwrite transaction request identity is invalid."
      : "The overwrite transaction final identity is invalid.";
    if (source === "request") throw invalidRequest(message);
    throw invalidReceipt(message);
  }
}

function assertLeaf(value: unknown, field: "partial" | "final"): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRequest(`The overwrite transaction ${field} leaf is invalid.`);
  }
}

function freezeIdentity(
  identity: LocalSubtitleOverwriteFileIdentity,
): LocalSubtitleOverwriteFileIdentity {
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    birthtimeMs: identity.birthtimeMs,
  });
}

function isExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const keys = Reflect.ownKeys(input);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof Reflect.get(value, "then") === "function",
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

function invalidRequest(message: string): LocalSubtitleOverwriteTransactionError {
  return new LocalSubtitleOverwriteTransactionError("invalid_request", message);
}

function invalidReceipt(message: string): LocalSubtitleOverwriteTransactionError {
  return new LocalSubtitleOverwriteTransactionError("invalid_receipt", message);
}

function invalidState(message: string): LocalSubtitleOverwriteTransactionError {
  return new LocalSubtitleOverwriteTransactionError("invalid_state", message);
}
