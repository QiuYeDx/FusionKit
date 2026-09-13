import { STUDIO_CHANNELS, studioEventSchema, requestSchemas, droppedSubtitlesRequestSchema, droppedTranscriptionMediaRequestSchema, type SubtitleStudioApi } from '../../src/subtitle-studio/ipc-contract';
import { isPublicStudioChannel } from './subtitle-studio-channel-policy';

export function createSubtitleStudioApi(ipc: { sendSync(channel: string, payload: unknown): unknown; invoke(channel: string, payload: unknown): Promise<any>; on(channel: string, listener: (event: unknown, input: any) => void): unknown; removeListener(channel: string, listener: (event: unknown, input: any) => void): unknown }, webUtils?: { getPathForFile(file: File): string }): SubtitleStudioApi {
  const capability = ipc.sendSync(STUDIO_CHANNELS.register, {});
  const invoke = (channel: string, payload: unknown) => {
    if (typeof capability !== 'string' || !isPublicStudioChannel(channel)) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
    return ipc.invoke(channel, { capability, payload });
  };
  return Object.freeze({
    revealSource: request => invoke(STUDIO_CHANNELS.revealSource, request),
    getSourceLocation: request => invoke(STUDIO_CHANNELS.getSourceLocation, request),
    selectSourceDirectory: request => invoke(STUDIO_CHANNELS.selectSourceDirectory, request),
    importDroppedSubtitles: (files, request) => {
      if (typeof capability !== 'string' || !webUtils) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
      if (!Array.isArray(files) || !files.length || files.length > 100 || !requestSchemas.importSubtitles.safeParse(request).success) return Promise.resolve({ ok: false, error: files?.length > 100 ? 'limit_exceeded' : 'invalid_input' } as const);
      // Capture all native paths before yielding: FileList lifetime belongs to the drop.
      let paths: string[];
      try { paths = files.map(file => webUtils.getPathForFile(file)); }
      catch { return Promise.resolve({ ok: false, error: 'access_denied' } as const); }
      const parsed = droppedSubtitlesRequestSchema.safeParse({ ...request, paths });
      if (!parsed.success) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
      return ipc.invoke(STUDIO_CHANNELS.importDroppedSubtitles, { capability, payload: parsed.data });
    },
    listTranslationTasks: request => invoke(STUDIO_CHANNELS.listTranslationTasks, request),
    selectTranscriptionMedia: request => invoke(STUDIO_CHANNELS.selectTranscriptionMedia, request),
    dropTranscriptionMedia: files => {
      if (typeof capability !== 'string' || !webUtils) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
      if (!Array.isArray(files) || !files.length || files.length > 20) return Promise.resolve({ ok: false, error: files?.length > 20 ? 'limit_exceeded' : 'invalid_input' } as const);
      let paths: string[];
      // File objects belong to this drop; consume every native handle before awaiting.
      try { paths = files.map(file => webUtils.getPathForFile(file)); }
      catch { return Promise.resolve({ ok: false, error: 'access_denied' } as const); }
      const parsed = droppedTranscriptionMediaRequestSchema.safeParse({ paths });
      if (!parsed.success) return Promise.resolve({ ok: false, error: 'access_denied' } as const);
      return ipc.invoke(STUDIO_CHANNELS.dropTranscriptionMedia, { capability, payload: parsed.data });
    },
    probeTranscriptionMedia: request => invoke(STUDIO_CHANNELS.probeTranscriptionMedia, request),
    revokeTranscriptionMedia: request => invoke(STUDIO_CHANNELS.revokeTranscriptionMedia, request),
    inspectTranscriptionRuntime: request => invoke(STUDIO_CHANNELS.inspectTranscriptionRuntime, request),
    listTranscriptionResources: request => invoke(STUDIO_CHANNELS.listTranscriptionResources, request),
    importTranscriptionModel: request => invoke(STUDIO_CHANNELS.importTranscriptionModel, request),
    installTranscriptionResource: request => invoke(STUDIO_CHANNELS.installTranscriptionResource, request),
    deleteTranscriptionResource: request => invoke(STUDIO_CHANNELS.deleteTranscriptionResource, request),
    cancelTranscriptionResourceJob: request => invoke(STUDIO_CHANNELS.cancelTranscriptionResourceJob, request),
    enqueueTranscription: request => invoke(STUDIO_CHANNELS.enqueueTranscription, request),
    listTranscriptionTasks: request => invoke(STUDIO_CHANNELS.listTranscriptionTasks, request),
    cancelTranscriptionTask: request => invoke(STUDIO_CHANNELS.cancelTranscriptionTask, request),
    removeTranscriptionTask: request => invoke(STUDIO_CHANNELS.removeTranscriptionTask, request),
    importSubtitle: request => invoke(STUDIO_CHANNELS.importSubtitle, request),
    importSubtitles: request => invoke(STUDIO_CHANNELS.importSubtitles, request),
    revealUnavailable: request => invoke(STUDIO_CHANNELS.revealUnavailable, request),
    deleteUnavailable: request => invoke(STUDIO_CHANNELS.deleteUnavailable, request),
    planTranslationBatch: request => invoke(STUDIO_CHANNELS.planTranslationBatch, request),
    createTranslationBatch: request => invoke(STUDIO_CHANNELS.createTranslationBatch, request),
    planExportBatch: request => invoke(STUDIO_CHANNELS.planExportBatch, request),
    exportBatch: request => invoke(STUDIO_CHANNELS.exportBatch, request),
    exportSources: request => invoke(STUDIO_CHANNELS.exportSources, request),
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
