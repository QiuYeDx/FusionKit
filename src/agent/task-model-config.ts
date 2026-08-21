import type { ModelProfile } from "@/type/model";
import type {
  SubtitleTaskReadyExecutionBinding,
} from "@/type/subtitle";
import { inferMaxOutputTokens } from "@/constants/model";

export type SubtitleTaskModelFields = Pick<
  SubtitleTaskReadyExecutionBinding,
  | "apiKey"
  | "apiModel"
  | "endPoint"
  | "apiFormat"
  | "outputTokenParameter"
  | "maxOutputTokens"
  | "thinkingEnabled"
>;

type TaskModelProfile = Pick<
  ModelProfile,
  "apiKey" | "modelKey" | "baseUrl" | "apiFormat" | "outputTokenParameter" | "maxOutputTokens"
>;

type SubtitleTaskModelOptions = Readonly<{
  thinkingEnabled?: boolean;
}>;

export function createSubtitleTaskModelFields(
  profile: TaskModelProfile,
  options: SubtitleTaskModelOptions = {},
): SubtitleTaskModelFields {
  const supportsDeepSeekThinking =
    profile.apiFormat === "chat_completions" &&
    profile.modelKey.trim().toLowerCase().startsWith("deepseek-");
  return {
    apiKey: profile.apiKey,
    apiModel: profile.modelKey,
    endPoint: profile.baseUrl,
    apiFormat: profile.apiFormat,
    outputTokenParameter: profile.outputTokenParameter,
    maxOutputTokens: profile.maxOutputTokens ?? inferMaxOutputTokens(profile.modelKey),
    ...(supportsDeepSeekThinking
      ? { thinkingEnabled: options.thinkingEnabled === true }
      : {}),
  };
}

export function createSubtitleTaskExecutionBinding(
  profile: TaskModelProfile & Pick<ModelProfile, "id" | "name">,
  options: SubtitleTaskModelOptions = {},
): SubtitleTaskReadyExecutionBinding {
  return Object.freeze({
    status: "ready",
    profileId: profile.id,
    profileLabel: profile.name,
    ...createSubtitleTaskModelFields(profile, options),
  });
}
