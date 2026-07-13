import {
  AUDIO_IPC_CHANNELS,
  type AudioIpcChannel,
} from "@/type/audioIpc";

const PUBLIC_AUDIO_IPC_CHANNELS = new Set<string>(
  Object.values(AUDIO_IPC_CHANNELS),
);

export function isPublicAudioIpcChannel(
  channel: string,
): channel is AudioIpcChannel {
  return PUBLIC_AUDIO_IPC_CHANNELS.has(channel);
}
