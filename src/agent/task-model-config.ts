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
>;

type TaskModelProfile = Pick<
  ModelProfile,
  "apiKey" | "modelKey" | "baseUrl" | "apiFormat" | "outputTokenParameter" | "maxOutputTokens"
>;

export function createSubtitleTaskModelFields(
  profile: TaskModelProfile,
): SubtitleTaskModelFields {
  return {
    apiKey: profile.apiKey,
    apiModel: profile.modelKey,
    endPoint: profile.baseUrl,
    apiFormat: profile.apiFormat,
    outputTokenParameter: profile.outputTokenParameter,
    maxOutputTokens: profile.maxOutputTokens ?? inferMaxOutputTokens(profile.modelKey),
  };
}

export function createSubtitleTaskExecutionBinding(
  profile: TaskModelProfile & Pick<ModelProfile, "id" | "name">,
): SubtitleTaskReadyExecutionBinding {
  return Object.freeze({
    status: "ready",
    profileId: profile.id,
    profileLabel: profile.name,
    ...createSubtitleTaskModelFields(profile),
  });
}
