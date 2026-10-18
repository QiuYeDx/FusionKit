import { NETWORK_CHANNELS, NETWORK_CHANNEL_PREFIX, type NetworkApi } from '../../src/network/contract';

export function assertLegacyNetworkChannelAllowed(channel: string): void {
  if (channel.startsWith(NETWORK_CHANNEL_PREFIX)) throw new Error('Network IPC is restricted. Use network instead.');
}

export function createNetworkApi(ipc: { invoke(channel: string, payload?: unknown): Promise<any> }): NetworkApi {
  return Object.freeze({
    getSettings: () => ipc.invoke(NETWORK_CHANNELS.getSettings),
    setSettings: patch => ipc.invoke(NETWORK_CHANNELS.setSettings, patch),
    test: request => ipc.invoke(NETWORK_CHANNELS.test, request),
  } satisfies NetworkApi);
}
