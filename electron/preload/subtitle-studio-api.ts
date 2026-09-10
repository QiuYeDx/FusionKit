import { STUDIO_CHANNELS, studioEventSchema, type SubtitleStudioApi } from '../../src/subtitle-studio/ipc-contract';
import { isPublicStudioChannel } from './subtitle-studio-channel-policy';

export function createSubtitleStudioApi(ipc: { sendSync(channel: string, payload: unknown): unknown; invoke(channel: string, payload: unknown): Promise<any>; on(channel: string, listener: (event: unknown, input: any) => void): unknown; removeListener(channel: string, listener: (event: unknown, input: any) => void): unknown }): SubtitleStudioApi {
  const capability = ipc.sendSync(STUDIO_CHANNELS.register, {});
  const invoke = (channel: string, payload: unknown) => {
    if (typeof capability !== 'string' || !isPublicStudioChannel(channel)) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
    return ipc.invoke(channel, { capability, payload });
  };
  return Object.freeze({
    importSubtitle: request => invoke(STUDIO_CHANNELS.importSubtitle, request),
    listDocuments: request => invoke(STUDIO_CHANNELS.listDocuments, request),
    readDocumentPage: request => invoke(STUDIO_CHANNELS.readDocumentPage, request),
    exportSource: request => invoke(STUDIO_CHANNELS.exportSource, request),
    planExport: request => invoke(STUDIO_CHANNELS.planExport, request),
    exportDocument: request => invoke(STUDIO_CHANNELS.exportDocument, request),
    deleteDocument: request => invoke(STUDIO_CHANNELS.deleteDocument, request),
    removeTask: request => invoke(STUDIO_CHANNELS.removeTask, request),
    planTranslation: request => invoke(STUDIO_CHANNELS.planTranslation, request),
    createTranslation: request => invoke(STUDIO_CHANNELS.createTranslation, request),
    cancelTask: request => invoke(STUDIO_CHANNELS.cancelTask, request),
    resumeTask: request => invoke(STUDIO_CHANNELS.resumeTask, request),
    previewBilingual: request => invoke(STUDIO_CHANNELS.previewBilingual, request),
    applyBilingual: request => invoke(STUDIO_CHANNELS.applyBilingual, request),
    removeTranslationTrack: request => invoke(STUDIO_CHANNELS.removeTranslationTrack, request),
    subscribe: listener => {
      if (typeof capability !== 'string') return () => {};
      const receive = (_event: unknown, input: unknown) => {
        if (!input || typeof input !== 'object' || !('capability' in input) || input.capability !== capability || !('event' in input)) return;
        const parsed = studioEventSchema.safeParse(input.event);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(STUDIO_CHANNELS.changed, receive);
      return () => { ipc.removeListener(STUDIO_CHANNELS.changed, receive); };
    },
  } satisfies SubtitleStudioApi);
}
