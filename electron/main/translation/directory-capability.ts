import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  localSubtitleFilesystemObjectIdentityForPath,
  sameLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity,
} from "../local-subtitle/filesystem-object-identity";
import {
  parseSubtitleTranslationTaskReference,
  SUBTITLE_TRANSLATION_LIMITS,
  subtitleTranslationDisplayLabelSchema,
  subtitleTranslationOpaqueRefSchema,
  subtitleTranslationOutputLeafSchema,
  subtitleTranslationTaskIdSchema,
  type SubtitleTranslationErrorCode,
  type SubtitleTranslationAuthorizedTaskReference,
  type SubtitleTranslationAgentTaskRegistrationRequest,
  type SubtitleTranslationGeneratedTaskReference,
  type SubtitleTranslationTaskReference,
} from "@/type/subtitleTranslationIpc";

const DEFAULT_DRAFT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TARGET_TTL_MS = 30 * 60 * 1000;
const MAX_TOKEN_ATTEMPTS = 8;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const AGENT_SUBTITLE_EXTENSIONS = new Set([".lrc", ".srt", ".vtt"]);

export interface SubtitleTranslationOwnerKey {
  readonly webContentsId: number;
  readonly ownerSessionId: string;
}

export interface SubtitleTranslationDirectoryCapabilityOptions {
  readonly draftTtlMs?: number;
  readonly targetTtlMs?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly beforeVerify?: () => void | Promise<void>;
}

interface DirectoryDescriptor {
  readonly directoryPath: string;
  readonly displayLabel: string;
  readonly identity: LocalSubtitleFilesystemObjectIdentity;
}

interface DraftDirectoryEntry extends DirectoryDescriptor {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly expiresAt: number;
}

interface InputFileDescriptor {
  readonly filePath: string;
  readonly displayName: string;
  readonly identity: LocalSubtitleFilesystemObjectIdentity;
  readonly parent: DirectoryDescriptor;
}

interface DraftInputFileEntry extends InputFileDescriptor {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly expiresAt: number;
}

interface AgentInputSelectionEntry {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly expiresAt: number;
  readonly items: readonly {
    readonly itemRef: string;
    readonly inputToken: string;
    readonly displayName: string;
  }[];
}

interface TaskInputFileEntry extends InputFileDescriptor {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
}

interface TaskTargetEntry extends DirectoryDescriptor {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
  readonly outputFileName: string;
  readonly expiresAt: number;
}

interface ImportDirectoryLeaseEntry extends DirectoryDescriptor {
  readonly token: string;
  readonly owner: SubtitleTranslationOwnerKey;
  readonly snapshotId: string;
  readonly expiresAt: number;
}

interface GeneratedTaskRecord {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
  readonly handoffKey?: string;
  readonly sourceDisplayName: string;
  readonly outputFileName: string;
  readonly state: "candidate" | "active" | "terminal";
  readonly candidateBinding?: string;
  readonly inputFile?: TaskInputFileEntry;
  readonly target?: TaskTargetEntry;
  readonly artifactDirectory: DirectoryDescriptor;
  readonly finalOutputPath?: string;
}

export interface RegisterAuthorizedSubtitleTranslationTaskRequest {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
  readonly inputToken: string;
  readonly outputMode: "source" | "custom";
  readonly outputFileName: string;
  readonly directoryToken?: string;
}

export interface RegisterAgentAuthorizedSubtitleTranslationTaskRequest
  extends SubtitleTranslationAgentTaskRegistrationRequest {
  readonly owner: SubtitleTranslationOwnerKey;
}

export interface RegisterGeneratedSubtitleTranslationTaskRequest {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
  readonly handoffKey?: string;
  readonly sourceDisplayName: string;
  readonly outputFileName: string;
  readonly directoryToken: string;
}

export interface RegisterRecoveredSubtitleTranslationTaskBatchRequest {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly directoryToken: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly fileName: string;
  }[];
}

export interface RegisterGeneratedSubtitleTranslationCandidateRequest {
  readonly owner: SubtitleTranslationOwnerKey;
  readonly taskId: string;
  readonly handoffKey: string;
  readonly candidateBinding: string;
  readonly sourceDisplayName: string;
  readonly outputFileName: string;
}

export interface SubtitleTranslationPrivateDirectoryAuthority {
  readonly directoryPath: string;
  readonly displayLabel: string;
  readonly identity: LocalSubtitleFilesystemObjectIdentity;
}

export interface ResolvedGeneratedSubtitleTranslationTarget {
  readonly kind: "generated_task_v1";
  readonly targetDirectoryPath: string;
  readonly outputFilePath: string;
  readonly outputFileName: string;
  readonly expiresAt: number;
}

export interface ResolvedAuthorizedSubtitleTranslationPaths {
  readonly kind: "authorized_task_v1";
  readonly originFilePath: string;
  readonly targetDirectoryPath: string;
  readonly outputFilePath: string;
  readonly outputFileName: string;
  readonly expiresAt: number;
}

export interface SubtitleTranslationTaskArtifactCleanupTarget {
  readonly outputDirectoryPath: string;
  readonly outputFileName: string;
}

export type ResolvedSubtitleTranslationTaskReference =
  | ResolvedAuthorizedSubtitleTranslationPaths
  | ResolvedGeneratedSubtitleTranslationTarget;

export class SubtitleTranslationCapabilityError extends Error {
  readonly name = "SubtitleTranslationCapabilityError";

