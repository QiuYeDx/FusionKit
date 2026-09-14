import { KNOWLEDGE_CHANNELS, type TranslationKnowledgeApi } from '../../src/translation-knowledge/ipc-contract';

const publicChannels = new Set<string>(Object.entries(KNOWLEDGE_CHANNELS).filter(([key]) => key !== 'register').map(([, value]) => value));
export const isPublicKnowledgeChannel = (channel: string) => publicChannels.has(channel);
export function assertLegacyKnowledgeChannelAllowed(channel: string) {
  if (channel.startsWith('translation-knowledge:')) throw new Error('Use the translationKnowledge API.');
}

export function createTranslationKnowledgeApi(ipc: {
  sendSync(channel: string, request: unknown): unknown;
  invoke(channel: string, request: unknown): Promise<any>;
}, files?: { getPathForFile(file: File): string }): TranslationKnowledgeApi {
  const capability = ipc.sendSync(KNOWLEDGE_CHANNELS.register, {});
  const invoke = (channel: string, payload: unknown) => typeof capability === 'string' && isPublicKnowledgeChannel(channel)
    ? ipc.invoke(channel, { capability, payload })
    : Promise.resolve({ ok: false, error: 'access_denied' } as const);
  return Object.freeze({
    read: () => invoke(KNOWLEDGE_CHANNELS.read, {}),
    selectImport: () => invoke(KNOWLEDGE_CHANNELS.selectImport, {}),
    importDroppedFile: async file => {
      try {
        if (!files || !file || typeof file !== 'object') return { ok: false, error: 'invalid_input' };
        const path = files.getPathForFile(file);
        if (!path) return { ok: false, error: 'invalid_input' };
        return invoke(KNOWLEDGE_CHANNELS.importDroppedFile, { path });
      } catch { return { ok: false, error: 'invalid_input' }; }
    },
    commitImport: request => invoke(KNOWLEDGE_CHANNELS.commitImport, request),
    saveRecord: request => invoke(KNOWLEDGE_CHANNELS.saveRecord, request),
    reviewEntries: request => invoke(KNOWLEDGE_CHANNELS.reviewEntries, request),
    planMaintenance: request => invoke(KNOWLEDGE_CHANNELS.planMaintenance, request),
    commitMaintenance: request => invoke(KNOWLEDGE_CHANNELS.commitMaintenance, request),
    planExport: request => invoke(KNOWLEDGE_CHANNELS.planExport, request),
    exportFile: request => invoke(KNOWLEDGE_CHANNELS.exportFile, request),
  } satisfies TranslationKnowledgeApi);
}
