import { SYSTEM_SETUP_CHANNELS, SYSTEM_SETUP_CHANNEL_PREFIX, type SystemSetupApi } from '../../src/system-setup/contract';

export function assertLegacySystemSetupChannelAllowed(channel: string): void {
  if (channel.startsWith(SYSTEM_SETUP_CHANNEL_PREFIX)) throw new Error('System setup IPC is restricted. Use systemSetup instead.');
}

export function createSystemSetupApi(ipc: { invoke(channel: string, payload?: unknown): Promise<any> }): SystemSetupApi {
  return Object.freeze({
    getVcRuntimeStatus: () => ipc.invoke(SYSTEM_SETUP_CHANNELS.vcRuntimeStatus),
    repairVcRuntime: () => ipc.invoke(SYSTEM_SETUP_CHANNELS.repairVcRuntime),
    detectGpu: options => ipc.invoke(SYSTEM_SETUP_CHANNELS.gpu, { refresh: options?.refresh === true }),
  } satisfies SystemSetupApi);
}
