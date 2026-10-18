import { MODEL_SETUP_CHANNELS, MODEL_SETUP_CHANNEL_PREFIX, type ModelSetupApi } from '../../src/model-setup/contract';

export function assertLegacyModelSetupChannelAllowed(channel: string): void {
  if (channel.startsWith(MODEL_SETUP_CHANNEL_PREFIX)) throw new Error('Model setup IPC is restricted. Use modelSetup instead.');
}

export function createModelSetupApi(ipc: { invoke(channel: string, payload?: unknown): Promise<any> }): ModelSetupApi {
  return Object.freeze({
    testConnection: request => ipc.invoke(MODEL_SETUP_CHANNELS.testConnection, request),
    getLaunchConfig: () => ipc.invoke(MODEL_SETUP_CHANNELS.launchConfig),
    getFreeDiskSpace: () => ipc.invoke(MODEL_SETUP_CHANNELS.freeDiskSpace),
  } satisfies ModelSetupApi);
}
