import { EXTERNAL_AGENT_CHANNELS, EXTERNAL_AGENT_CHANNEL_PREFIX, type ExternalAgentApi } from '../../src/agent/external/contract';

export function assertLegacyExternalAgentChannelAllowed(channel: string): void {
  if (channel.startsWith(EXTERNAL_AGENT_CHANNEL_PREFIX)) throw new Error('External agent IPC is restricted. Use externalAgent instead.');
}

type Ipc = {
  invoke(channel: string, payload?: unknown): Promise<any>;
  send(channel: string, payload?: unknown): void;
  on(channel: string, listener: (event: unknown, payload: any) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: any) => void): unknown;
};

export function createExternalAgentApi(ipc: Ipc): ExternalAgentApi {
  const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
    const wrapped = (_event: unknown, payload: T) => listener(payload);
    ipc.on(channel, wrapped);
    return () => { ipc.removeListener(channel, wrapped); };
  };
  return Object.freeze({
    getSettings: () => ipc.invoke(EXTERNAL_AGENT_CHANNELS.getSettings),
    updateSettings: update => ipc.invoke(EXTERNAL_AGENT_CHANNELS.updateSettings, update),
    regenerateToken: () => ipc.invoke(EXTERNAL_AGENT_CHANNELS.regenerateToken),
    getStatus: () => ipc.invoke(EXTERNAL_AGENT_CHANNELS.getStatus),
    closeSession: sessionId => ipc.invoke(EXTERNAL_AGENT_CHANNELS.closeSession, sessionId),
    connectionInfo: () => ipc.invoke(EXTERNAL_AGENT_CHANNELS.connectionInfo),
    installSkill: target => ipc.invoke(EXTERNAL_AGENT_CHANNELS.installSkill, target),
    skillStatus: () => ipc.invoke(EXTERNAL_AGENT_CHANNELS.skillStatus),
    onStatus: listener => subscribe(EXTERNAL_AGENT_CHANNELS.status, listener),
    onCall: listener => subscribe(EXTERNAL_AGENT_CHANNELS.call, listener),
    onCancel: listener => subscribe(EXTERNAL_AGENT_CHANNELS.cancel, listener),
    ready: () => ipc.send(EXTERNAL_AGENT_CHANNELS.ready),
    requestAttention: () => ipc.send(EXTERNAL_AGENT_CHANNELS.requestAttention),
    respond: async response => { await ipc.invoke(EXTERNAL_AGENT_CHANNELS.respond, response); },
  } satisfies ExternalAgentApi);
}
