import type {
  SubtitleTaskExecutionBinding,
  SubtitleTranslatorTask,
} from "@/type/subtitle";

const TASK_ID_PREFIX = "subtitle-task-";

export type SubtitleTranslatorTaskDraft = Omit<
  SubtitleTranslatorTask,
  "taskId"
>;

export function createSubtitleTranslatorTask(
  draft: SubtitleTranslatorTaskDraft,
  idFactory: () => string = defaultIdFactory,
): SubtitleTranslatorTask {
  if (
    draft.executionBinding.status !== "needs_configuration" &&
    !hasReadySubtitleTaskExecution(draft)
  ) {
    throw new TypeError("Subtitle translator execution binding is invalid.");
  }
  return {
    ...draft,
    taskId: createSubtitleTranslatorTaskId(idFactory),
  };
}

export function createSubtitleTranslatorTaskId(
  idFactory: () => string = defaultIdFactory,
): string {
  const taskId = `${TASK_ID_PREFIX}${idFactory()}`;
  if (!isSubtitleTranslatorTaskId(taskId)) {
    throw new TypeError("Subtitle translator task ID source is invalid.");
  }
  return taskId;
}

export function isSubtitleTranslatorTaskId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > TASK_ID_PREFIX.length &&
    value.length <= 160 &&
    /^subtitle-task-[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value);
}

export function hasReadySubtitleTaskExecution(
  task: Pick<SubtitleTranslatorTask, "executionBinding">,
): task is Pick<SubtitleTranslatorTask, "executionBinding"> & {
  executionBinding: Extract<
    SubtitleTaskExecutionBinding,
    { status: "ready" }
  >;
} {
  const binding = task.executionBinding;
  return binding.status === "ready" &&
    nonBlank(binding.profileId) &&
    nonBlank(binding.profileLabel) &&
    nonBlank(binding.apiKey) &&
    nonBlank(binding.apiModel) &&
    nonBlank(binding.endPoint) &&
    (binding.apiFormat === undefined ||
      binding.apiFormat === "chat_completions" ||
      binding.apiFormat === "responses") &&
    (binding.outputTokenParameter === undefined ||
      binding.outputTokenParameter === "max_tokens" ||
      binding.outputTokenParameter === "max_completion_tokens") &&
    (binding.maxOutputTokens === undefined ||
      (Number.isSafeInteger(binding.maxOutputTokens) &&
        binding.maxOutputTokens > 0));
}

function defaultIdFactory(): string {
  return globalThis.crypto.randomUUID();
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
