/**
 * Settings of tools that no longer exist. Nothing reads them any more, and the
 * audio settings could hold an API key, so they are removed at startup.
 */
export const REMOVED_TOOL_STORAGE_KEYS = [
  // Audio to text, text to audio, realtime captions and duplex voice, removed in 0.5.0.
  "fusionkit-audio-settings",
  "fusionkit-audio-transcriber",
  "fusionkit-speech-synthesizer",
  "fusionkit-realtime-captions",
  "fusionkit-realtime-voice",
] as const;

type KeyRemover = Pick<Storage, "removeItem">;

/** Removes the removed tools' settings; never throws, so startup is unaffected. */
export function removeRemovedToolSettings(
  storage: KeyRemover | undefined = globalThis.localStorage,
): void {
  if (!storage) return;
  for (const key of REMOVED_TOOL_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage access can be disabled by browser policy.
    }
  }
}
