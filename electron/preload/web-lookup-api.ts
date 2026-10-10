import { WEB_LOOKUP_CHANNELS, WEB_LOOKUP_CHANNEL_PREFIX, type WebLookupApi } from '../../src/web-lookup/contract';

export function assertLegacyWebLookupChannelAllowed(channel: string): void {
  if (channel.startsWith(WEB_LOOKUP_CHANNEL_PREFIX)) throw new Error('Web lookup IPC is restricted. Use webLookup instead.');
}

export function createWebLookupApi(ipc: { invoke(channel: string, payload?: unknown): Promise<any> }): WebLookupApi {
  return Object.freeze({
    search: request => ipc.invoke(WEB_LOOKUP_CHANNELS.search, request),
    read: request => ipc.invoke(WEB_LOOKUP_CHANNELS.read, request),
  } satisfies WebLookupApi);
}
