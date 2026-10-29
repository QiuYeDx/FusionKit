import { MEDIA_CONVERTER_CHANNEL_PREFIX } from '../../src/media-converter/channels';

/** The legacy `window.ipcRenderer` bridge never reaches the media converter: its channels go through `window.mediaConverter` only (AC-ENGINE-07-1). */
export function assertLegacyMediaConverterChannelAllowed(channel: string): void {
  if (channel.startsWith(MEDIA_CONVERTER_CHANNEL_PREFIX)) throw new Error('Media converter IPC is restricted. Use mediaConverter instead.');
}
