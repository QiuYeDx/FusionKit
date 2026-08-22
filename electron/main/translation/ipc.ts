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
  type SubtitleTranslationErrorCode,
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
} from "./typing";
import {
  SubtitleTranslationCapabilityError,
  SubtitleTranslationDirectoryCapabilityRegistry,
  type SubtitleTranslationOwnerKey,
} from "./directory-capability";
import { GeneratedSubtitleImportCandidateService } from "./generated-import-candidate";
import { SubtitleTranslationRecoveryCapabilityRegistry } from "./recovery-capability";
import { buildCheckpointPaths } from "./checkpoint";
import { cleanupOnTaskDeletion } from "./recovery-artifacts";

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
  readonly recoveryCapabilities?: SubtitleTranslationRecoveryCapabilityRegistry;
  readonly selectRecoveryDirectory?: () => Promise<DirectoryDialogResult>;
  readonly selectRecoveryManifest?: () => Promise<DirectoryDialogResult>;
}

export class SubtitleTranslationIpcService {
  readonly ownerSessions: LocalSubtitleOwnerSessionRegistry;
  readonly directoryCapabilities: SubtitleTranslationDirectoryCapabilityRegistry;
  private readonly selectAgentInputFilesImpl: () => Promise<DirectoryDialogResult>;
  private readonly selectOutputDirectoryImpl: () => Promise<DirectoryDialogResult>;
  private readonly localOwnerSessions?: LocalSubtitleOwnerSessionRegistry;
  private readonly generatedImports?: GeneratedSubtitleImportCandidateService;
  readonly recoveryCapabilities: SubtitleTranslationRecoveryCapabilityRegistry;
  private readonly selectRecoveryDirectoryImpl: () => Promise<DirectoryDialogResult>;
  private readonly selectRecoveryManifestImpl: () => Promise<DirectoryDialogResult>;

