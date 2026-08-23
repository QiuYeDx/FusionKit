export const NATIVE_FILE_SELECTION_CHANNEL_PREFIX = "native-file-selection:";

export function assertLegacyNativeFileSelectionChannelAllowed(
  channel: string,
): void {
  if (channel.startsWith(NATIVE_FILE_SELECTION_CHANNEL_PREFIX)) {
    throw new Error(
      "Native file selection IPC is restricted. Use the fixed electronUtils methods instead.",
    );
  }
}
