import path from "node:path";
import { isProxy } from "node:util/types";
import { snapshotLocalSubtitleOverwriteDirectoryIdentity } from "./overwrite-directory-coordinator";

export type LocalSubtitleOverwriteTransactionState =
  | "open"
  | "finalize_pending"
  | "rollback_pending"
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
  readonly transactionId: string;
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
   * retained by begin(). Once the backend method is invoked, a thrown error
   * leaves the transaction finalize_pending and retryable only in the same
   * direction; rollback is no longer permitted.
   */
  finalize(): void;
  /**
   * Restores the original final target (or its prior absence) and converges
   * cleanup of the exact new inode. A native backend must remove that inode
   * relative to the retained directory handle; a test adapter may instead
   * restore the partial leaf only while the authorized path is still proven to
   * name the same directory object. Once rollback is invoked, a thrown error
   * leaves the transaction rollback_pending and retryable by the backend's
   * recovery authority; finalize is no longer permitted.
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
const receiptInstances = new WeakSet<object>();

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
    receiptInstances.add(this);
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
    if (this.#state === "rollback_pending") {
      throw invalidState("A rollback-pending overwrite transaction cannot be finalized.");
    }
    let backendInvoked = false;
    try {
      this.#invokeTerminalOnce(() => {
        backendInvoked = true;
        return this.#finalizeBackend();
      }, "finalize");
      this.#state = "finalized";
    } catch (error) {
      if (backendInvoked) {
        this.#state = "finalize_pending";
      }
      throw error;
    }
  }

  rollback(): void {
    if (this.#state === "rolled_back") return;
    if (this.#state === "finalized") {
      throw invalidState("A finalized overwrite transaction cannot be rolled back.");
    }
    if (this.#state === "finalize_pending") {
      throw invalidState("A finalize-pending overwrite transaction cannot be rolled back.");
    }
    let backendInvoked = false;
    try {
      this.#invokeTerminalOnce(() => {
        backendInvoked = true;
        return this.#rollbackBackend();
      }, "rollback");
      this.#state = "rolled_back";
    } catch (error) {
      if (backendInvoked) {
        this.#state = "rollback_pending";
      }
      throw error;
    }
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

export function isLocalSubtitleOverwriteTransactionReceipt(
  value: unknown,
): value is LocalSubtitleOverwriteTransactionReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    receiptInstances.has(value) &&
    Object.getPrototypeOf(value) === LocalSubtitleOverwriteTransactionReceipt.prototype
  );
}

function snapshotRequest(
  request: LocalSubtitleOverwriteTransactionRequest,
): LocalSubtitleOverwriteTransactionRequest {
  if (
    !isExactRecord(request, [
      "transactionId",
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
  const transactionId = ownDataValue(request, "transactionId");
  const directoryPath = ownDataValue(request, "directoryPath");
  const expectedDirectoryIdentity = snapshotLocalSubtitleOverwriteDirectoryIdentity(
    ownDataValue(request, "expectedDirectoryIdentity"),
  );
  const partialLeaf = ownDataValue(request, "partialLeaf");
  const finalLeaf = ownDataValue(request, "finalLeaf");
  const expectedPartialIdentity = snapshotLocalSubtitleOverwriteDirectoryIdentity(
    ownDataValue(request, "expectedPartialIdentity"),
  );
  const expectedByteSize = ownDataValue(request, "expectedByteSize");
  if (
    typeof transactionId !== "string" ||
    !/^[A-Za-z0-9-]{1,80}$/u.test(transactionId)
  ) {
    throw invalidRequest("The overwrite transaction identifier is invalid.");
  }
  if (
    typeof directoryPath !== "string" ||
    !path.isAbsolute(directoryPath) ||
    directoryPath.includes("\0")
  ) {
    throw invalidRequest("The overwrite transaction directory path must be absolute.");
  }
  assertLeaf(partialLeaf, "partial");
  assertLeaf(finalLeaf, "final");
  if (partialLeaf === finalLeaf) {
    throw invalidRequest("The overwrite transaction leaves must be different.");
  }
  if (!expectedDirectoryIdentity || !expectedPartialIdentity) {
    throw invalidRequest("The overwrite transaction request identity is invalid.");
  }
  if (
    !Number.isSafeInteger(expectedByteSize) ||
    (expectedByteSize as number) <= 0
  ) {
    throw invalidRequest("The overwrite transaction byte size is invalid.");
  }

  return deepFreeze({
    transactionId,
    directoryPath,
    expectedDirectoryIdentity,
    partialLeaf,
    finalLeaf,
    expectedPartialIdentity,
    expectedByteSize: expectedByteSize as number,
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
  const expectedFinalIdentity = snapshotLocalSubtitleOverwriteDirectoryIdentity(
    ownDataValue(receipt, "expectedFinalIdentity"),
  );
  const finalize = ownDataValue(receipt, "finalize");
  const rollback = ownDataValue(receipt, "rollback");
  if (
    !expectedFinalIdentity ||
    typeof finalize !== "function" ||
    typeof rollback !== "function"
  ) {
    throw invalidReceipt("The overwrite transaction backend receipt is invalid.");
  }
  return {
    expectedFinalIdentity,
    finalize: finalize as () => void,
    rollback: rollback as () => void,
  };
}

function assertLeaf(
  value: unknown,
  field: "partial" | "final",
): asserts value is string {
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
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input)
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(input);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key));
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
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
