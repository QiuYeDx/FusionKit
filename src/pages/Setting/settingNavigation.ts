export const SETTING_TAB_KEYS = [
  "general",
  "proxy",
  "model",
  "audio",
] as const;

export type SettingTabKey = (typeof SETTING_TAB_KEYS)[number];

export const AUDIO_TOOL_RETURN_PATHS = [
  "/tools/audio/transcriber",
  "/tools/audio/speech-synthesis",
  "/tools/audio/realtime-captions",
  "/tools/audio/realtime-voice",
] as const;

export type AudioToolReturnPath = (typeof AUDIO_TOOL_RETURN_PATHS)[number];

const SETTING_TAB_SET = new Set<string>(SETTING_TAB_KEYS);
const AUDIO_TOOL_RETURN_PATH_SET = new Set<string>(AUDIO_TOOL_RETURN_PATHS);

export function resolveSettingTab(value: string | null): SettingTabKey {
  return value && SETTING_TAB_SET.has(value)
    ? value as SettingTabKey
    : "general";
}

export function resolveAudioSettingsReturnTo(
  value: string | null,
): AudioToolReturnPath | null {
  return value && AUDIO_TOOL_RETURN_PATH_SET.has(value)
    ? value as AudioToolReturnPath
    : null;
}

export function createSettingSearchParams(
  current: URLSearchParams,
  tab: SettingTabKey,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set("tab", tab);
  if (
    next.has("returnTo") &&
    !resolveAudioSettingsReturnTo(next.get("returnTo"))
  ) {
    next.delete("returnTo");
  }
  return next;
}
