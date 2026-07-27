import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import type { ZodType } from "zod";
import {
  LOCAL_SUBTITLE_ERROR_MANIFEST,
  createLocalSubtitleError,
  type LocalSubtitleResourceEventEnvelope,
  type LocalSubtitleTaskEventEnvelope,
} from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS,
  LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS,
  localSubtitleIpcFailure,
  localSubtitleIpcSuccess,
  validateLocalSubtitleControlRequest,
  validateLocalSubtitleResourceEventEnvelope,
  validateLocalSubtitleTaskEventEnvelope,
  type LocalSubtitleIpcResult,
  type LocalSubtitlePreloadInternalChannel,
  type LocalSubtitlePublicInvokeChannel,
} from "@/type/localSubtitleIpc";
import {
  LocalSubtitleAuthorizationError,
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleImportTokenRegistry,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type LocalSubtitleOwnerKey,
  type ResolvedLocalSubtitleOutputDirectory,
} from "./authorizations";
import {
  sharedLocalSubtitleOwnerSessionRegistry,
  type AuthorizedLocalSubtitleIpcRequest,
  type LocalSubtitleOwnerIdentity,
  type LocalSubtitleOwnerSessionRegistry,
} from "./ipc-security";
import type { LocalSubtitleOverwriteRecoverySummary } from "./overwrite-recovery-owner";
import type {
  LocalSubtitleMainRuntimeShutdownReason,
  LocalSubtitleMainRuntimeTarget,
} from "./main-runtime";
import {
  LocalSubtitleArtifactRegistry,
  LocalSubtitleArtifactRegistryError,
} from "./subtitle-artifact-registry";
import { LocalSubtitleMediaError } from "./media-normalizer";
import { LocalSubtitleJobManagerError } from "./job-manager";
import {
  LocalSubtitleModelManagerError,
} from "./model-manager";
import { LocalSubtitleModelError } from "./model-manifest";
import { LocalSubtitleResourceError } from "./resource-manifest";
import { LocalSubtitleSessionRegistryError } from "./session-registry";

type MaybePromise<T> = T | Promise<T>;

export interface LocalSubtitleIpcHandlerContext {
  readonly owner: LocalSubtitleOwnerKey;
  readonly ownerIdentity: LocalSubtitleOwnerIdentity;
  readonly event: IpcMainInvokeEvent;
  readonly capabilities: LocalSubtitleIpcCapabilities;
  readonly signal: AbortSignal;
  readonly isOwnerCurrent: () => boolean;
}

export type LocalSubtitlePublicIpcHandler = (
  request: unknown,
  context: LocalSubtitleIpcHandlerContext,
) => MaybePromise<LocalSubtitleIpcResult<unknown>>;

export interface LocalSubtitleIpcHandlers {
  readonly public?: Partial<
    Record<LocalSubtitlePublicInvokeChannel, LocalSubtitlePublicIpcHandler>
  >;
  readonly importModel?: (
    request: { readonly filePath: string; readonly mode: "copy" | "move" },
    context: LocalSubtitleIpcHandlerContext,
  ) => MaybePromise<LocalSubtitleIpcResult<unknown>>;
  readonly overwriteRecovery?:
    | Readonly<{
        status: "ready";
        describe: (
          request: { readonly recoveryId: string },
          context: LocalSubtitleIpcHandlerContext,
        ) => MaybePromise<LocalSubtitleIpcResult<LocalSubtitleOverwriteRecoverySummary>>;
        retry: (
          request: { readonly recoveryId: string },
          expected: LocalSubtitleOverwriteRecoverySummary,
          context: LocalSubtitleIpcHandlerContext,
        ) => MaybePromise<LocalSubtitleIpcResult<unknown>>;
        recover: (
          request: { readonly recoveryId: string },
          directory: ResolvedLocalSubtitleOutputDirectory,
          expected: LocalSubtitleOverwriteRecoverySummary,
          context: LocalSubtitleIpcHandlerContext,
        ) => MaybePromise<LocalSubtitleIpcResult<unknown>>;
      }>
    | Readonly<{ status: "unavailable" }>
    | Readonly<{ status: "blocked" }>;
  readonly onOwnerReleased?: (owner: LocalSubtitleOwnerIdentity) => void;
}