  constructor(
    readonly code: SubtitleTranslationErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class SubtitleTranslationDirectoryCapabilityRegistry {
  readonly draftTtlMs: number;
  readonly targetTtlMs: number;
  private readonly drafts = new Map<string, DraftDirectoryEntry>();
  private readonly inputDrafts = new Map<string, DraftInputFileEntry>();
  private readonly agentSelections = new Map<string, AgentInputSelectionEntry>();
  private readonly importLeases = new Map<string, ImportDirectoryLeaseEntry>();
  private readonly targets = new Map<string, TaskTargetEntry>();
  private readonly generatedTasks = new Map<string, GeneratedTaskRecord>();
  private readonly releasedOwners = new Set<string>();
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly beforeVerify?: () => void | Promise<void>;

  constructor(options: SubtitleTranslationDirectoryCapabilityOptions = {}) {
    this.draftTtlMs = validTtl(options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS);
    this.targetTtlMs = validTtl(options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS);
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.beforeVerify = options.beforeVerify;
  }

  async authorizeDraft(
    owner: SubtitleTranslationOwnerKey,
    directoryPath: string,
  ) {
    assertOwner(owner);
    this.assertOwnerActive(owner);
    const descriptor = await inspectDirectory(directoryPath);
    this.assertOwnerActive(owner);
    this.sweepExpired();
    const token = this.mintToken("draft");
    const entry = Object.freeze({
      ...descriptor,
      token,
      owner: Object.freeze({ ...owner }),
      expiresAt: addTtl(this.now(), this.draftTtlMs),
    });
    this.drafts.set(token, entry);
    return Object.freeze({
      directoryToken: token,
      displayLabel: entry.displayLabel,
      expiresAt: entry.expiresAt,
    });
  }

  async authorizeInputFile(
    owner: SubtitleTranslationOwnerKey,
    filePath: string,
  ) {
    assertOwner(owner);
    this.assertOwnerActive(owner);
    const descriptor = await inspectInputFile(filePath);
    this.assertOwnerActive(owner);
    this.sweepExpired();
    const token = this.mintToken("input");
    const entry = Object.freeze({
      ...descriptor,
      token,
      owner: Object.freeze({ ...owner }),
      expiresAt: addTtl(this.now(), this.draftTtlMs),
    });
    this.inputDrafts.set(token, entry);
    return Object.freeze({
      inputToken: token,
      displayName: entry.displayName,
      expiresAt: entry.expiresAt,
    });
  }

  revokeInputFile(owner: SubtitleTranslationOwnerKey, token: string): boolean {
    assertOwner(owner);
    const entry = this.inputDrafts.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) return false;
    this.inputDrafts.delete(token);
    return entry.expiresAt > this.now();
  }

  async readInputFile(
    owner: SubtitleTranslationOwnerKey,
    token: string,
  ): Promise<Readonly<{ displayName: string; content: string }>> {
    const input = this.requireInputDraft(owner, token);
    await this.verifyInputDescriptor(input, "inputToken");
    const before = this.requireInputDraft(owner, token);
    if (before !== input) throw conflict("The subtitle input authority changed.");
    const bytes = await readFile(input.filePath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
      throw new SubtitleTranslationCapabilityError(
        bytes.byteLength === 0 ? "invalid_content" : "content_too_large",
        "The selected subtitle input content is invalid.",
        "inputToken",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SubtitleTranslationCapabilityError(
        "invalid_content",
        "The selected subtitle input is not valid UTF-8.",
        "inputToken",
      );
    }
    await this.verifyInputDescriptor(input, "inputToken");
    if (this.requireInputDraft(owner, token) !== input) {
      throw conflict("The subtitle input authority changed.");
    }
    return Object.freeze({ displayName: input.displayName, content });
  }

  async authorizeAgentInputSelection(
    owner: SubtitleTranslationOwnerKey,
    filePaths: readonly string[],
  ) {
    assertOwner(owner);
    this.assertOwnerActive(owner);
    if (
      filePaths.length === 0 ||
      filePaths.length > SUBTITLE_TRANSLATION_LIMITS.maxAgentSelectionFiles
    ) {
      throw invalid("selection");
    }

    const items: Array<{
      readonly itemRef: string;
      readonly inputToken: string;
      readonly displayName: string;
    }> = [];
    const authorizedInputTokens: string[] = [];
    const canonicalFiles = new Set<string>();
    try {
      for (const filePath of filePaths) {
        const authorization = await this.authorizeInputFile(owner, filePath);
        authorizedInputTokens.push(authorization.inputToken);
        const input = this.requireInputDraft(owner, authorization.inputToken);
        if (!AGENT_SUBTITLE_EXTENSIONS.has(path.extname(input.displayName).toLowerCase())) {
          throw new SubtitleTranslationCapabilityError(
            "invalid_content",
            "The selected Agent input is not a supported subtitle file.",
            "selection",
          );
        }
        if (canonicalFiles.has(input.filePath)) {
          throw conflict("The Agent subtitle selection contains a duplicate file.");
        }
        canonicalFiles.add(input.filePath);
        const itemRef = this.mintToken("selection-item");
        if (items.some((item) => item.itemRef === itemRef)) {
          throw invalid("itemRef");
        }
        items.push(Object.freeze({
          itemRef,
          inputToken: input.token,
          displayName: input.displayName,
        }));
      }
      this.assertOwnerActive(owner);
      const token = this.mintToken("selection");
      if (items.some((item) => item.itemRef === token)) {
        throw invalid("selectionRef");
      }
      const expiresAt = Math.min(
        ...items.map((item) => this.requireInputDraft(owner, item.inputToken).expiresAt),
      );
      const entry = Object.freeze({
        token,
        owner: Object.freeze({ ...owner }),
        expiresAt,
        items: Object.freeze([...items]),
      });
      this.agentSelections.set(token, entry);
      return Object.freeze({
        cancelled: false as const,
        selectionRef: token,
        files: Object.freeze(items.map((item) => Object.freeze({
          itemRef: item.itemRef,
          displayName: item.displayName,
        }))),
        expiresAt,
      });
    } catch (error) {
      for (const inputToken of authorizedInputTokens) {
        this.revokeInputFile(owner, inputToken);
      }
      throw error;
    }
  }

  async readAgentInputFile(
    owner: SubtitleTranslationOwnerKey,
    selectionRef: string,
    itemRef: string,
  ): Promise<Readonly<{ displayName: string; content: string }>> {
    const { item } = this.requireAgentSelectionItem(
      owner,
      selectionRef,
      itemRef,
    );
    return this.readInputFile(owner, item.inputToken);
  }

  revokeAgentInputSelection(
    owner: SubtitleTranslationOwnerKey,
    selectionRef: string,
  ): boolean {
    assertOwner(owner);
    if (!subtitleTranslationOpaqueRefSchema.safeParse(selectionRef).success) {
      return false;
    }
    const selection = this.agentSelections.get(selectionRef);
    if (!selection || !sameOwner(selection.owner, owner)) return false;
    this.agentSelections.delete(selectionRef);
    for (const item of selection.items) {
      this.revokeInputFile(owner, item.inputToken);
    }
    return true;
  }

  async registerAgentAuthorizedTask(
    request: RegisterAgentAuthorizedSubtitleTranslationTaskRequest,
  ): Promise<SubtitleTranslationAuthorizedTaskReference> {
    const { selection, item } = this.requireAgentSelectionItem(
      request.owner,
      request.selectionRef,
      request.itemRef,
    );
    const reference = await this.registerAuthorizedTask({
      owner: request.owner,
      taskId: request.taskId,
      inputToken: item.inputToken,
      outputMode: request.outputMode,
      outputFileName: request.outputFileName,
      ...(request.directoryToken
        ? { directoryToken: request.directoryToken }
        : {}),
    });
    if (this.agentSelections.get(selection.token) === selection) {
      const remaining = selection.items.filter(
        (candidate) => candidate.itemRef !== item.itemRef,
      );
      if (remaining.length === 0) {
        this.agentSelections.delete(selection.token);
      } else {
        this.agentSelections.set(selection.token, Object.freeze({
          ...selection,
          items: Object.freeze(remaining),
        }));
      }
    }
    return reference;
  }

  async registerAuthorizedTask(
    request: RegisterAuthorizedSubtitleTranslationTaskRequest,
  ): Promise<SubtitleTranslationAuthorizedTaskReference> {
    assertOwner(request.owner);
    this.assertOwnerActive(request.owner);
    assertTaskId(request.taskId);
    const outputFileName = safeOutputLeaf(
      request.outputFileName,
      "outputFileName",
    );
    if (
      (request.outputMode === "custom") !== Boolean(request.directoryToken)
    ) {
      throw invalid("directoryToken");
    }
    if (this.generatedTasks.has(request.taskId)) {
      throw conflict("The subtitle task identity is already registered.");
    }

    const input = this.requireInputDraft(request.owner, request.inputToken);
    if (outputFileName !== input.displayName) {
      throw conflict("The subtitle task file name is not authoritative.");
    }
    await this.verifyInputDescriptor(input, "inputToken");
    const directory = request.outputMode === "source"
      ? input.parent
      : this.requireDraft(request.owner, request.directoryToken!);
    await this.verifyDescriptor(directory, "directoryToken");
    this.assertOwnerActive(request.owner);
    if (
      this.requireInputDraft(request.owner, request.inputToken) !== input ||
      (request.outputMode === "custom" &&
        this.requireDraft(request.owner, request.directoryToken!) !== directory) ||
      this.generatedTasks.has(request.taskId)
    ) {
      throw conflict("The subtitle task authority changed.");
    }

    const source = Object.freeze({
      filePath: input.filePath,
      displayName: input.displayName,
      identity: input.identity,
      parent: input.parent,
      token: this.mintToken("source"),
      owner: input.owner,
      taskId: request.taskId,
    });
    this.inputDrafts.delete(input.token);
    this.registerRecord({
      owner: input.owner,
      taskId: request.taskId,
      sourceDisplayName: input.displayName,
      outputFileName,
      state: "active",
      directory,
      inputFile: source,
    });
    const registered = this.generatedTasks.get(request.taskId);
    if (!registered?.inputFile || !registered.target) {
      throw conflict("The subtitle task authority was not registered.");
    }
    return referenceForAuthorized(
      registered as GeneratedTaskRecord & {
        readonly inputFile: TaskInputFileEntry;
        readonly target: TaskTargetEntry;
      },
    );
  }

  revokeDraft(owner: SubtitleTranslationOwnerKey, token: string): boolean {
    assertOwner(owner);
    const entry = this.drafts.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) return false;
    this.drafts.delete(token);
    return entry.expiresAt > this.now();
  }

  async registerGeneratedTask(
    request: RegisterGeneratedSubtitleTranslationTaskRequest,
  ): Promise<SubtitleTranslationGeneratedTaskReference> {
    const { owner, taskId, directoryToken } = request;
    assertOwner(owner);
    this.assertOwnerActive(owner);
    assertTaskId(taskId);
    const sourceDisplayName = safeOutputLeaf(
      request.sourceDisplayName,
      "source.displayName",
    );
    const outputFileName = safeOutputLeaf(
      request.outputFileName,
      "outputFileName",
    );
    if (
      request.handoffKey !== undefined &&
      !subtitleTranslationOpaqueRefSchema.safeParse(request.handoffKey).success
    ) {
      throw invalid("handoffKey");
    }
    if (this.generatedTasks.has(taskId)) {
      throw conflict("The generated subtitle task identity is already registered.");
    }

    const draft = this.requireDraft(owner, directoryToken);
    await this.verifyDescriptor(draft, "directoryToken");
    this.assertOwnerActive(owner);
    const current = this.requireDraft(owner, directoryToken);
    if (current !== draft || this.generatedTasks.has(taskId)) {
      throw conflict("The generated subtitle task authority changed.");
    }

    this.drafts.delete(directoryToken);
    return this.registerRecord({
      owner: draft.owner,
      taskId,
      ...(request.handoffKey ? { handoffKey: request.handoffKey } : {}),
      sourceDisplayName,
      outputFileName,
      state: "active",
      directory: draft,
    });
  }

  async registerRecoveredTaskBatch(
    request: RegisterRecoveredSubtitleTranslationTaskBatchRequest,
  ): Promise<readonly SubtitleTranslationGeneratedTaskReference[]> {
    assertOwner(request.owner);
    this.assertOwnerActive(request.owner);
    if (
      request.tasks.length === 0 ||
      request.tasks.length > SUBTITLE_TRANSLATION_LIMITS.maxRecoveryBatchFiles
    ) {
      throw invalid("tasks");
    }
    const taskIds = new Set<string>();
    const normalized = request.tasks.map((task) => {
      assertTaskId(task.taskId);
      if (taskIds.has(task.taskId) || this.generatedTasks.has(task.taskId)) {
        throw conflict("The recovered subtitle task identity is already registered.");
      }
      taskIds.add(task.taskId);
      return Object.freeze({
        taskId: task.taskId,
        fileName: safeOutputLeaf(task.fileName, "fileName"),
      });
    });
    const draft = this.requireDraft(request.owner, request.directoryToken);
    await this.verifyDescriptor(draft, "directoryToken");
    this.assertOwnerActive(request.owner);
    if (this.requireDraft(request.owner, request.directoryToken) !== draft) {
      throw conflict("The recovery output directory authority changed.");
    }

    const registeredTaskIds: string[] = [];
    try {
      const references = normalized.map((task) => {
        const reference = this.registerRecord({
          owner: request.owner,
          taskId: task.taskId,
          sourceDisplayName: task.fileName,
          outputFileName: task.fileName,
          state: "active",
          directory: draft,
        });
        registeredTaskIds.push(task.taskId);
        return reference;
      });
      this.drafts.delete(request.directoryToken);
      return Object.freeze(references);
    } catch (error) {
      for (const taskId of registeredTaskIds) {
        this.releaseGeneratedTask(request.owner, taskId);
      }
      throw error;
    }
  }

  async acquireImportLease(
    owner: SubtitleTranslationOwnerKey,
    snapshotId: string,
    directoryToken: string,
    requestedExpiresAt: number,
  ) {
    assertOwner(owner);
    this.assertOwnerActive(owner);
    if (!subtitleTranslationOpaqueRefSchema.safeParse(snapshotId).success) {
      throw invalid("snapshotId");
    }
    if (!Number.isSafeInteger(requestedExpiresAt)) throw invalid("expiresAt");
    const draft = this.requireDraft(owner, directoryToken);
    await this.verifyDescriptor(draft, "directoryToken");
    this.assertOwnerActive(owner);
    const current = this.requireDraft(owner, directoryToken);
    if (current !== draft) {
      throw conflict("The subtitle import directory authority changed.");
    }
    const expiresAt = Math.min(requestedExpiresAt, draft.expiresAt);
    if (expiresAt <= this.now()) throw expired("directoryToken");
    const token = this.mintToken("lease");
    const lease = Object.freeze({
      directoryPath: draft.directoryPath,
      displayLabel: draft.displayLabel,
      identity: draft.identity,
      token,
      owner: draft.owner,
      snapshotId,
      expiresAt,
    });
    this.importLeases.set(token, lease);
    return Object.freeze({
      directoryLeaseToken: token,
      displayLabel: lease.displayLabel,
      expiresAt,
    });
  }

  releaseImportLease(
    owner: SubtitleTranslationOwnerKey,
    directoryLeaseToken: string,
  ): boolean {
    assertOwner(owner);
    const lease = this.importLeases.get(directoryLeaseToken);
    if (!lease || !sameOwner(lease.owner, owner)) return false;
    this.importLeases.delete(directoryLeaseToken);
    return true;
  }

  async registerGeneratedTaskCandidateFromLease(
    request: RegisterGeneratedSubtitleTranslationCandidateRequest & {
      readonly snapshotId: string;
      readonly directoryLeaseToken: string;
    },
  ): Promise<SubtitleTranslationGeneratedTaskReference> {
    const lease = this.requireImportLease(
      request.owner,
      request.snapshotId,
      request.directoryLeaseToken,
    );
    await this.verifyDescriptor(lease, "directoryLeaseToken");
    if (
      this.requireImportLease(
        request.owner,
        request.snapshotId,
        request.directoryLeaseToken,
      ) !== lease
    ) {
      throw conflict("The subtitle import directory lease changed.");
    }
    return this.registerCandidate(request, lease);
  }

  async registerGeneratedTaskCandidateFromAuthority(
    request: RegisterGeneratedSubtitleTranslationCandidateRequest & {
      readonly directory: SubtitleTranslationPrivateDirectoryAuthority;
    },
  ): Promise<SubtitleTranslationGeneratedTaskReference> {
    const directory = validatePrivateDirectoryAuthority(request.directory);
    await this.verifyDescriptor(directory, "sourceDirectory");
    return this.registerCandidate(request, directory);
  }

  commitGeneratedTaskCandidate(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    candidateBinding: string,
  ): boolean {
    const record = this.requireCandidateBinding(owner, taskId, candidateBinding);
    if (record.state === "active") return true;
    if (record.state !== "candidate") return false;
    this.generatedTasks.set(taskId, Object.freeze({
      ...record,
      state: "active" as const,
    }));
    return true;
  }

  releaseGeneratedTaskCandidate(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    candidateBinding: string,
  ): boolean {
    const record = this.generatedTasks.get(taskId);
    if (
      !record ||
      !sameOwner(record.owner, owner) ||
      record.candidateBinding !== candidateBinding ||
      record.state !== "candidate"
    ) {
      return false;
    }
    if (record.target) this.targets.delete(record.target.token);
    this.generatedTasks.delete(taskId);
    return true;
  }

  releaseGeneratedTask(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): boolean {
    assertOwner(owner);
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (!record || !sameOwner(record.owner, owner)) return false;
    if (record.target) this.targets.delete(record.target.token);
    this.generatedTasks.delete(taskId);
    return true;
  }

  async resolveTaskArtifactCleanupTarget(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): Promise<SubtitleTranslationTaskArtifactCleanupTarget | undefined> {
    assertOwner(owner);
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (!record) return undefined;
    if (!sameOwner(record.owner, owner)) throw invalid("taskId");
    try {
      await lstat(record.artifactDirectory.directoryPath);
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
    await this.verifyDescriptor(record.artifactDirectory, "taskId");
    if (this.generatedTasks.get(taskId) !== record) {
      throw conflict("The subtitle task cleanup authority changed.");
    }
    return Object.freeze({
      outputDirectoryPath: record.artifactDirectory.directoryPath,
      outputFileName: record.outputFileName,
    });
  }

  async resolveTaskReference(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    value: unknown,
  ): Promise<ResolvedSubtitleTranslationTaskReference> {
    assertOwner(owner);
    assertTaskId(taskId);
    const reference = parseSubtitleTranslationTaskReference(value);
    if (!reference) throw invalid("reference");
    return reference.kind === "authorized_task_v1"
      ? this.resolveAuthorizedTaskReference(owner, taskId, reference)
      : this.resolveGeneratedTaskReference(owner, taskId, reference);
  }

  async resolveAuthorizedTaskReferenceForSender(
    webContentsId: number,
    taskId: string,
    value: unknown,
  ): Promise<ResolvedAuthorizedSubtitleTranslationPaths> {
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (!record || record.owner.webContentsId !== webContentsId) {
      throw invalid("reference");
    }
    const reference = parseSubtitleTranslationTaskReference(value);
    if (!reference || reference.kind !== "authorized_task_v1") {
      throw invalid("reference");
    }
    return this.resolveAuthorizedTaskReference(record.owner, taskId, reference);
  }

  async resolveAuthorizedTaskSourceForSender(
    webContentsId: number,
    taskId: string,
  ): Promise<string> {
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (
      !record ||
      record.owner.webContentsId !== webContentsId ||
      !record.inputFile ||
      record.state !== "active"
    ) {
      throw invalid("taskId");
    }
    await this.verifyInputDescriptor(record.inputFile, "source.token");
    if (this.generatedTasks.get(taskId) !== record) {
      throw conflict("The subtitle task source changed.");
    }
    return record.inputFile.filePath;
  }

  async resolveGeneratedTaskReferenceForSender(
    webContentsId: number,
    taskId: string,
    value: unknown,
  ): Promise<ResolvedGeneratedSubtitleTranslationTarget> {
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (!record || record.owner.webContentsId !== webContentsId) {
      throw invalid("reference");
    }
    const reference = parseSubtitleTranslationTaskReference(value);
    if (!reference || reference.kind !== "generated_task_v1") {
      throw invalid("reference");
    }
    return this.resolveGeneratedTaskReference(record.owner, taskId, reference);
  }

  async rotateTaskTarget(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    directoryPath: string,
  ) {
    assertOwner(owner);
    assertTaskId(taskId);
    this.assertOwnerActive(owner);
    const before = this.requireReauthorizableTask(owner, taskId);
    const descriptor = await inspectDirectory(directoryPath);
    this.assertOwnerActive(owner);
    const current = this.requireReauthorizableTask(owner, taskId);
    if (current !== before) {
      throw conflict("The generated subtitle task target changed.");
    }

    const token = this.mintToken("target");
    const target = Object.freeze({
      ...descriptor,
      token,
      owner: current.owner,
      taskId,
      outputFileName: current.outputFileName,
      expiresAt: addTtl(this.now(), this.targetTtlMs),
    });
    const next = Object.freeze({
      ...current,
      target,
      artifactDirectory: Object.freeze({
        directoryPath: descriptor.directoryPath,
        displayLabel: descriptor.displayLabel,
        identity: descriptor.identity,
      }),
    });
    const oldTarget = current.target;

    this.targets.set(token, target);
    this.generatedTasks.set(taskId, next);
    if (oldTarget) this.targets.delete(oldTarget.token);
    return Object.freeze({
      cancelled: false as const,
      taskId,
      target: targetReferenceFor(next),
      expiresAt: target.expiresAt,
    });
  }

  assertTaskCanReauthorize(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): void {
    assertOwner(owner);
    assertTaskId(taskId);
    this.assertOwnerActive(owner);
    this.requireReauthorizableTask(owner, taskId);
  }

  async revalidateTaskTarget(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): Promise<void> {
    const record = this.requireActiveTask(owner, taskId);
    await this.verifyDescriptor(record.target!, "target.token");
    if (this.requireActiveTask(owner, taskId) !== record) {
      throw conflict("The generated subtitle task target changed.");
    }
  }

  async validateTaskOutputPath(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    outputFilePath: string,
  ): Promise<void> {
    await this.revalidateTaskTarget(owner, taskId);
    const record = this.requireActiveTask(owner, taskId);
    const target = record.target!;
    const candidate = absolutePath(outputFilePath, "outputFilePath");
    const relative = path.relative(target.directoryPath, candidate);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.dirname(relative) !== "." ||
      !subtitleTranslationOutputLeafSchema.safeParse(path.basename(relative)).success
    ) {
      throw new SubtitleTranslationCapabilityError(
        "output_write_failed",
        "The subtitle output escaped its authorized directory.",
        "outputFilePath",
      );
    }
    try {
      const existing = await lstat(candidate);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw new SubtitleTranslationCapabilityError(
        "output_write_failed",
        "The subtitle output target is unsafe.",
        "outputFilePath",
      );
    }
    await this.revalidateTaskTarget(owner, taskId);
  }

  async recordTaskFinalOutput(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    outputFilePath: string,
  ): Promise<void> {
    const record = this.requireActiveTask(owner, taskId);
    await this.validateTaskOutputPath(owner, taskId, outputFilePath);
    const current = this.requireActiveTask(owner, taskId);
    if (current !== record) {
      throw conflict("The subtitle task authority changed.");
    }
    this.generatedTasks.set(taskId, Object.freeze({
      ...record,
      finalOutputPath: path.resolve(outputFilePath),
    }));
  }

  resolveTaskFinalOutputForSender(
    webContentsId: number,
    taskId: string,
  ): string {
    assertTaskId(taskId);
    const record = this.generatedTasks.get(taskId);
    if (
      !record ||
      record.owner.webContentsId !== webContentsId ||
      !record.finalOutputPath
    ) {
      throw invalid("taskId");
    }
    return record.finalOutputPath;
  }

  markTaskTerminal(taskId: string): boolean {
    const record = this.generatedTasks.get(taskId);
    if (!record || record.state === "terminal") return false;
    if (record.target) this.targets.delete(record.target.token);
    this.generatedTasks.set(taskId, Object.freeze({
      ...record,
      state: "terminal" as const,
      target: undefined,
    }));
    return true;
  }

  isGeneratedTask(taskId: string): boolean {
    const record = this.generatedTasks.get(taskId);
    return Boolean(record && !record.inputFile);
  }

  isAuthorizedTask(taskId: string): boolean {
    return this.generatedTasks.has(taskId);
  }

  isGeneratedTaskOwnedBySender(taskId: string, webContentsId: number): boolean {
    const record = this.generatedTasks.get(taskId);
    return record?.owner.webContentsId === webContentsId;
  }

  getGeneratedTaskOwner(
    taskId: string,
  ): SubtitleTranslationOwnerKey | undefined {
    const owner = this.generatedTasks.get(taskId)?.owner;
    return owner ? Object.freeze({ ...owner }) : undefined;
  }

  getTaskOwner(taskId: string): SubtitleTranslationOwnerKey | undefined {
    return this.getGeneratedTaskOwner(taskId);
  }

  releaseOwner(owner: SubtitleTranslationOwnerKey): void {
    assertOwner(owner);
    this.releasedOwners.add(ownerKey(owner));
    for (const [token, entry] of this.drafts) {
      if (sameOwner(entry.owner, owner)) this.drafts.delete(token);
    }
    for (const [token, entry] of this.inputDrafts) {
      if (sameOwner(entry.owner, owner)) this.inputDrafts.delete(token);
    }
    for (const [token, entry] of this.agentSelections) {
      if (sameOwner(entry.owner, owner)) this.agentSelections.delete(token);
    }
    for (const [token, entry] of this.importLeases) {
      if (sameOwner(entry.owner, owner)) this.importLeases.delete(token);
    }
    for (const [token, entry] of this.targets) {
      if (sameOwner(entry.owner, owner)) this.targets.delete(token);
    }
    for (const [taskId, record] of this.generatedTasks) {
      if (sameOwner(record.owner, owner)) this.generatedTasks.delete(taskId);
    }
  }

  sweepExpired(): number {
    const now = this.now();
    let swept = 0;
    for (const [token, entry] of this.agentSelections) {
      if (entry.expiresAt > now) continue;
      this.agentSelections.delete(token);
      for (const item of entry.items) {
        this.inputDrafts.delete(item.inputToken);
      }
      swept += 1;
    }
    for (const [token, entry] of this.drafts) {
      if (entry.expiresAt > now) continue;
      this.drafts.delete(token);
      swept += 1;
    }
    for (const [token, entry] of this.inputDrafts) {
      if (entry.expiresAt > now) continue;
      this.inputDrafts.delete(token);
      swept += 1;
    }
    for (const [token, entry] of this.importLeases) {
      if (entry.expiresAt > now) continue;
      this.importLeases.delete(token);
      swept += 1;
    }
    for (const [taskId, record] of this.generatedTasks) {
      if (!record.target || record.target.expiresAt > now) continue;
      this.targets.delete(record.target.token);
      this.generatedTasks.set(taskId, Object.freeze({
        ...record,
        target: undefined,
      }));
      swept += 1;
    }
    return swept;
  }

  private async resolveGeneratedTaskReference(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    reference: SubtitleTranslationGeneratedTaskReference,
  ): Promise<ResolvedGeneratedSubtitleTranslationTarget> {
    const record = this.requireActiveTask(owner, taskId);
    const target = record.target!;
    if (
      reference.source.displayName !== record.sourceDisplayName ||
      reference.target.token !== target.token ||
      reference.target.displayLabel !== target.displayLabel
    ) {
      throw conflict("The generated subtitle task reference is not authoritative.");
    }
    await this.verifyDescriptor(target, "target.token");
    const current = this.requireActiveTask(owner, taskId);
    if (current !== record || current.target !== target) {
      throw conflict("The generated subtitle task target changed.");
    }
    return Object.freeze({
      kind: "generated_task_v1" as const,
      targetDirectoryPath: target.directoryPath,
      outputFilePath: resolveSafeChild(target.directoryPath, target.outputFileName),
      outputFileName: target.outputFileName,
      expiresAt: target.expiresAt,
    });
  }

  private async resolveAuthorizedTaskReference(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    reference: SubtitleTranslationAuthorizedTaskReference,
  ): Promise<ResolvedAuthorizedSubtitleTranslationPaths> {
    const record = this.requireActiveTask(owner, taskId);
    const input = record.inputFile;
    const target = record.target!;
    if (
      !input ||
      reference.source.token !== input.token ||
      reference.source.displayName !== input.displayName ||
      reference.target.token !== target.token ||
      reference.target.displayLabel !== target.displayLabel
    ) {
      throw conflict("The subtitle task reference is not authoritative.");
    }
    await this.verifyInputDescriptor(input, "source.token");
    await this.verifyDescriptor(target, "target.token");
    const current = this.requireActiveTask(owner, taskId);
    if (current !== record || current.inputFile !== input || current.target !== target) {
      throw conflict("The subtitle task authority changed.");
    }
    return Object.freeze({
      kind: "authorized_task_v1" as const,
      originFilePath: input.filePath,
      targetDirectoryPath: target.directoryPath,
      outputFilePath: resolveSafeChild(target.directoryPath, target.outputFileName),
      outputFileName: target.outputFileName,
      expiresAt: target.expiresAt,
    });
  }

  private requireDraft(
    owner: SubtitleTranslationOwnerKey,
    token: string,
  ): DraftDirectoryEntry {
    if (!subtitleTranslationOpaqueRefSchema.safeParse(token).success) {
      throw invalid("directoryToken");
    }
    const entry = this.drafts.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) throw invalid("directoryToken");
    if (entry.expiresAt <= this.now()) {
      this.drafts.delete(token);
      throw expired("directoryToken");
    }
    return entry;
  }

