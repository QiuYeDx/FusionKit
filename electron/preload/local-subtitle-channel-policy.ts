import {
  LOCAL_SUBTITLE_EVENT_CHANNELS,
  LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS,
  type LocalSubtitleEventChannel,
  type LocalSubtitlePublicInvokeChannel,
} from "@/type/localSubtitleIpc";

export const LOCAL_SUBTITLE_CHANNEL_PREFIX = "local-subtitle:";

const PUBLIC_LOCAL_SUBTITLE_IPC_CHANNELS = new Set<string>(
  Object.values(LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS),
);

const LOCAL_SUBTITLE_EVENT_CHANNEL_SET = new Set<string>(
  Object.values(LOCAL_SUBTITLE_EVENT_CHANNELS),
);

export function isPublicLocalSubtitleIpcChannel(
  channel: string,
): channel is LocalSubtitlePublicInvokeChannel {
  return PUBLIC_LOCAL_SUBTITLE_IPC_CHANNELS.has(channel);
}

export function isLocalSubtitleEventChannel(
  channel: string,
): channel is LocalSubtitleEventChannel {
  return LOCAL_SUBTITLE_EVENT_CHANNEL_SET.has(channel);
}

export function isProtectedLocalSubtitleChannel(channel: string): boolean {
  return channel.startsWith(LOCAL_SUBTITLE_CHANNEL_PREFIX);
}

export function assertLegacyLocalSubtitleChannelAllowed(channel: string): void {
  if (isProtectedLocalSubtitleChannel(channel)) {
    throw new Error(
      "Local subtitle IPC is restricted. Use the fixed localSubtitleApi methods instead.",
    );
  }
}
