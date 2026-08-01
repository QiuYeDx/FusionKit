import type { ModelProfile } from "@/type/model";
import type { SubtitleTranslatorTask } from "@/type/subtitle";
import { inferMaxOutputTokens } from "@/constants/model";

type SubtitleTaskModelFields = Pick<
  SubtitleTranslatorTask,
  "apiKey" | "apiModel" | "endPoint" | "apiFormat" | "outputTokenParameter" | "maxOutputTokens"
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