  private requireInputDraft(
    owner: SubtitleTranslationOwnerKey,
    token: string,
  ): DraftInputFileEntry {
    if (!subtitleTranslationOpaqueRefSchema.safeParse(token).success) {
      throw invalid("inputToken");
    }
    const entry = this.inputDrafts.get(token);
    if (!entry || !sameOwner(entry.owner, owner)) throw invalid("inputToken");
    if (entry.expiresAt <= this.now()) {
      this.inputDrafts.delete(token);
      throw expired("inputToken");
    }
    return entry;
  }

  private requireAgentSelectionItem(
    owner: SubtitleTranslationOwnerKey,
    selectionRef: string,
    itemRef: string,
  ): {
    readonly selection: AgentInputSelectionEntry;
    readonly item: AgentInputSelectionEntry["items"][number];
  } {
    if (
      !subtitleTranslationOpaqueRefSchema.safeParse(selectionRef).success ||
      !subtitleTranslationOpaqueRefSchema.safeParse(itemRef).success
    ) {
      throw invalid("selectionRef");
    }
    const selection = this.agentSelections.get(selectionRef);
    if (!selection || !sameOwner(selection.owner, owner)) {
      throw invalid("selectionRef");
    }
    if (selection.expiresAt <= this.now()) {
      this.revokeAgentInputSelection(owner, selectionRef);
      throw expired("selectionRef");
    }
    const item = selection.items.find((candidate) => candidate.itemRef === itemRef);
    if (!item) throw invalid("itemRef");
    return { selection, item };
  }

