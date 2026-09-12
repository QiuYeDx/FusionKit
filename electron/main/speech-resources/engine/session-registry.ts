import { LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION, LOCAL_SUBTITLE_LIMITS, createLocalSubtitleError, type LocalSubtitleErrorCode, type LocalSubtitleOwnerKey, type LocalSubtitleSessionSnapshot, type LocalSubtitleResourceJobSummary, type LocalSubtitleResourceEventEnvelope } from '../../../../src/speech-resources/contracts';
import { localSubtitleResourceJobSummarySchema, localSubtitleResourceEventEnvelopeSchema } from '../../../../src/speech-resources/schemas';
export type LocalSubtitleResourceEventListener = (envelope: LocalSubtitleResourceEventEnvelope) => void;
interface OwnerSessionDelivery { readonly kind: 'resource'; readonly envelope: LocalSubtitleResourceEventEnvelope; }
interface OwnerSessionState { readonly key: string; revision: number; readonly resourceJobs: Map<string,LocalSubtitleResourceJobSummary>; readonly resourceListeners: Set<LocalSubtitleResourceEventListener>; readonly deliveryQueue: OwnerSessionDelivery[]; delivering: boolean; }
export class LocalSubtitleSessionRegistry {
readonly #sessions = new Map<string, OwnerSessionState>();

readonly #releasedOwners = new Set<string>();

#shutDown = false;

#shutdownOperation: Promise<void> | undefined;

assertOwnerActive(owner: LocalSubtitleOwnerKey): void {
    assertOwner(owner);
    if (this.#shutDown || this.#releasedOwners.has(ownerKey(owner))) {
      throw ownerReleased();
    }
  }

getSnapshot(owner: LocalSubtitleOwnerKey): LocalSubtitleSessionSnapshot {
    const session = this.#requireSession(owner);
    return freezeDto(parseSnapshot({
      schemaVersion: LOCAL_SUBTITLE_DOMAIN_SCHEMA_VERSION,
      revision: session.revision,
      batches: [],
      resourceJobs: [...session.resourceJobs.values()],
    }));
  }

getResourceJob(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
  ): LocalSubtitleResourceJobSummary | undefined {
    this.assertOwnerActive(owner);
    assertId(jobId, "jobId");
    return this.#sessions.get(ownerKey(owner))?.resourceJobs.get(jobId);
  }

onResourceEvent(
    owner: LocalSubtitleOwnerKey,
    listener: LocalSubtitleResourceEventListener,
  ): () => void {
    if (typeof listener !== "function") throw invalid("listener");
    const session = this.#requireSession(owner);
    session.resourceListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      session.resourceListeners.delete(listener);
    };
  }

upsertResourceJob(
    owner: LocalSubtitleOwnerKey,
    job: LocalSubtitleResourceJobSummary,
  ): LocalSubtitleResourceEventEnvelope {
    this.assertOwnerActive(owner);
    const parsedJob = freezeDto(parseResourceJob(job));
    const session = this.#requireSession(owner);
    const exists = session.resourceJobs.has(parsedJob.jobId);
    if (
      !exists &&
      session.resourceJobs.size >= LOCAL_SUBTITLE_LIMITS.maxSessionResourceJobs
    ) {
      throw failure("limit_exceeded", "resourceJobs");
    }
    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseResourceEvent({
      revision,
      event: { type: "resource-job-updated", job: parsedJob },
    }));
    session.resourceJobs.set(parsedJob.jobId, parsedJob);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "resource", envelope }]);
    return envelope;
  }

removeResourceJob(
    owner: LocalSubtitleOwnerKey,
    jobId: string,
    removedAt: string,
  ): LocalSubtitleResourceEventEnvelope | undefined {
    this.assertOwnerActive(owner);
    const validated = parseResourceEvent({
      revision: 1,
      event: { type: "resource-job-removed", jobId, removedAt },
    });
    if (validated.event.type !== "resource-job-removed") {
      throw invalidContent("resourceEvent");
    }
    const session = this.#sessions.get(ownerKey(owner));
    if (!session?.resourceJobs.has(validated.event.jobId)) return undefined;

    const revision = nextRevision(session.revision);
    const envelope = freezeDto(parseResourceEvent({
      revision,
      event: validated.event,
    }));
    session.resourceJobs.delete(validated.event.jobId);
    session.revision = revision;
    this.#enqueueDeliveries(session, [{ kind: "resource", envelope }]);
    return envelope;
  }

releaseOwner(owner: LocalSubtitleOwnerKey): boolean {
    assertOwner(owner);
    const key = ownerKey(owner);
    if (this.#releasedOwners.has(key)) return false;
    this.#releasedOwners.add(key);
    const session = this.#sessions.get(key);
    session?.resourceListeners.clear();
    session?.deliveryQueue.splice(0);
    this.#sessions.delete(key);
    return true;
  }

shutdown(): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    const operation = Promise.resolve();
    this.#shutdownOperation = operation;
    this.#shutDown = true;
    for (const [key, session] of this.#sessions) {
      this.#releasedOwners.add(key);
      session.resourceListeners.clear();
      session.deliveryQueue.splice(0);
    }
    this.#sessions.clear();
    return operation;
  }

