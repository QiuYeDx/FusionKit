/**
 * Subtitle translation IPC registration.
 *
 * The historical translation/recovery channels remain available through an
 * explicit legacy adapter. New directory authority lives only under the
 * fixed subtitle-translation preload namespace.
 */

import {
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  SUBTITLE_TRANSLATION_INTERNAL_OPERATION_CONTRACTS,
  SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS,
  parseSubtitleTranslationTaskReference,
  subtitleTranslationIpcFailure,
  subtitleTranslationIpcSuccess,
  subtitleTranslationRegisterOwnerRequestSchema,
  subtitleTranslationSecureIpcEnvelopeSchema,
  type SubtitleTranslationIpcResult,
  type SubtitleTranslationAgentInputSelectionRequest,
  type SubtitleTranslationAgentTaskRegistrationRequest,
  type SubtitleTranslationAuthorizedTaskRegistrationRequest,
  type SubtitleTranslationGeneratedImportCandidateControl,
  type SubtitleTranslationGeneratedImportCandidateRequest,
  type SubtitleTranslationPreloadInternalChannel,
  type SubtitleTranslationTaskReference,
} from "@/type/subtitleTranslationIpc";
import { LocalSubtitleOwnerSessionRegistry } from "../local-subtitle/ipc-security";
import { LocalSubtitleAuthorizationError } from "../local-subtitle/authorizations";
import { LocalSubtitleArtifactRegistryError } from "../local-subtitle/subtitle-artifact-registry";
import { TranslationService } from "./translation-service";
import {
  SubtitleSliceType,
  type SubtitleTranslatorTask,
  type TranslationLanguage,
  type TranslationOutputMode,
  type TranslationRecoveryScanRequest,
  type TranslationRecoveryImportRequest,
} from "./typing";
import {
  scanTranslationRecoveryArtifacts,
  inspectTranslationRecoveryArtifact,
  createRecoveredSubtitleTaskDraft,
} from "./recovery-discovery";
import {
  SubtitleTranslationCapabilityError,
  SubtitleTranslationDirectoryCapabilityRegistry,
  createLegacySubtitleTranslationTaskReference,
  type SubtitleTranslationOwnerKey,
} from "./directory-capability";
import { GeneratedSubtitleImportCandidateService } from "./generated-import-candidate";

type DirectoryDialogResult = {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
};

type SubtitleTranslationInternalChannel = Exclude<
  SubtitleTranslationPreloadInternalChannel,
  typeof SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession
>;

export interface SubtitleTranslationIpcServiceOptions {
  readonly ownerSessions?: LocalSubtitleOwnerSessionRegistry;
  readonly directoryCapabilities?: SubtitleTranslationDirectoryCapabilityRegistry;
  readonly selectAgentInputFiles?: () => Promise<DirectoryDialogResult>;
  readonly selectOutputDirectory?: () => Promise<DirectoryDialogResult>;
  readonly localOwnerSessions?: LocalSubtitleOwnerSessionRegistry;
  readonly generatedImports?: GeneratedSubtitleImportCandidateService;
}

export class SubtitleTranslationIpcService {
  readonly ownerSessions: LocalSubtitleOwnerSessionRegistry;
  readonly directoryCapabilities: SubtitleTranslationDirectoryCapabilityRegistry;
  private readonly selectAgentInputFilesImpl: () => Promise<DirectoryDialogResult>;
  private readonly selectOutputDirectoryImpl: () => Promise<DirectoryDialogResult>;
  private readonly localOwnerSessions?: LocalSubtitleOwnerSessionRegistry;
  private readonly generatedImports?: GeneratedSubtitleImportCandidateService;

  constructor(options: SubtitleTranslationIpcServiceOptions = {}) {
    this.ownerSessions = options.ownerSessions ??
      new LocalSubtitleOwnerSessionRegistry();
    this.directoryCapabilities = options.directoryCapabilities ??
      new SubtitleTranslationDirectoryCapabilityRegistry();
    this.localOwnerSessions = options.localOwnerSessions;
    this.generatedImports = options.generatedImports;
    this.selectAgentInputFilesImpl = options.selectAgentInputFiles ?? (() =>
      dialog.showOpenDialog({
        title: "Select subtitle files to translate",
        filters: [{ name: "Subtitle Files", extensions: ["lrc", "srt", "vtt"] }],
        properties: ["openFile", "multiSelections"],
      }));
    this.selectOutputDirectoryImpl = options.selectOutputDirectory ?? (() =>
      dialog.showOpenDialog({
        title: "Select subtitle translation output directory",
        properties: ["openDirectory", "createDirectory"],
      }));
  }