export interface LocalSubtitleIpcCapabilities {
  readonly inputs: LocalSubtitleInputAuthorizationRegistry;
  readonly outputs: LocalSubtitleOutputDirectoryAuthorizationRegistry;
  readonly leases: LocalSubtitleCapabilityLeaseCoordinator;
  readonly artifacts: LocalSubtitleArtifactRegistry;
  readonly importTokens: LocalSubtitleImportTokenRegistry<unknown>;
}

export type LocalSubtitleOutputDirectorySelector = () => Promise<{
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}>;

export type LocalSubtitleOverwriteRecoveryDirectorySelector = (
  event: IpcMainInvokeEvent,
) => Promise<{
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}>;

export interface LocalSubtitleIpcServiceOptions {
  readonly ownerSessions?: LocalSubtitleOwnerSessionRegistry;
  readonly capabilities?: Partial<LocalSubtitleIpcCapabilities>;
  readonly handlers?: LocalSubtitleIpcHandlers;
  readonly selectOutputDirectory?: LocalSubtitleOutputDirectorySelector;
  readonly selectOverwriteRecoveryDirectory?: LocalSubtitleOverwriteRecoveryDirectorySelector;
  readonly overwriteRecoveryAdmissions?: LocalSubtitleOverwriteRecoveryAdmissionCoordinator;
}

interface ActiveOverwriteRecoveryAdmission {
  readonly owner: LocalSubtitleOwnerIdentity;
  phase: "selecting" | "recovering";
}

const NOOP_OVERWRITE_RECOVERY_TARGET: LocalSubtitleMainRuntimeTarget = {
  releaseOwner: () => undefined,
  shutdown: () => Promise.resolve(),
};

export class LocalSubtitleOverwriteRecoveryAdmissionCoordinator
  implements LocalSubtitleMainRuntimeTarget
{
  readonly #active = new Map<string, ActiveOverwriteRecoveryAdmission>();
  readonly #target: LocalSubtitleMainRuntimeTarget;
  #closed = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(
    target: LocalSubtitleMainRuntimeTarget = NOOP_OVERWRITE_RECOVERY_TARGET,
  ) {
    if (
      !target ||
      typeof target !== "object" ||
      typeof target.releaseOwner !== "function" ||
      typeof target.shutdown !== "function"
    ) {
      throw new TypeError("The overwrite recovery lifecycle target is invalid.");
    }
    this.#target = target;
  }

  begin(
    recoveryId: string,
    owner: LocalSubtitleOwnerIdentity,
  ): ActiveOverwriteRecoveryAdmission | undefined {
    if (this.#closed || this.#active.has(recoveryId)) return undefined;
    const admission: ActiveOverwriteRecoveryAdmission = {
      owner,
      phase: "selecting",
    };
    this.#active.set(recoveryId, admission);
    return admission;
  }

  isCurrent(
    recoveryId: string,
    admission: ActiveOverwriteRecoveryAdmission,
  ): boolean {
    return this.#active.get(recoveryId) === admission;
  }

  finish(
    recoveryId: string,
    admission: ActiveOverwriteRecoveryAdmission,
  ): void {
    if (this.#active.get(recoveryId) === admission) {
      this.#active.delete(recoveryId);
    }
  }

  releaseSelectingOwner(owner: LocalSubtitleOwnerIdentity): void {
    for (const [recoveryId, admission] of this.#active) {
      if (
        admission.phase === "selecting" &&
        sameOwnerIdentity(admission.owner, owner)
      ) {
        this.#active.delete(recoveryId);
      }
    }
  }

  releaseOwner(owner: LocalSubtitleOwnerKey): void {
    for (const [recoveryId, admission] of this.#active) {
      if (
        admission.phase === "selecting" &&
        admission.owner.senderId === owner.webContentsId &&
        admission.owner.ownerSessionId === owner.ownerSessionId
      ) {
        this.#active.delete(recoveryId);
      }
    }
    this.#target.releaseOwner(owner);
  }

  shutdown(reason: LocalSubtitleMainRuntimeShutdownReason): Promise<void> {
    if (this.#shutdownOperation) return this.#shutdownOperation;
    this.#closed = true;
    for (const [recoveryId, admission] of this.#active) {
      if (admission.phase === "selecting") this.#active.delete(recoveryId);
    }

    let operation: Promise<void>;
    try {
      operation = this.#target.shutdown(reason);
    } catch (error) {
      this.#closed = false;
      throw error;
    }
    this.#shutdownOperation = operation;
    void operation.then(
      () => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
        }
      },
      () => {
        if (this.#shutdownOperation === operation) {
          this.#shutdownOperation = undefined;
          this.#closed = false;
        }
      },
    );
    return operation;
  }
}