#requireSession(owner: LocalSubtitleOwnerKey): OwnerSessionState {
    this.assertOwnerActive(owner);
    const key = ownerKey(owner);
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const created: OwnerSessionState = {
      key,
      revision: 0,
      resourceJobs: new Map(),
      resourceListeners: new Set(),
      deliveryQueue: [],
      delivering: false,
    };
    this.#sessions.set(key, created);
    return created;
  }

#enqueueDeliveries(
    session: OwnerSessionState,
    deliveries: readonly OwnerSessionDelivery[],
  ): void {
    if (this.#sessions.get(session.key) !== session) return;
    session.deliveryQueue.push(...deliveries);
    this.#drainDeliveries(session);
  }

#drainDeliveries(session: OwnerSessionState): void {
    if (session.delivering) return;
    session.delivering = true;
    try {
      while (
        session.deliveryQueue.length > 0 &&
        this.#sessions.get(session.key) === session
      ) {
        const delivery = session.deliveryQueue.shift()!;
          this.#deliverToListeners(
            session,
            session.resourceListeners,
            delivery.envelope,
          );

      }
    } finally {
      if (this.#sessions.get(session.key) !== session) {
        session.deliveryQueue.splice(0);
      }
      session.delivering = false;
    }
  }

#deliverToListeners<T>(
    session: OwnerSessionState,
    listeners: Set<(envelope: T) => void>,
    envelope: T,
  ): void {
    for (const listener of [...listeners]) {
      if (this.#sessions.get(session.key) !== session) break;
      if (!listeners.has(listener)) continue;
      try {
        const result: unknown = listener(envelope);
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // A delivery failure cannot roll back authoritative session state.
      }
    }
  }
}
export type LocalSubtitleSessionRegistryErrorCode = Extract<
  LocalSubtitleErrorCode,
  "invalid_ipc_request" | "owner_released" | "limit_exceeded" | "invalid_content"
>;

export class LocalSubtitleSessionRegistryError extends Error {
  readonly name = "LocalSubtitleSessionRegistryError";
  readonly localSubtitleCode: LocalSubtitleSessionRegistryErrorCode;

  constructor(
    readonly code: LocalSubtitleSessionRegistryErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.localSubtitleCode = code;
  }
}

function parseResourceJob(value: unknown): LocalSubtitleResourceJobSummary {
  const result = localSubtitleResourceJobSummarySchema.safeParse(value);
  if (!result.success) throw invalidContent("resourceJob");
  if (result.data.error === undefined) return result.data;
  return {
    ...result.data,
    error: createLocalSubtitleError(
      result.data.error.code,
      "The local subtitle resource operation failed.",
      {
        stage: result.data.error.stage,
        ...(result.data.error.causeCode === undefined
          ? {}
          : { causeCode: result.data.error.causeCode }),
      },
    ),
  };
}

function parseResourceEvent(value: unknown): LocalSubtitleResourceEventEnvelope {
  const result = localSubtitleResourceEventEnvelopeSchema.safeParse(value);
  if (!result.success) throw invalidContent("resourceEvent");
  return result.data;
}

function nextRevision(current: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw failure("limit_exceeded", "revision");
  }
  return current + 1;
}

function assertOwner(owner: LocalSubtitleOwnerKey): void {
  if (
    !owner ||
    !Number.isSafeInteger(owner.webContentsId) ||
    owner.webContentsId < 0 ||
    !owner.ownerSessionId ||
    owner.ownerSessionId.length > 128 ||
    owner.ownerSessionId.trim() !== owner.ownerSessionId ||
    /[\u0000-\u001f\u007f]/u.test(owner.ownerSessionId)
  ) {
    throw invalid("owner");
  }
}

function assertId(value: string, field: string): void {
  if (
    !value ||
    value.length > LOCAL_SUBTITLE_LIMITS.maxIdChars ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(field);
  }
}

function ownerKey(owner: LocalSubtitleOwnerKey): string {
  return JSON.stringify([owner.webContentsId, owner.ownerSessionId]);
}

function invalid(field: string): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "invalid_ipc_request",
    "The local subtitle session registry input is invalid.",
    field,
  );
}

function invalidContent(field: string): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "invalid_content",
    "The local subtitle session state is invalid.",
    field,
  );
}

function failure(
  code: Extract<LocalSubtitleSessionRegistryErrorCode, "limit_exceeded">,
  field: string,
): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    code,
    "The local subtitle session registry limit was reached.",
    field,
  );
}

function ownerReleased(): LocalSubtitleSessionRegistryError {
  return new LocalSubtitleSessionRegistryError(
    "owner_released",
    "The local subtitle session owner has been released.",
    "owner",
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof Reflect.get(value, "then") === "function",
  );
}

function freezeDto<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDto(nested);
  }
  return Object.freeze(value);
}

function parseSnapshot(value: LocalSubtitleSessionSnapshot): LocalSubtitleSessionSnapshot {
  if (Buffer.byteLength(JSON.stringify(value),'utf8') > LOCAL_SUBTITLE_LIMITS.maxSessionSnapshotBytes) throw failure('limit_exceeded','snapshot');
  return value;
}
