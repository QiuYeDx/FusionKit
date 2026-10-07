import {
  NAME_TRANSLATION_CHANNELS,
  NAME_TRANSLATION_CHANNEL_PREFIX,
  type NameTranslationRendererApi,
} from '../../src/name-translation/contract';

export function assertLegacyNameTranslationChannelAllowed(channel: string): void {
  if (channel.startsWith(NAME_TRANSLATION_CHANNEL_PREFIX)) {
    throw new Error('Name translation IPC is restricted. Use nameTranslation instead.');
  }
}

export function createNameTranslationApi(ipc: {
  invoke(channel: string, payload?: unknown): Promise<any>;
}): NameTranslationRendererApi {
  const C = NAME_TRANSLATION_CHANNELS;
  return Object.freeze({
    selectPaths: request => ipc.invoke(C.selectPaths, request),
    inspectPaths: request => ipc.invoke(C.inspectPaths, request),
    listDirectory: request => ipc.invoke(C.listDirectory, request),
    collectDescendants: request => ipc.invoke(C.collectDescendants, request),
    translate: request => ipc.invoke(C.translate, request),
    cancelTranslate: request => ipc.invoke(C.cancelTranslate, request),
    preflight: request => ipc.invoke(C.preflight, request),
    apply: request => ipc.invoke(C.apply, request),
    undo: request => ipc.invoke(C.undo, request),
    listJournals: () => ipc.invoke(C.listJournals, {}),
    dismissJournal: request => ipc.invoke(C.dismissJournal, request),
  } satisfies NameTranslationRendererApi);
}