export class LocalSubtitleIpcService {
  readonly ownerSessions: LocalSubtitleOwnerSessionRegistry;
  readonly capabilities: LocalSubtitleIpcCapabilities;
  private readonly handlers: LocalSubtitleIpcHandlers;
  private readonly selectOutputDirectoryImpl: LocalSubtitleOutputDirectorySelector;
  private readonly selectOverwriteRecoveryDirectoryImpl: LocalSubtitleOverwriteRecoveryDirectorySelector;
  private readonly overwriteRecoveryAdmissions: LocalSubtitleOverwriteRecoveryAdmissionCoordinator;

  constructor(options: LocalSubtitleIpcServiceOptions = {}) {
    this.ownerSessions =
      options.ownerSessions ?? sharedLocalSubtitleOwnerSessionRegistry;
    const inputs =
      options.capabilities?.inputs ??
      new LocalSubtitleInputAuthorizationRegistry();
    const outputs =
      options.capabilities?.outputs ??
      new LocalSubtitleOutputDirectoryAuthorizationRegistry();
    this.capabilities = {
      inputs,
      outputs,
      leases:
        options.capabilities?.leases ??
        new LocalSubtitleCapabilityLeaseCoordinator(inputs, outputs),
      artifacts:
        options.capabilities?.artifacts ??
        new LocalSubtitleArtifactRegistry(),
      importTokens:
        options.capabilities?.importTokens ??
        new LocalSubtitleImportTokenRegistry<unknown>(),
    };
    this.handlers = options.handlers ?? {};
    this.selectOutputDirectoryImpl =
      options.selectOutputDirectory ??
      (() =>
        dialog.showOpenDialog({
          title: "Select subtitle output directory",
          buttonLabel: "Select directory",
          properties: ["openDirectory", "createDirectory"],
        }));
    this.selectOverwriteRecoveryDirectoryImpl =
      options.selectOverwriteRecoveryDirectory ??
      ((event) => {
        const dialogOptions = {
          properties: ["openDirectory"] as Array<"openDirectory">,
        };
        const parent = BrowserWindow.fromWebContents(event.sender);
        return parent
          ? dialog.showOpenDialog(parent, dialogOptions)
          : dialog.showOpenDialog(dialogOptions);
      });
    this.overwriteRecoveryAdmissions =
      options.overwriteRecoveryAdmissions ??
      new LocalSubtitleOverwriteRecoveryAdmissionCoordinator();
  }

  registerOwnerSession(
    event: IpcMainEvent,
    request: unknown,
  ): LocalSubtitleIpcResult<unknown> {
    const channel =
      LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession;
    const contract = LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[channel];
    const validation = validateLocalSubtitleControlRequest(
      contract.requestSchema as ZodType<unknown>,
      request,
    );
    if (!validation.ok) return validation;

    return validateOperationResult(
      contract.resultSchema,
      this.ownerSessions.register(event),
    );
  }