  private requireImportLease(
    owner: SubtitleTranslationOwnerKey,
    snapshotId: string,
    token: string,
  ): ImportDirectoryLeaseEntry {
    assertOwner(owner);
    if (
      !subtitleTranslationOpaqueRefSchema.safeParse(snapshotId).success ||
      !subtitleTranslationOpaqueRefSchema.safeParse(token).success
    ) {
      throw invalid("directoryLeaseToken");
    }
    const entry = this.importLeases.get(token);
    if (
      !entry ||
      !sameOwner(entry.owner, owner) ||
      entry.snapshotId !== snapshotId
    ) {
      throw invalid("directoryLeaseToken");
    }
    if (entry.expiresAt <= this.now()) {
      this.importLeases.delete(token);
      throw expired("directoryLeaseToken");
    }
    return entry;
  }

  private registerCandidate(
    request: RegisterGeneratedSubtitleTranslationCandidateRequest,
    directory: DirectoryDescriptor,
  ): SubtitleTranslationGeneratedTaskReference {
    assertOwner(request.owner);
    this.assertOwnerActive(request.owner);
    assertTaskId(request.taskId);
    if (
      !subtitleTranslationOpaqueRefSchema.safeParse(request.handoffKey).success ||
      !subtitleTranslationOpaqueRefSchema.safeParse(request.candidateBinding).success
    ) {
      throw invalid("candidateBinding");
    }
    return this.registerRecord({
      owner: request.owner,
      taskId: request.taskId,
      handoffKey: request.handoffKey,
      candidateBinding: request.candidateBinding,
      sourceDisplayName: safeOutputLeaf(
        request.sourceDisplayName,
        "source.displayName",
      ),
      outputFileName: safeOutputLeaf(request.outputFileName, "outputFileName"),
      state: "candidate",
      directory,
    });
  }

