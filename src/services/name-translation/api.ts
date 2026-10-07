import type {
  NameTranslationErrorCode,
  NameTranslationIpcResult,
  NameTranslationRendererApi,
  NameTranslationRuntimeModel,
} from "@/name-translation/contract";
import type { ModelProfile } from "@/type/model";

export class NameTranslationApiError extends Error {
  constructor(
    readonly code: NameTranslationErrorCode | "bridge_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "NameTranslationApiError";
  }
}

export function getNameTranslationApi(): NameTranslationRendererApi {
  const api = typeof window === "undefined" ? undefined : window.nameTranslation;
  if (!api) {
    throw new NameTranslationApiError(
      "bridge_unavailable",
      "Name translation is only available in the desktop app.",
    );
  }
  return api;
}

export async function unwrap<T>(
  pending: Promise<NameTranslationIpcResult<T>>,
): Promise<T> {
  const result = await pending;
  if (!result || typeof result !== "object") {
    throw new NameTranslationApiError("internal", "Invalid response.");
  }
  if (!result.ok) throw new NameTranslationApiError(result.error.code, result.error.message);
  return result.data;
}

export function toRuntimeModel(
  profile: ModelProfile | null | undefined,
): NameTranslationRuntimeModel | null {
  if (!profile?.apiKey || !profile.modelKey || !profile.baseUrl) return null;
  return {
    profileId: profile.id,
    apiKey: profile.apiKey,
    modelKey: profile.modelKey,
    endpoint: profile.baseUrl,
    apiFormat: profile.apiFormat,
    ...(profile.outputTokenParameter
      ? { outputTokenParameter: profile.outputTokenParameter }
      : {}),
  };
}

/** Best-effort platform for live renderer checks; main stays authoritative. */
export function rendererPlatform(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(agent)) return "win32";
  if (/Mac OS X|Macintosh/i.test(agent)) return "darwin";
  return "linux";
}