  async handlePublic(
    channel: string,
    event: IpcMainInvokeEvent,
    envelope: unknown,
  ): Promise<LocalSubtitleIpcResult<unknown>> {
    if (!isPublicChannel(channel)) return invalidChannelFailure();
    const authorization = this.ownerSessions.authorize<unknown>(event, envelope);
    if (!authorization.ok) return authorization;

    const contract = LOCAL_SUBTITLE_PUBLIC_OPERATION_CONTRACTS[channel];
    const validation = validateLocalSubtitleControlRequest(
      contract.requestSchema as ZodType<unknown>,
      authorization.data.payload,
    );
    if (!validation.ok) return validation;

    const context = this.createContext(authorization.data, event);
    try {
      const handler = this.handlers.public?.[channel];
      const result = handler
        ? await handler(validation.data, context)
        : await this.runBuiltInPublic(channel, validation.data, context);
      if (!result) return unavailableOperationFailure(channel);
      if (!this.ownerSessions.isCurrent(context.ownerIdentity)) {
        return ownerReleasedFailure();
      }
      return validateOperationResult(contract.resultSchema, result);
    } catch (error) {
      if (!this.ownerSessions.isCurrent(context.ownerIdentity)) {
        return ownerReleasedFailure();
      }
      return toLocalSubtitleIpcFailure(error);
    }
  }

  async handleInternal(
    channel: string,
    event: IpcMainInvokeEvent,
    envelope: unknown,
  ): Promise<LocalSubtitleIpcResult<unknown>> {
    if (!isInternalChannel(channel)) return invalidChannelFailure();
    if (channel === LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession) {
      return invalidChannelFailure();
    }

    const authorization = this.ownerSessions.authorize<unknown>(event, envelope);
    if (!authorization.ok) return authorization;
    const contract = LOCAL_SUBTITLE_INTERNAL_OPERATION_CONTRACTS[channel];
    const validation = validateLocalSubtitleControlRequest(
      contract.requestSchema as ZodType<unknown>,
      authorization.data.payload,
    );
    if (!validation.ok) return validation;

    const context = this.createContext(authorization.data, event);
    try {
      const result = await this.runInternal(channel, validation.data, context);
      if (!this.ownerSessions.isCurrent(context.ownerIdentity)) {
        return ownerReleasedFailure();
      }
      return validateOperationResult(contract.resultSchema, result);
    } catch (error) {
      if (!this.ownerSessions.isCurrent(context.ownerIdentity)) {
        return ownerReleasedFailure();
      }
      return toLocalSubtitleIpcFailure(error);
    }
  }

  emitTaskEvent(
    owner: LocalSubtitleOwnerIdentity,
    payload: LocalSubtitleTaskEventEnvelope,
  ): boolean {
    const validation = validateLocalSubtitleTaskEventEnvelope(payload);
    if (!validation.ok) return false;
    return this.ownerSessions.sendToOwner(
      owner,
      LOCAL_SUBTITLE_EVENT_CHANNELS.taskEvent,
      validation.data,
    );
  }

  emitResourceEvent(
    owner: LocalSubtitleOwnerIdentity,
    payload: LocalSubtitleResourceEventEnvelope,
  ): boolean {
    const validation = validateLocalSubtitleResourceEventEnvelope(payload);
    if (!validation.ok) return false;
    return this.ownerSessions.sendToOwner(
      owner,
      LOCAL_SUBTITLE_EVENT_CHANNELS.resourceEvent,
      validation.data,
    );
  }

  releaseOwner(owner: LocalSubtitleOwnerIdentity): void {
    this.overwriteRecoveryAdmissions.releaseSelectingOwner(owner);
    const ownerKey = toOwnerKey(owner);
    try {
      this.handlers.onOwnerReleased?.(owner);
    } finally {
      this.capabilities.inputs.releaseOwner(ownerKey);
      this.capabilities.outputs.releaseOwner(ownerKey);
      this.capabilities.artifacts.releaseOwner(ownerKey);
      this.capabilities.importTokens.releaseOwner(ownerKey);
    }
  }

