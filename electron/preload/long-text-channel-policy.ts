import { LONG_TEXT_CHANNEL_PREFIX } from '../../src/long-text/channels';

export function assertLegacyLongTextChannelAllowed(channel: string): void {
  if (channel.startsWith(LONG_TEXT_CHANNEL_PREFIX)) throw new Error('Long text IPC is restricted. Use longText instead.');
}