  constructor(options: SubtitleTranslationIpcServiceOptions = {}) {
    this.ownerSessions = options.ownerSessions ??
      new LocalSubtitleOwnerSessionRegistry();
    this.directoryCapabilities = options.directoryCapabilities ??
      new SubtitleTranslationDirectoryCapabilityRegistry();
    this.localOwnerSessions = options.localOwnerSessions;
    this.generatedImports = options.generatedImports;
    this.recoveryCapabilities = options.recoveryCapabilities ??
      new SubtitleTranslationRecoveryCapabilityRegistry();
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
    this.selectRecoveryDirectoryImpl = options.selectRecoveryDirectory ?? (() =>
      dialog.showOpenDialog({
        title: "Select recovery directory",
        properties: ["openDirectory"],
      }));
    this.selectRecoveryManifestImpl = options.selectRecoveryManifest ?? (() =>
      dialog.showOpenDialog({
        title: "Import recovery manifest",
        filters: [{ name: "Recovery Manifest", extensions: ["json"] }],
        properties: ["openFile"],
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
          {
          const taskId = (request.data as { readonly taskId: string }).taskId;
          const cleanupTargets = new Map<string, ReturnType<typeof buildCheckpointPaths>>();
          const directoryTarget = await this.directoryCapabilities
            .resolveTaskArtifactCleanupTarget(owner, taskId);
          if (directoryTarget) {
            const paths = buildCheckpointPaths(
              directoryTarget.outputDirectoryPath,
              directoryTarget.outputFileName,
              taskId,
            );
            cleanupTargets.set(paths.manifestPath, paths);
          }
          const checkpointPaths = await this.recoveryCapabilities
            .resolveTaskArtifactCleanupPaths(owner, taskId);
          if (checkpointPaths) {
            cleanupTargets.set(checkpointPaths.manifestPath, checkpointPaths);
          }
          const cleanupResults = await Promise.all(
            [...cleanupTargets.values()].map(cleanupOnTaskDeletion),
          );
          if (cleanupResults.some((failures) => failures.length > 0)) {
            throw new SubtitleTranslationCapabilityError(
              "output_write_failed",
              "Subtitle recovery artifact cleanup did not complete.",
              "taskId",
            );
          }
          const directoryReleased = this.generatedImports
            ? this.generatedImports.releaseTask(owner, taskId)
            : this.directoryCapabilities.releaseGeneratedTask(owner, taskId);
          const recoveryReleased = this.recoveryCapabilities.releaseTask(
            owner,
            taskId,
          );
          response = subtitleTranslationIpcSuccess({
            released: directoryReleased || recoveryReleased,
          });
          break;
          }
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryDirectory:
          response = await this.selectRecoveryDirectory(
            owner,
            authorization.data,
            Boolean((request.data as { includeCompleted?: boolean }).includeCompleted),
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.selectRecoveryManifest:
          response = await this.selectRecoveryManifest(owner, authorization.data);
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.prepareRecoveredTasks:
          response = subtitleTranslationIpcSuccess(
            await this.recoveryCapabilities.prepareRecoveredTasks({
              owner,
              ...(request.data as {
                readonly recoveryScanId: string;
                readonly directoryToken: string;
                readonly candidateIds?: readonly string[];
                readonly batchStart?: number;
                readonly batchSize?: number;
              }),
              directoryCapabilities: this.directoryCapabilities,
            }),
          );
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revokeRecoveryScan:
          response = subtitleTranslationIpcSuccess({
            released: this.recoveryCapabilities.revokeScan(
              owner,
              (request.data as { readonly recoveryScanId: string }).recoveryScanId,
            ),
          });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealRecoveryCheckpoint:
          shell.showItemInFolder(
            this.recoveryCapabilities.resolveCheckpointForReveal(
              owner,
              (request.data as { readonly checkpointRef: string }).checkpointRef,
            ),
          );
          response = subtitleTranslationIpcSuccess({ revealed: true });
          break;
        case SUBTITLE_TRANSLATION_PRELOAD_INTERNAL_CHANNELS.revealTaskOutput:
          shell.showItemInFolder(
            this.directoryCapabilities.resolveTaskFinalOutputForSender(
              event.sender.id,
              (request.data as { readonly taskId: string }).taskId,
            ),
          );
          response = subtitleTranslationIpcSuccess({ revealed: true });
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
    this.recoveryCapabilities.releaseOwner(toOwnerKey(owner));
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
      const checkpointRef = typeof value.task.checkpointRef === "string"
        ? value.task.checkpointRef
        : undefined;
      const checkpointPath = checkpointRef
        ? await this.recoveryCapabilities.resolveCheckpointForTask(
            owner,
            taskId,
            checkpointRef,
          )
        : undefined;
      return {
        task: {
          ...value.task,
          originFileURL: resolved.kind === "authorized_task_v1"
            ? resolved.originFilePath
            : "",
          targetFileURL: resolved.targetDirectoryPath,
          ...(checkpointPath
            ? { checkpointPath, recoveryInputMode: "manifest_fragments" as const }
            : {}),
        } as SubtitleTranslatorTask,
        generated: resolved.kind === "generated_task_v1",
        authorized: true,
        owner,
      };
    }

    throw new SubtitleTranslationCapabilityError(
      "invalid_ipc_request",
      "Subtitle translation tasks require an owner-bound reference.",
      "reference",
    );
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

  private async selectRecoveryDirectory(
    owner: SubtitleTranslationOwnerKey,
    ownerIdentity: Parameters<LocalSubtitleOwnerSessionRegistry["isCurrent"]>[0],
    includeCompleted: boolean,
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    const selected = await this.selectRecoveryDirectoryImpl();
    const directoryPath = selected.filePaths[0];
    if (selected.canceled || !directoryPath) {
      return subtitleTranslationIpcSuccess({ cancelled: true });
    }
    if (!this.ownerSessions.isCurrent(ownerIdentity)) return ownerReleasedFailure();
    const result = await this.recoveryCapabilities.scanDirectory(
      owner,
      directoryPath,
      includeCompleted,
    );
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      this.recoveryCapabilities.revokeScan(owner, result.recoveryScanId);
      return ownerReleasedFailure();
    }
    return subtitleTranslationIpcSuccess(result);
  }

  private async selectRecoveryManifest(
    owner: SubtitleTranslationOwnerKey,
    ownerIdentity: Parameters<LocalSubtitleOwnerSessionRegistry["isCurrent"]>[0],
  ): Promise<SubtitleTranslationIpcResult<unknown>> {
    const selected = await this.selectRecoveryManifestImpl();
    const checkpointPath = selected.filePaths[0];
    if (selected.canceled || !checkpointPath) {
      return subtitleTranslationIpcSuccess({ cancelled: true });
    }
    if (!this.ownerSessions.isCurrent(ownerIdentity)) return ownerReleasedFailure();
    const result = await this.recoveryCapabilities.inspectManifest(
      owner,
      checkpointPath,
    );
    if (!this.ownerSessions.isCurrent(ownerIdentity)) {
      this.recoveryCapabilities.revokeScan(owner, result.recoveryScanId);
      return ownerReleasedFailure();
    }
    return subtitleTranslationIpcSuccess(result);
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
              authorizeCheckpoint: (checkpointPath) =>
                ipcService.recoveryCapabilities.authorizeCheckpoint(
                  execution!.owner!,
                  execution!.task.taskId,
                  checkpointPath,
                ),
              releaseCheckpoint: () => {
                ipcService.recoveryCapabilities.releaseTask(
                  execution!.owner!,
                  execution!.task.taskId,
                );
              },
              recordFinalOutput: (outputFilePath) =>
                ipcService.directoryCapabilities.recordTaskFinalOutput(
                  execution!.owner!,
                  execution!.task.taskId,
                  outputFilePath,
                ),
              emit: (channel, payload) => {
                if (!event.sender.isDestroyed()) {
                  event.sender.send(channel, payload);
                }
              },
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
      mapLocalAuthorizationFailureCode(error.code),
      error.message,
      error.field,
    );
  }
  if (error instanceof LocalSubtitleArtifactRegistryError) {
    return subtitleTranslationIpcFailure(
      mapLocalArtifactFailureCode(error.code),
      error.message,
      error.field,
    );
  }
  return subtitleTranslationIpcFailure(
    "output_write_failed",
    "The subtitle translation directory operation failed.",
  );
}

function mapLocalAuthorizationFailureCode(
  code: LocalSubtitleAuthorizationError["code"],
): SubtitleTranslationErrorCode {
  switch (code) {
    case "authorization_expired":
    case "media_changed":
      return "artifact_expired";
    case "limit_exceeded":
      return "content_too_large";
    case "invalid_ipc_request":
    case "owner_released":
    case "output_write_failed":
    case "invalid_content":
      return code;
  }
}

function mapLocalArtifactFailureCode(
  code: LocalSubtitleArtifactRegistryError["code"],
): SubtitleTranslationErrorCode {
  switch (code) {
    case "limit_exceeded":
      return "content_too_large";
    case "invalid_ipc_request":
    case "owner_released":
    case "artifact_expired":
    case "artifact_changed":
    case "content_too_large":
    case "invalid_content":
      return code;
  }
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
  // Failed and cancelled tasks retain their target/checkpoint authority so a
  // same-owner retry can resume. Delete/clear and owner release still revoke it.
  return value.status === "completed";
}
