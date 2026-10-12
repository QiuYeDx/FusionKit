import { AGENT_SESSIONS_CHANNELS, AGENT_SESSIONS_CHANNEL_PREFIX, type AgentSessionsApi } from '../../src/agent/session-store-contract';

export function assertLegacyAgentSessionsChannelAllowed(channel: string): void {
  if (channel.startsWith(AGENT_SESSIONS_CHANNEL_PREFIX)) throw new Error('Agent session IPC is restricted. Use agentSessions instead.');
}

export function createAgentSessionsApi(ipc: { invoke(channel: string, payload?: unknown): Promise<any> }): AgentSessionsApi {
  return Object.freeze({
    list: () => ipc.invoke(AGENT_SESSIONS_CHANNELS.list),
    load: id => ipc.invoke(AGENT_SESSIONS_CHANNELS.load, id),
    save: request => ipc.invoke(AGENT_SESSIONS_CHANNELS.save, request),
    remove: id => ipc.invoke(AGENT_SESSIONS_CHANNELS.remove, id),
    clear: () => ipc.invoke(AGENT_SESSIONS_CHANNELS.clear),
  } satisfies AgentSessionsApi);
}
