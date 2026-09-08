import { STUDIO_CHANNELS, type SubtitleStudioApi } from '../../src/subtitle-studio/ipc-contract';
import { isPublicStudioChannel } from './subtitle-studio-channel-policy';

export function createSubtitleStudioApi(ipc: { sendSync(channel: string, payload: unknown): unknown; invoke(channel: string, payload: unknown): Promise<any> }): SubtitleStudioApi {
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
  } satisfies SubtitleStudioApi);
}