  private registerRecord(input: {
    readonly owner: SubtitleTranslationOwnerKey;
    readonly taskId: string;
    readonly handoffKey?: string;
    readonly candidateBinding?: string;
    readonly sourceDisplayName: string;
    readonly outputFileName: string;
    readonly state: "candidate" | "active";
    readonly directory: DirectoryDescriptor;
    readonly inputFile?: TaskInputFileEntry;
  }): SubtitleTranslationGeneratedTaskReference {
    if (this.generatedTasks.has(input.taskId)) {
      throw conflict("The generated subtitle task identity is already registered.");
    }
    const token = this.mintToken("target");
    const target = Object.freeze({
      directoryPath: input.directory.directoryPath,
      displayLabel: input.directory.displayLabel,
      identity: input.directory.identity,
      token,
      owner: Object.freeze({ ...input.owner }),
      taskId: input.taskId,
      outputFileName: input.outputFileName,
      expiresAt: addTtl(this.now(), this.targetTtlMs),
    });
    const record = Object.freeze({
      owner: target.owner,
      taskId: input.taskId,
      ...(input.handoffKey ? { handoffKey: input.handoffKey } : {}),
      ...(input.candidateBinding
        ? { candidateBinding: input.candidateBinding }
        : {}),
      sourceDisplayName: input.sourceDisplayName,
      outputFileName: input.outputFileName,
      state: input.state,
      ...(input.inputFile ? { inputFile: input.inputFile } : {}),
      artifactDirectory: Object.freeze({
        directoryPath: input.directory.directoryPath,
        displayLabel: input.directory.displayLabel,
        identity: input.directory.identity,
      }),
      target,
    });
    this.targets.set(token, target);
    this.generatedTasks.set(input.taskId, record);
    return referenceForGenerated(record);
  }

