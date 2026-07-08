import type { ModelProfile } from "@/type/model";
import type { SubtitleTranslatorTask } from "@/type/subtitle";

type SubtitleTaskModelFields = Pick<
  SubtitleTranslatorTask,
  "apiKey" | "apiModel" | "endPoint" | "apiFormat" | "outputTokenParameter"
>;

type TaskModelProfile = Pick<
  ModelProfile,
  "apiKey" | "modelKey" | "baseUrl" | "apiFormat" | "outputTokenParameter"
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
  };
}
