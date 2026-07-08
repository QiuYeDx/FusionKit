import type { ModelApiFormat, ModelProfile } from "@/type/model";

export function isAgentApiFormatSupported(
  apiFormat: ModelApiFormat | undefined,
): boolean {
  const normalized = apiFormat ?? "chat_completions";
  return normalized === "chat_completions" || normalized === "responses";
}

export function isAgentProfileApiFormatSupported(
  profile: Pick<ModelProfile, "apiFormat"> | null | undefined,
): boolean {
  return isAgentApiFormatSupported(profile?.apiFormat);
}
