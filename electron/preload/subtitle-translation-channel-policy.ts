export const SUBTITLE_TRANSLATION_CHANNEL_PREFIX = "subtitle-translation:";

export function isProtectedSubtitleTranslationChannel(
  channel: string,
): boolean {
  return channel.startsWith(SUBTITLE_TRANSLATION_CHANNEL_PREFIX);
}

export function assertLegacySubtitleTranslationChannelAllowed(
  channel: string,
): void {
  if (isProtectedSubtitleTranslationChannel(channel)) {
    throw new Error(
      "Subtitle translation IPC is restricted. Use the fixed subtitleTranslationApi methods instead.",
    );
  }
}