  registerOwnerSession(
    event: IpcMainEvent,
    request: unknown,
  ): SubtitleTranslationIpcResult<{ readonly ownerSessionId: string }> {
    if (!subtitleTranslationRegisterOwnerRequestSchema.safeParse(request).success) {
      return invalidRequestFailure();
    }
    const registration = this.ownerSessions.register(event);
    if (!registration.ok) return mapOwnerFailure(registration.error.code);
    return subtitleTranslationIpcSuccess(registration.data);
  }

  async handleInternal(
    channel: SubtitleTranslationInternalChannel,
    event: IpcMainInvokeEvent,
    envelope: unknown,
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    const contract = SUBTITLE_TRANSLATION_INTERNAL_OPERATION_CONTRACTS[channel];
    if (!contract) return invalidRequestFailure();
    const secureEnvelope = subtitleTranslationSecureIpcEnvelopeSchema(
      contract.requestSchema,
    ).safeParse(envelope);
    if (!secureEnvelope.success) return invalidRequestFailure();
    const authorization = this.ownerSessions.authorize<unknown>(
      event,
      secureEnvelope.data,
    );
    if (!authorization.ok) return mapOwnerFailure(authorization.error.code);
    const request = contract.requestSchema.safeParse(authorization.data.payload);
    if (!request.success) return invalidRequestFailure();
    const owner = toOwnerKey(authorization.data);

    try {
      let response: SubtitleTranslationIpcResult<unknown>;
      switch (channel) {
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.authorizeInputFile: {
          const input = await this.directoryCapabilities.authorizeInputFile(
            owner,
            (request.data as { readonly filePath: string }).filePath,
          );
          if (!this.ownerSessions.isCurrent(authorization.data)) {
            this.directoryCapabilities.revokeInputFile(owner, input.inputToken);
            response = ownerReleasedFailure();
            break;
          }
          response = subtitleTranslationIpcSuccess(input);
          break;
        }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeInputFile:
          response = subtitleTranslationIpcSuccess({
            revoked: this.directoryCapabilities.revokeInputFile(
              owner,
              (request.data as { readonly inputToken: string }).inputToken,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readInputFile:
          response = subtitleTranslationIpcSuccess(
            await this.directoryCapabilities.readInputFile(
              owner,
              (request.data as { readonly inputToken: string }).inputToken,
            ),
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectAgentInputFiles:
          response = await this.selectAgentInputs(
            owner,
            authorization.data,
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.readAgentInputFile: {
          const selectionRequest = request.data as
            SubtitleTranslationAgentInputSelectionRequest;
          response = subtitleTranslationIpcSuccess(
            await this.directoryCapabilities.readAgentInputFile(
              owner,
              selectionRequest.selectionRef,
              selectionRequest.itemRef,
            ),
          );
          break;
        }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeAgentInputSelection:
          response = subtitleTranslationIpcSuccess({
            revoked: this.directoryCapabilities.revokeAgentInputSelection(
              owner,
              (request.data as { readonly selectionRef: string }).selectionRef,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAgentAuthorizedTask:
          response = subtitleTranslationIpcSuccess(
            await this.directoryCapabilities.registerAgentAuthorizedTask({
              owner,
              ...(request.data as SubtitleTranslationAgentTaskRegistrationRequest),
            }),
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerAuthorizedTask:
          response = subtitleTranslationIpcSuccess(
            await this.directoryCapabilities.registerAuthorizedTask({
              owner,
              ...(request.data as SubtitleTranslationAuthorizedTaskRegistrationRequest),
            }),
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskSource: {
          const filePath = await this.directoryCapabilities
            .resolveAuthorizedTaskSourceForSender(
              event.sender.id,
              (request.data as { readonly taskId: string }).taskId,
            );
          shell.showItemInFolder(filePath);
          response = subtitleTranslationIpcSuccess({ revealed: true });
          break;
        }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectOutputDirectory:
          response = await this.selectDirectory(owner, authorization.data, event);
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeOutputDirectory:
          response = subtitleTranslationIpcSuccess({
            revoked: this.directoryCapabilities.revokeDraft(
              owner,
              (request.data as { readonly directoryToken: string }).directoryToken,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.reauthorizeTaskTarget:
          response = await this.reauthorizeTaskTarget(
            owner,
            authorization.data,
            (request.data as { readonly taskId: string }).taskId,
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.acquireImportDirectoryLease: {
          const leaseRequest = request.data as {
            readonly directoryToken: string;
            readonly snapshotId: string;
            readonly expiresAt: number;
          };
          response = subtitleTranslationIpcSuccess(
            await this.directoryCapabilities.acquireImportLease(
              owner,
              leaseRequest.snapshotId,
              leaseRequest.directoryToken,
              leaseRequest.expiresAt,
            ),
          );
          break;
        }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseImportDirectoryLease:
          response = subtitleTranslationIpcSuccess({
            released: this.directoryCapabilities.releaseImportLease(
              owner,
              (request.data as { readonly directoryLeaseToken: string })
                .directoryLeaseToken,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.createGeneratedImportCandidate: {
          if (!this.generatedImports || !this.localOwnerSessions) {
            response = invalidRequestFailure();
            break;
          }
          const candidateRequest = request.data as
            SubtitleTranslationGeneratedImportCandidateRequest & {
              readonly localOwnerSessionId: string;
            };
          const localAuthorization = this.localOwnerSessions.authorize(
            event,
            {
              ownerSessionId: candidateRequest.localOwnerSessionId,
              payload: {},
            },
          );
          if (!localAuthorization.ok) {
            response = mapOwnerFailure(localAuthorization.error.code);
            break;
          }
          const {
            localOwnerSessionId: _localOwnerSessionId,
            ...mainRequest
          } = candidateRequest;
          response = subtitleTranslationIpcSuccess(
            await this.generatedImports.create(
              {
                webContentsId: localAuthorization.data.senderId,
                ownerSessionId: localAuthorization.data.ownerSessionId,
              },
              owner,
              mainRequest,
            ),
          );
          break;
        }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.commitGeneratedImportCandidate:
          if (!this.generatedImports) {
            response = invalidRequestFailure();
            break;
          }
          response = subtitleTranslationIpcSuccess({
            committed: this.generatedImports.commit(
              owner,
              request.data as SubtitleTranslationGeneratedImportCandidateControl,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedImportCandidate:
          if (!this.generatedImports) {
            response = invalidRequestFailure();
            break;
          }
          response = subtitleTranslationIpcSuccess({
            released: this.generatedImports.release(
              owner,
              request.data as SubtitleTranslationGeneratedImportCandidateControl,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.releaseGeneratedTask:
          response = subtitleTranslationIpcSuccess({
            released: this.generatedImports
              ? this.generatedImports.releaseTask(
                  owner,
                  (request.data as { readonly taskId: string }).taskId,
                )
              : this.directoryCapabilities.releaseGeneratedTask(
                  owner,
                  (request.data as { readonly taskId: string }).taskId,
                ),
          });
          break;
      }
      const validated = contract.resultSchema.safeParse(response);
      return validated.success
        ? validated.data as SubtitleTranslationIpcResult<unknown>
        : subtitleTranslationIpcFailure(
            "invalid_content",
            "The subtitle translation IPC handler returned invalid content.",
          );
    } catch (error) {
      return capabilityFailure(error);
    }
  }

  releaseOwner(owner: {
    readonly senderId: number;
    readonly ownerSessionId: string;
  }): void {
    this.generatedImports?.releaseOwner(toOwnerKey(owner));
    this.directoryCapabilities.releaseOwner(toOwnerKey(owner));
  }

  async resolveExecutionTaskForSender(
    webContentsId: number,
    value: unknown,
  ): Promise<{
    readonly task: SubtitleTranslatorTask;
    readonly generated: boolean;
    readonly authorized: boolean;
    readonly owner?: SubtitleTranslationOwnerKey;
  }> {
    if (isReferencedTaskRequest(value)) {
      const reference = parseSubtitleTranslationTaskReference(value.reference);
      if (!reference || hasRawPathFields(value.task)) {
        throw new SubtitleTranslationCapabilityError(
          "invalid_ipc_request",
          "The subtitle translation task reference is invalid.",
          "reference",
        );
      }
      if (reference.kind === "legacy_path_v1") {
        const resolved = this.directoryCapabilities.resolveLegacyTaskReference(
          taskIdOf(value.task),
          reference,
        );
        return {
          task: {
            ...value.task,
            originFileURL: resolved.originFilePath,
            targetFileURL: resolved.targetDirectoryPath,
            ...(resolved.checkpointPath
              ? { checkpointPath: resolved.checkpointPath }
              : {}),
          } as SubtitleTranslatorTask,
          generated: false,
          authorized: false,
        };
      }

      const taskId = taskIdOf(value.task);
      const resolved = reference.kind === "authorized_task_v1"
        ? await this.directoryCapabilities.resolveAuthorizedTaskReferenceForSender(
            webContentsId,
            taskId,
            reference,
          )
        : await this.directoryCapabilities.resolveGeneratedTaskReferenceForSender(
            webContentsId,
            taskId,
            reference,
          );
      if (value.task.fileName !== resolved.outputFileName) {
        throw new SubtitleTranslationCapabilityError(
          "task_reference_conflict",
          "The subtitle output file name is not authoritative.",
          "fileName",
        );
      }
      const owner = this.ownerForTask(taskId, webContentsId);
      return {
        task: {
          ...value.task,
          originFileURL: resolved.kind === "authorized_task_v1"
            ? resolved.originFilePath
            : "",
          targetFileURL: resolved.targetDirectoryPath,
        } as SubtitleTranslatorTask,
        generated: resolved.kind === "generated_task_v1",
        authorized: true,
        owner,
      };
    }

    if (!isRecord(value)) {
      throw new SubtitleTranslationCapabilityError(
        "invalid_ipc_request",
        "The subtitle translation task is invalid.",
        "task",
      );
    }
    const task = value as unknown as SubtitleTranslatorTask;
    const legacy = createLegacySubtitleTranslationTaskReference(task);
    const resolved = this.directoryCapabilities.resolveLegacyTaskReference(
      taskIdOf(task),
      legacy,
    );
    return {
      task: {
        ...task,
        originFileURL: resolved.originFilePath,
        targetFileURL: resolved.targetDirectoryPath,
        ...(resolved.checkpointPath
          ? { checkpointPath: resolved.checkpointPath }
          : {}),
      },
      generated: false,
      authorized: false,
    };
  }

  private ownerForTask(
    taskId: string,
    webContentsId: number,
  ): SubtitleTranslationOwnerKey {
    const record = this.directoryCapabilities.getTaskOwner(taskId);
    if (!record || record.webContentsId !== webContentsId) {
      throw new SubtitleTranslationCapabilityError(
        "invalid_ipc_request",
        "The subtitle task owner is unavailable.",
        "taskId",
      );
    }
    return record;
  }

  private async selectDirectory(
    owner: SubtitleTranslationOwnerKey,
    ownerIdentity: Parameters<LocalSubtitleOwnerSessionRegistry["isCurrent"]>[0],
    _event: IpcMainInvokeEvent,
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    const selected = await this.selectOutputDirectoryImpl();
    const directoryPath = selected.filePaths[0];
    if (selected.canceled || !directoryPath) {
      return subtitleTranslationIpcSuccess({ cancelled: true });
    }
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      return ownerReleasedFailure();
    }
    const authorization = await this.directoryCapabilities.authorizeDraft(
      owner,
      directoryPath,
    );
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      this.directoryCapabilities.revokeDraft(owner, authorization.directoryToken);
      return ownerReleasedFailure();
    }
    return subtitleTranslationIpcSuccess({
      cancelled: false,
      ...authorization,
    });
  }

  private async selectAgentInputs(
    owner: SubtitleTranslationOwnerKey,
    ownerIdentity: Parameters<LocalSubtitleOwnerSessionRegistry["isCurrent"]>[0],
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    const selected = await this.selectAgentInputFilesImpl();
    if (selected.canceled || selected.filePaths.length === 0) {
      return subtitleTranslationIpcSuccess({ cancelled: true });
    }
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      return ownerReleasedFailure();
    }
    const selection = await this.directoryCapabilities
      .authorizeAgentInputSelection(owner, selected.filePaths);
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      this.directoryCapabilities.revokeAgentInputSelection(
        owner,
        selection.selectionRef,
      );
      return ownerReleasedFailure();
    }
    return subtitleTranslationIpcSuccess(selection);
  }

  private async reauthorizeTaskTarget(
    owner: SubtitleTranslationOwnerKey,
    ownerIdentity: Parameters<LocalSubtitleOwnerSessionRegistry["isCurrent"]>[0],
    taskId: string,
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    this.directoryCapabilities.assertTaskCanReauthorize(owner, taskId);
    const selected = await this.selectOutputDirectoryImpl();
    const directoryPath = selected.filePaths[0];
    if (selected.canceled || !directoryPath) {
      return subtitleTranslationIpcSuccess({ cancelled: true, taskId });
    }
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      return ownerReleasedFailure();
    }
    const rotated = await this.directoryCapabilities.rotateTaskTarget(
      owner,
      taskId,
      directoryPath,
    );
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      this.directoryCapabilities.markTaskTerminal(taskId);
      return ownerReleasedFailure();
    }
    return subtitleTranslationIpcSuccess(rotated);
  }
}

export function setupTranslationIPC(
  translationService: TranslationService,
  ipcService = new SubtitleTranslationIpcService(),
): SubtitleTranslationIpcService {
  const registerChannel =
    SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.registerOwnerSession;
  ipcMain.on(registerChannel, (event, request: unknown) => {
    event.returnValue = ipcService.registerOwnerSession(event, request);
  });
  for (const channel of Object.values(
    SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS,
  )) {
    if (channel === registerChannel) continue;
    ipcMain.handle(channel, (event, envelope: unknown) =>
      ipcService.handleInternal(channel, event, envelope));
  }
  ipcService.ownerSessions.onOwnerReleased((owner) =>
    ipcService.releaseOwner(owner));

  ipcMain.handle("translate-subtitle", async (event, request: unknown) => {
    let execution:
      | Awaited<ReturnType<SubtitleTranslationIpcService["resolveExecutionTaskForSender"]>>
      | undefined;
    try {
      execution = await ipcService.resolveExecutionTaskForSender(
        event.sender.id,
        request,
      );
      const result = await translationService.processTask(
        execution.task,
        execution.authorized && execution.owner
          ? {
              revalidateTarget: () =>
                ipcService.directoryCapabilities.revalidateTaskTarget(
                  execution!.owner!,
                  execution!.task.taskId,
                ),
              validateOutputPath: (outputFilePath) =>
                ipcService.directoryCapabilities.validateTaskOutputPath(
                  execution!.owner!,
                  execution!.task.taskId,
                  outputFilePath,
                ),
            }
          : undefined,
      );
      if (execution.authorized && isTerminalExecutionResult(result)) {
        ipcService.directoryCapabilities.markTaskTerminal(execution.task.taskId);
      }
      return result;
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof SubtitleTranslationCapabilityError
          ? error.code
          : "invalid_task_reference",
      };
    }
  });

  ipcMain.handle(
    "estimate-subtitle-tokens",
    async (_, data: {
      content: string;
      sliceType: SubtitleSliceType;
      customSliceLength?: number;
      inputTokenPrice?: number;
      outputTokenPrice?: number;
      fileName?: string;
      sourceLang?: TranslationLanguage;
      targetLang?: TranslationLanguage;
      translationOutputMode?: TranslationOutputMode;
    }) => translationService.estimateTokens(
      data.content,
      data.sliceType,
      data.customSliceLength,
      data.inputTokenPrice,
      data.outputTokenPrice,
      data.fileName,
      data.sourceLang,
      data.targetLang,
      data.translationOutputMode,
    ),
  );

  ipcMain.on("cancel-translation", (event, taskId: string) => {
    if (
      ipcService.directoryCapabilities.isAuthorizedTask(taskId) &&
      !ipcService.directoryCapabilities.isGeneratedTaskOwnedBySender(
        taskId,
        event.sender.id,
      )
    ) {
      return;
    }
    translationService.cancelTask(taskId);
  });

  ipcMain.handle(
    "scan-translation-recovery-artifacts",
    async (_, request: TranslationRecoveryScanRequest) =>
      scanTranslationRecoveryArtifacts(request),
  );
  ipcMain.handle(
    "inspect-translation-recovery-artifact",
    async (_, checkpointPath: string) =>
      inspectTranslationRecoveryArtifact(checkpointPath),
  );
  ipcMain.handle(
    "create-recovered-subtitle-task-draft",
    async (_, request: TranslationRecoveryImportRequest) =>
      createRecoveredSubtitleTaskDraft(request),
  );
  ipcMain.handle("select-recovery-manifest-file", async () => {
    const result = await dialog.showOpenDialog({
      title: "Import Recovery Manifest",
      filters: [{ name: "Recovery Manifest", extensions: ["json"] }],
      properties: ["openFile"],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : result.filePaths[0];
  });
  return ipcService;
}

interface ReferencedTaskRequest {
  readonly task: Record<string, unknown>;
  readonly reference: SubtitleTranslationTaskReference;
}

function isReferencedTaskRequest(value: unknown): value is ReferencedTaskRequest {
  return isRecord(value) &&
    Reflect.ownKeys(value).length === 2 &&
    isRecord(value.task) &&
    "reference" in value;
}

function hasRawPathFields(task: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(task, "originFileURL") ||
    Object.prototype.hasOwnProperty.call(task, "targetFileURL") ||
    Object.prototype.hasOwnProperty.call(task, "checkpointPath");
}

function taskIdOf(value: Record<string, unknown>): string {
  return typeof value.taskId === "string" ? value.taskId : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOwnerKey(owner: {
  readonly senderId: number;
  readonly ownerSessionId: string;
}): SubtitleTranslationOwnerKey {
  return Object.freeze({
    webContentsId: owner.senderId,
    ownerSessionId: owner.ownerSessionId,
  });
}

function capabilityFailure(
  error: unknown,
): SubtitleTranslationIpcResult<never> {
  if (error instanceof SubtitleTranslationCapabilityError) {
    return subtitleTranslationIpcFailure(error.code, error.message, error.field);
  }
  if (error instanceof LocalSubtitleAuthorizationError) {
    return subtitleTranslationIpcFailure(
      error.code === "authorization_expired"
        ? "artifact_expired"
        : error.code === "invalid_content"
          ? "invalid_content"
          : error.code === "owner_released"
            ? "owner_released"
            : "invalid_ipc_request",
      error.message,
      error.field,
    );
  }
  if (error instanceof LocalSubtitleArtifactRegistryError) {
    return subtitleTranslationIpcFailure(
      error.code === "content_too_large"
        ? "content_too_large"
        : error.code === "artifact_expired"
          ? "artifact_expired"
          : error.code === "owner_released"
            ? "owner_released"
            : "invalid_content",
      error.message,
      error.field,
    );
  }
  return subtitleTranslationIpcFailure(
        "output_write_failed",
        "The subtitle translation directory operation failed.",
      );
}

function mapOwnerFailure(code: string): SubtitleTranslationIpcResult<never> {
  return code === "owner_released"
    ? ownerReleasedFailure()
    : invalidRequestFailure();
}

function invalidRequestFailure(): SubtitleTranslationIpcResult<never> {
  return subtitleTranslationIpcFailure(
    "invalid_ipc_request",
    "The subtitle translation IPC request is invalid.",
  );
}

function ownerReleasedFailure(): SubtitleTranslationIpcResult<never> {
  return subtitleTranslationIpcFailure(
    "owner_released",
    "The subtitle translation owner session is unavailable.",
  );
}

function isTerminalExecutionResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "completed" || value.status === "cancelled") return true;
  return value.status === "failed" &&
    value.error !== "invalid_task_identity" &&
    value.error !== "configuration_required" &&
    value.error !== "task_already_active";
}
