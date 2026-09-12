import { SPEECH_RESOURCES_CHANGED, SPEECH_RESOURCES_STATUS, type SpeechResourcesNotifications } from '../../src/speech-resources/events';

export function assertLegacySpeechResourcesChannelAllowed(channel: string): void {
  if (channel.startsWith('speech-resources:')) throw new Error('Speech resource IPC is restricted. Use speechResources instead.');
}

export function createSpeechResourcesApi(ipc: {
  invoke(channel: string, payload: unknown): Promise<any>;
  on(channel: string, listener: (event: unknown, input: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, input: unknown) => void): unknown;
}): SpeechResourcesNotifications {
  return Object.freeze({
    getStatus: () => ipc.invoke(SPEECH_RESOURCES_STATUS, {}),
    onChanged: (listener: Parameters<SpeechResourcesNotifications['onChanged']>[0]) => {
      let active = true;
      const receive = (_event: unknown, input: unknown) => {
        if (!active || !input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'revision')) return;
        const revision = (input as { revision: unknown }).revision;
        if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) listener(Object.freeze({ revision }));
      };
      ipc.on(SPEECH_RESOURCES_CHANGED, receive);
      return () => { if (active) { active = false; ipc.removeListener(SPEECH_RESOURCES_CHANGED, receive); } };
    },
  });
}
