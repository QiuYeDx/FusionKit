import type { IpcRenderer } from "electron";

type ElectronIpcListener = Parameters<IpcRenderer["on"]>[1];
export type SafeLegacyIpcListener = (
  event: undefined,
  ...args: any[]
) => void;

export interface SafeLegacyIpcBridge {
  on(channel: string, listener: SafeLegacyIpcListener): void;
  off(channel: string, listener: SafeLegacyIpcListener): void;
  send(...args: Parameters<IpcRenderer["send"]>): void;
  invoke(
    ...args: Parameters<IpcRenderer["invoke"]>
  ): ReturnType<IpcRenderer["invoke"]>;
}

export interface CreateSafeLegacyIpcBridgeOptions {
  readonly ipcRenderer: Pick<IpcRenderer, "on" | "off" | "send" | "invoke">;
  readonly assertListenChannelAllowed: (channel: string) => void;
  readonly assertCommandChannelAllowed: (channel: string) => void;
}

export function createSafeLegacyIpcBridge({
  ipcRenderer,
  assertListenChannelAllowed,
  assertCommandChannelAllowed,
}: CreateSafeLegacyIpcBridgeOptions): SafeLegacyIpcBridge {
  const listeners = new Map<
    string,
    Map<SafeLegacyIpcListener, ElectronIpcListener>
  >();

  const bridge: SafeLegacyIpcBridge = {
    on(channel, listener) {
      assertListenChannelAllowed(channel);
      const channelListeners = listeners.get(channel) ?? new Map();
      if (channelListeners.has(listener)) return;

      const wrapped: ElectronIpcListener = (_event, ...args) => {
        listener(undefined, ...args);
      };
      channelListeners.set(listener, wrapped);
      listeners.set(channel, channelListeners);
      ipcRenderer.on(channel, wrapped);
    },
    off(channel, listener) {
      assertListenChannelAllowed(channel);
      const channelListeners = listeners.get(channel);
      const wrapped = channelListeners?.get(listener);
      if (!wrapped) return;

      ipcRenderer.off(channel, wrapped);
      channelListeners?.delete(listener);
      if (channelListeners?.size === 0) listeners.delete(channel);
    },
    send(...args) {
      assertCommandChannelAllowed(args[0]);
      ipcRenderer.send(...args);
    },
    async invoke(...args) {
      assertCommandChannelAllowed(args[0]);
      return ipcRenderer.invoke(...args);
    },
  };
  return Object.freeze(bridge);
}