  private requireCandidateBinding(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
    candidateBinding: string,
  ): GeneratedTaskRecord {
    assertOwner(owner);
    assertTaskId(taskId);
    if (!subtitleTranslationOpaqueRefSchema.safeParse(candidateBinding).success) {
      throw invalid("candidateBinding");
    }
    const record = this.generatedTasks.get(taskId);
    if (
      !record ||
      !sameOwner(record.owner, owner) ||
      record.candidateBinding !== candidateBinding
    ) {
      throw invalid("candidateBinding");
    }
    return record;
  }

  private requireActiveTask(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): GeneratedTaskRecord {
    const record = this.generatedTasks.get(taskId);
    if (!record || !sameOwner(record.owner, owner)) throw invalid("taskId");
    if (record.state !== "active") {
      throw new SubtitleTranslationCapabilityError(
        "task_not_active",
        "The generated subtitle task is no longer active.",
        "taskId",
      );
    }
    if (!record.target) throw expired("target.token");
    if (record.target.expiresAt <= this.now()) {
      this.targets.delete(record.target.token);
      this.generatedTasks.set(taskId, Object.freeze({
        ...record,
        target: undefined,
      }));
      throw expired("target.token");
    }
    return record;
  }

  private requireReauthorizableTask(
    owner: SubtitleTranslationOwnerKey,
    taskId: string,
  ): GeneratedTaskRecord {
    const record = this.generatedTasks.get(taskId);
    if (!record || !sameOwner(record.owner, owner)) throw invalid("taskId");
    if (record.state !== "active") {
      throw new SubtitleTranslationCapabilityError(
        "task_not_active",
        "The generated subtitle task is no longer active.",
        "taskId",
      );
    }
    if (!record.target || record.target.expiresAt > this.now()) return record;
    this.targets.delete(record.target.token);
    const expiredRecord = Object.freeze({ ...record, target: undefined });
    this.generatedTasks.set(taskId, expiredRecord);
    return expiredRecord;
  }