  private async runInternal(
    channel: Exclude<
      LocalSubtitlePreloadInternalChannel,
      typeof LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession
    >,
    request: unknown,
    context: LocalSubtitleIpcHandlerContext,
  ): Promise<LocalSubtitleIpcResult<unknown>> {
    switch (channel) {
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.authorizeInputFiles: {
        const { files } = request as {
          readonly files: readonly { readonly filePath: string }[];
        };
        const authorizations = await this.capabilities.inputs.authorizeMany(
          context.owner,
          files.map((file) => file.filePath),
        );
        return localSubtitleIpcSuccess(authorizations);
      }
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeInputFile: {
        const { fileToken } = request as { readonly fileToken: string };
        return localSubtitleIpcSuccess({
          revoked: this.capabilities.inputs.revokeDraft(
            context.owner,
            fileToken,
          ),
        });
      }
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory: {
        const selected = await this.selectOutputDirectoryImpl();
        const directoryPath = selected.filePaths[0];
        if (selected.canceled || !directoryPath) {
          return localSubtitleIpcSuccess({ cancelled: true });
        }
        if (!this.ownerSessions.isCurrent(context.ownerIdentity)) {
          return ownerReleasedFailure();
        }
        const authorization = await this.capabilities.outputs.authorize(
          context.owner,
          directoryPath,
        );
        return localSubtitleIpcSuccess({
          cancelled: false,
          outputDirToken: authorization.outputDirToken,
          displayLabel: authorization.directoryName,
          expiresAt: authorization.expiresAt,
        });
      }
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory: {
        const { outputDirToken } = request as {
          readonly outputDirToken: string;
        };
        return localSubtitleIpcSuccess({
          revoked: this.capabilities.outputs.revokeDraft(
            context.owner,
            outputDirToken,
          ),
        });
      }
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.importModel: {
        if (!this.handlers.importModel) {
          return resourceManagerUnavailableFailure();
        }
        const importRequest = request as {
          readonly filePath: string;
          readonly mode: "copy" | "move";
        };
        if (!path.isAbsolute(importRequest.filePath)) {
          return invalidRequestFailure(
            "Local subtitle model import requires a selected file.",
            "filePath",
          );
        }
        return this.handlers.importModel(
          importRequest,
          context,
        );
      }
      case LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.recoverOverwrite: {
        const recovery = this.handlers.overwriteRecovery;
        if (!recovery || recovery.status === "blocked") {
          return overwriteRecoveryBlockedFailure();
        }
        if (recovery.status === "unavailable") {
          return overwriteRecoveryUnavailableFailure();
        }
        const requestData = request as { readonly recoveryId: string };
        const admission = this.overwriteRecoveryAdmissions.begin(
          requestData.recoveryId,
          context.ownerIdentity,
        );
        if (!admission) return overwriteRecoveryBusyFailure();
        try {
          const described = await recovery.describe(requestData, context);
          if (
            !this.overwriteRecoveryAdmissions.isCurrent(
              requestData.recoveryId,
              admission,
            ) ||
            !context.isOwnerCurrent()
          ) {
            return ownerReleasedFailure();
          }
          if (!described.ok) return described;
          if (!described.data.requiresDirectorySelection) {
            admission.phase = "recovering";
            return await recovery.retry(requestData, described.data, context);
          }

          const selected = await this.selectOverwriteRecoveryDirectoryImpl(
            context.event,
          );
          if (
            !this.overwriteRecoveryAdmissions.isCurrent(
              requestData.recoveryId,
              admission,
            ) ||
            !context.isOwnerCurrent()
          ) {
            return ownerReleasedFailure();
          }
          const directoryPath = selected.filePaths[0];
          if (selected.canceled || !directoryPath) {
            return localSubtitleIpcSuccess({ status: "cancelled" as const });
          }

          let outputDirToken: string | undefined;
          try {
            const authorization = await this.capabilities.outputs.authorize(
              context.owner,
              directoryPath,
            );
            outputDirToken = authorization.outputDirToken;
            if (
              !this.overwriteRecoveryAdmissions.isCurrent(
                requestData.recoveryId,
                admission,
              ) ||
              !context.isOwnerCurrent()
            ) {
              return ownerReleasedFailure();
            }
            const directory = await this.capabilities.outputs.resolveDraft(
              context.owner,
              outputDirToken,
            );
            if (
              !this.overwriteRecoveryAdmissions.isCurrent(
                requestData.recoveryId,
                admission,
              ) ||
              !context.isOwnerCurrent()
            ) {
              return ownerReleasedFailure();
            }
            admission.phase = "recovering";
            return await recovery.recover(
              requestData,
              directory,
              described.data,
              context,
            );
          } catch (error) {
            if (!context.isOwnerCurrent()) return ownerReleasedFailure();
            if (error instanceof LocalSubtitleAuthorizationError) {
              return overwriteDirectoryAuthorizationFailure();
            }
            throw error;
          } finally {
            if (outputDirToken) {
              this.capabilities.outputs.revokeDraft(
                context.owner,
                outputDirToken,
              );
            }
          }
        } finally {
          this.overwriteRecoveryAdmissions.finish(
            requestData.recoveryId,
            admission,
          );
        }
      }
    }
  }

