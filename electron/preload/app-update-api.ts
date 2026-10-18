import { APP_UPDATE_CHANNELS, APP_UPDATE_CHANNEL_PREFIX, type AppUpdateApi, type AppUpdateState } from '../../src/app-update/contract';

export function assertLegacyAppUpdateChannelAllowed(channel: string): void {
  if (channel.startsWith(APP_UPDATE_CHANNEL_PREFIX)) throw new Error('Update IPC is restricted. Use appUpdate instead.');
}

type Ipc = {
  invoke(channel: string, payload?: unknown): Promise<any>;
  on(channel: string, listener: (event: unknown, payload: any) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: any) => void): unknown;
};

export function createAppUpdateApi(ipc: Ipc): AppUpdateApi {
  return Object.freeze({
    getState: () => ipc.invoke(APP_UPDATE_CHANNELS.getState),
    check: request => ipc.invoke(APP_UPDATE_CHANNELS.check, { manual: request?.manual === true }),
    download: () => ipc.invoke(APP_UPDATE_CHANNELS.download),
    cancelDownload: () => ipc.invoke(APP_UPDATE_CHANNELS.cancel),
    install: () => ipc.invoke(APP_UPDATE_CHANNELS.install),
    restart: () => ipc.invoke(APP_UPDATE_CHANNELS.restart),
    onState: listener => {
      const wrapped = (_event: unknown, state: AppUpdateState) => listener(state);
      ipc.on(APP_UPDATE_CHANNELS.state, wrapped);
      return () => { ipc.removeListener(APP_UPDATE_CHANNELS.state, wrapped); };
    },
  } satisfies AppUpdateApi);
}