  private async verifyDescriptor(
    descriptor: DirectoryDescriptor,
    field: string,
  ): Promise<void> {
    try {
      await this.beforeVerify?.();
      const current = await lstat(descriptor.directoryPath);
      const identity = await localSubtitleFilesystemObjectIdentityForPath(
        descriptor.directoryPath,
      );
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameLocalSubtitleFilesystemObjectIdentity(identity, descriptor.identity)
      ) {
        throw new Error();
      }
    } catch (error) {
      if (error instanceof SubtitleTranslationCapabilityError) throw error;
      throw new SubtitleTranslationCapabilityError(
        "output_write_failed",
        "The authorized subtitle output directory changed.",
        field,
      );
    }
  }

  private async verifyInputDescriptor(
    descriptor: InputFileDescriptor,
    field: string,
  ): Promise<void> {
    try {
      await this.beforeVerify?.();
      const current = await lstat(descriptor.filePath);
      const identity = await localSubtitleFilesystemObjectIdentityForPath(
        descriptor.filePath,
      );
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !sameLocalSubtitleFilesystemObjectIdentity(identity, descriptor.identity)
      ) {
        throw new Error();
      }
      await this.verifyDescriptor(descriptor.parent, field);
    } catch (error) {
      if (error instanceof SubtitleTranslationCapabilityError) throw error;
      throw new SubtitleTranslationCapabilityError(
        "invalid_content",
        "The authorized subtitle input file changed.",
        field,
      );
    }
  }

  private assertOwnerActive(owner: SubtitleTranslationOwnerKey): void {
    if (this.releasedOwners.has(ownerKey(owner))) {
      throw new SubtitleTranslationCapabilityError(
        "owner_released",
        "The subtitle translation owner session is unavailable.",
      );
    }
  }

  private mintToken(
    kind: "draft" | "input" | "source" | "lease" | "target" |
      "selection" | "selection-item",
  ): string {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const token = `subtitle-translation-${kind}-${this.tokenFactory()}`;
      if (
        subtitleTranslationOpaqueRefSchema.safeParse(token).success &&
        !this.drafts.has(token) &&
        !this.inputDrafts.has(token) &&
        !this.agentSelections.has(token) &&
        !this.importLeases.has(token) &&
        !this.targets.has(token) &&
        ![...this.generatedTasks.values()].some(
          (record) => record.inputFile?.token === token,
        ) &&
        ![...this.agentSelections.values()].some((selection) =>
          selection.items.some((item) => item.itemRef === token))
      ) {
        return token;
      }
    }
    throw invalid("token");
  }
}

export function resolveSafeSubtitleTranslationChildPath(
  directoryPath: string,
  outputFileName: string,
): string {
  return resolveSafeChild(directoryPath, outputFileName);
}