  private async runBuiltInPublic(
    channel: LocalSubtitlePublicInvokeChannel,
    request: unknown,
    context: LocalSubtitleIpcHandlerContext,
  ): Promise<LocalSubtitleIpcResult<unknown> | undefined> {
    switch (channel) {
      case LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText: {
        const { artifactRef } = request as { readonly artifactRef: string };
        return localSubtitleIpcSuccess(
          await this.capabilities.artifacts.readText(
            context.owner,
            artifactRef,
          ),
        );
      }
      case LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact: {
        const { artifactRef } = request as { readonly artifactRef: string };
        return localSubtitleIpcSuccess(
          await this.capabilities.artifacts.reveal(
            context.owner,
            artifactRef,
          ),
        );
      }
      default:
        return undefined;
    }
  }

  private createContext(
    authorization: AuthorizedLocalSubtitleIpcRequest<unknown>,
    event: IpcMainInvokeEvent,
  ): LocalSubtitleIpcHandlerContext {
    const ownerIdentity: LocalSubtitleOwnerIdentity = {
      ownerSessionId: authorization.ownerSessionId,
      senderId: authorization.senderId,
      processId: authorization.processId,
      frameId: authorization.frameId,
    };
    return {
      owner: toOwnerKey(ownerIdentity),
      ownerIdentity,
      event,
      capabilities: this.capabilities,
      signal: authorization.signal,
      isOwnerCurrent: () => this.ownerSessions.isCurrent(ownerIdentity),
    };
  }
}

export function setupLocalSubtitleIPC(
  service = new LocalSubtitleIpcService(),
): LocalSubtitleIpcService {
  const registerChannel =
    LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession;
  ipcMain.on(registerChannel, (event, request: unknown) => {
    event.returnValue = service.registerOwnerSession(event, request);
  });

  for (const channel of Object.values(
    LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS,
  )) {
    if (channel === registerChannel) continue;
    ipcMain.handle(channel, (event, envelope: unknown) =>
      service.handleInternal(channel, event, envelope),
    );
  }

  for (const channel of Object.values(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS)) {
    ipcMain.handle(channel, (event, envelope: unknown) =>
      service.handlePublic(channel, event, envelope),
    );
  }

  service.ownerSessions.onOwnerReleased((owner) => service.releaseOwner(owner));
  return service;
}

function validateOperationResult(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  result: unknown,
): LocalSubtitleIpcResult<unknown> {
  const validation = schema.safeParse(result);
  if (validation.success) {
    return validation.data as LocalSubtitleIpcResult<unknown>;
  }
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "invalid_content",
      "Local subtitle IPC handler returned an invalid response.",
      { stage: "ipc" },
    ),
  );
}

function toLocalSubtitleIpcFailure(
  error: unknown,
): LocalSubtitleIpcResult<never> {
  if (error instanceof LocalSubtitleAuthorizationError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.code, error.message, {
        ...(error.field ? { field: error.field } : {}),
      }),
    );
  }
  if (error instanceof LocalSubtitleArtifactRegistryError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.code, error.message, {
        stage: "artifact",
        ...(error.field ? { field: error.field } : {}),
      }),
    );
  }
  if (error instanceof LocalSubtitleMediaError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(
        error.localSubtitleCode,
        "Local subtitle media operation failed.",
        { stage: error.stage },
      ),
    );
  }
  if (error instanceof LocalSubtitleJobManagerError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.localSubtitleCode, error.message, {
        stage: error.stage,
        ...(error.field ? { field: error.field } : {}),
      }),
    );
  }
  if (error instanceof LocalSubtitleModelManagerError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.localSubtitleCode, error.message, {
        ...(error.field ? { field: error.field } : {}),
      }),
    );
  }
  if (error instanceof LocalSubtitleModelError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.code, error.message),
    );
  }
  if (error instanceof LocalSubtitleSessionRegistryError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(error.localSubtitleCode, error.message, {
        ...(error.field ? { field: error.field } : {}),
      }),
    );
  }
  if (error instanceof LocalSubtitleResourceError) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(
        error.code,
        "Local subtitle runtime resource is unavailable.",
        { stage: LOCAL_SUBTITLE_ERROR_MANIFEST[error.code].defaultStage },
      ),
    );
  }
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "invalid_ipc_request",
      "Local subtitle IPC request could not be completed.",
    ),
  );
}

function unavailableOperationFailure(
  channel: LocalSubtitlePublicInvokeChannel,
): LocalSubtitleIpcResult<never> {
  if (
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.readArtifactText ||
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.revealArtifact
  ) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(
        "artifact_expired",
        "Local subtitle artifact service is unavailable.",
      ),
    );
  }
  if (channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.handoffArtifact) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(
        "configuration_not_ready",
        "Local subtitle handoff service is unavailable.",
      ),
    );
  }
  if (
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.listManagedResources ||
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.startResourceInstall ||
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.cancelResourceJob ||
    channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.deleteManagedResource
  ) {
    return resourceManagerUnavailableFailure();
  }
  if (channel === LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS.probeMedia) {
    return localSubtitleIpcFailure(
      createLocalSubtitleError(
        "media_runtime_missing",
        "Local subtitle media service is unavailable.",
      ),
    );
  }
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "runtime_missing",
      "Local subtitle task service is unavailable.",
    ),
  );
}

function resourceManagerUnavailableFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "resource_not_allowed",
      "Local subtitle resource service is unavailable.",
    ),
  );
}

function overwriteRecoveryUnavailableFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "runtime_missing",
      "Overwrite recovery runtime is unavailable.",
    ),
  );
}

function overwriteRecoveryBlockedFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "configuration_not_ready",
      "Overwrite recovery state is unavailable.",
    ),
  );
}

function overwriteRecoveryBusyFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "resource_busy",
      "Overwrite recovery is already in progress.",
    ),
  );
}

function overwriteDirectoryAuthorizationFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "directory_authorization_required",
      "The original subtitle output directory must be selected again.",
    ),
  );
}

function ownerReleasedFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "owner_released",
      "Local subtitle IPC owner session is unavailable.",
    ),
  );
}

function invalidChannelFailure(): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError(
      "invalid_ipc_request",
      "Local subtitle IPC channel is not allowed.",
    ),
  );
}

function invalidRequestFailure(
  message: string,
  field?: string,
): LocalSubtitleIpcResult<never> {
  return localSubtitleIpcFailure(
    createLocalSubtitleError("invalid_ipc_request", message, {
      ...(field ? { field } : {}),
    }),
  );
}

function toOwnerKey(owner: LocalSubtitleOwnerIdentity): LocalSubtitleOwnerKey {
  return {
    webContentsId: owner.senderId,
    ownerSessionId: owner.ownerSessionId,
  };
}

function sameOwnerIdentity(
  left: LocalSubtitleOwnerIdentity,
  right: LocalSubtitleOwnerIdentity,
): boolean {
  return left.ownerSessionId === right.ownerSessionId &&
    left.senderId === right.senderId &&
    left.processId === right.processId &&
    left.frameId === right.frameId;
}

const PUBLIC_CHANNELS = new Set<string>(
  Object.values(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS),
);
const INTERNAL_CHANNELS = new Set<string>(
  Object.values(LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS),
);

function isPublicChannel(
  channel: string,
): channel is LocalSubtitlePublicInvokeChannel {
  return PUBLIC_CHANNELS.has(channel);
}

function isInternalChannel(
  channel: string,
): channel is LocalSubtitlePreloadInternalChannel {
  return INTERNAL_CHANNELS.has(channel);
}