async function inspectDirectory(directoryPath: string): Promise<DirectoryDescriptor> {
  const absolute = absolutePath(directoryPath, "directoryPath");
  try {
    const before = await lstat(absolute);
    const beforeIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(absolute);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error();
    const canonical = await realpath(absolute);
    const after = await lstat(canonical);
    const afterIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(canonical);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameLocalSubtitleFilesystemObjectIdentity(beforeIdentity, afterIdentity)
    ) {
      throw new Error();
    }
    const basename = path.basename(canonical);
    const displayLabel = basename || "Filesystem root";
    if (!subtitleTranslationDisplayLabelSchema.safeParse(displayLabel).success) {
      throw new SubtitleTranslationCapabilityError(
        "invalid_content",
        "The selected subtitle output directory label is unsafe.",
        "directoryPath",
      );
    }
    return Object.freeze({
      directoryPath: canonical,
      displayLabel,
      identity: Object.freeze(afterIdentity),
    });
  } catch (error) {
    if (error instanceof SubtitleTranslationCapabilityError) throw error;
    throw new SubtitleTranslationCapabilityError(
      "output_write_failed",
      "The selected subtitle output directory is unavailable or unsafe.",
      "directoryPath",
    );
  }
}

async function inspectInputFile(filePath: string): Promise<InputFileDescriptor> {
  const absolute = absolutePath(filePath, "filePath");
  try {
    const before = await lstat(absolute);
    const beforeIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    const canonical = await realpath(absolute);
    const after = await lstat(canonical);
    const afterIdentity =
      await localSubtitleFilesystemObjectIdentityForPath(canonical);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameLocalSubtitleFilesystemObjectIdentity(beforeIdentity, afterIdentity)
    ) {
      throw new Error();
    }
    const displayName = safeOutputLeaf(path.basename(canonical), "filePath");
    const parent = await inspectDirectory(path.dirname(canonical));
    return Object.freeze({
      filePath: canonical,
      displayName,
      identity: Object.freeze(afterIdentity),
      parent,
    });
  } catch (error) {
    if (error instanceof SubtitleTranslationCapabilityError) throw error;
    throw new SubtitleTranslationCapabilityError(
      "invalid_content",
      "The selected subtitle input file is unavailable or unsafe.",
      "filePath",
    );
  }
}

function validatePrivateDirectoryAuthority(
  value: SubtitleTranslationPrivateDirectoryAuthority,
): DirectoryDescriptor {
  if (
    !value ||
    typeof value !== "object" ||
    !subtitleTranslationDisplayLabelSchema.safeParse(value.displayLabel).success ||
    !value.identity ||
    typeof value.identity !== "object"
  ) {
    throw invalid("sourceDirectory");
  }
  return Object.freeze({
    directoryPath: absolutePath(value.directoryPath, "sourceDirectory"),
    displayLabel: value.displayLabel,
    identity: Object.freeze({ ...value.identity }),
  });
}

function referenceForGenerated(
  record: GeneratedTaskRecord & { readonly target: TaskTargetEntry },
): SubtitleTranslationGeneratedTaskReference {
  return Object.freeze({
    kind: "generated_task_v1",
    source: Object.freeze({
      kind: "generated_content",
      displayName: record.sourceDisplayName,
    }),
    target: Object.freeze({
      kind: "authorized_directory",
      token: record.target.token,
      displayLabel: record.target.displayLabel,
    }),
  });
}

function referenceForAuthorized(
  record: GeneratedTaskRecord & {
    readonly inputFile: TaskInputFileEntry;
    readonly target: TaskTargetEntry;
  },
): SubtitleTranslationAuthorizedTaskReference {
  return Object.freeze({
    kind: "authorized_task_v1",
    source: Object.freeze({
      kind: "authorized_file",
      token: record.inputFile.token,
      displayName: record.inputFile.displayName,
    }),
    target: targetReferenceFor(record),
  });
}

function targetReferenceFor(
  record: GeneratedTaskRecord & { readonly target: TaskTargetEntry },
): SubtitleTranslationGeneratedTaskReference["target"] {
  return Object.freeze({
    kind: "authorized_directory",
    token: record.target.token,
    displayLabel: record.target.displayLabel,
  });
}

function safeOutputLeaf(value: string, field: string): string {
  const parsed = subtitleTranslationOutputLeafSchema.safeParse(value);
  if (!parsed.success) {
    throw new SubtitleTranslationCapabilityError(
      "invalid_content",
      "The subtitle output file name is unsafe.",
      field,
    );
  }
  return parsed.data;
}

function resolveSafeChild(root: string, leaf: string): string {
  const safeLeaf = safeOutputLeaf(leaf, "outputFileName");
  const parent = absolutePath(root, "targetDirectoryPath");
  const child = path.resolve(parent, safeLeaf);
  const relative = path.relative(parent, child);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new SubtitleTranslationCapabilityError(
      "output_write_failed",
      "The subtitle output escaped its authorized directory.",
      "outputFileName",
    );
  }
  return child;
}

function absolutePath(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw invalid(field);
  }
  return path.resolve(value);
}

function assertTaskId(taskId: string): void {
  if (!subtitleTranslationTaskIdSchema.safeParse(taskId).success) {
    throw invalid("taskId");
  }
}

function assertOwner(owner: SubtitleTranslationOwnerKey): void {
  if (
    !owner ||
    !Number.isSafeInteger(owner.webContentsId) ||
    owner.webContentsId <= 0 ||
    typeof owner.ownerSessionId !== "string" ||
    owner.ownerSessionId.length === 0
  ) {
    throw invalid("owner");
  }
}

function sameOwner(
  left: SubtitleTranslationOwnerKey,
  right: SubtitleTranslationOwnerKey,
): boolean {
  return left.webContentsId === right.webContentsId &&
    left.ownerSessionId === right.ownerSessionId;
}

function ownerKey(owner: SubtitleTranslationOwnerKey): string {
  return `${owner.webContentsId}:${owner.ownerSessionId}`;
}

function validTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Invalid TTL.");
  return value;
}

function addTtl(now: number, ttl: number): number {
  const result = now + ttl;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError("Invalid TTL.");
  return result;
}

function invalid(field: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "invalid_ipc_request",
    "The subtitle translation capability request is invalid.",
    field,
  );
}

function expired(field: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "authorization_expired",
    "The subtitle translation directory authorization expired.",
    field,
  );
}

function conflict(message: string): SubtitleTranslationCapabilityError {
  return new SubtitleTranslationCapabilityError(
    "task_reference_conflict",
    message,
    "taskId",
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
