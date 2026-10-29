import { MEDIA_CONVERTER_CHANNELS, mediaConverterEventSchema } from '../../src/media-converter/channels';
import { QUEUE_LIMITS, type AddFilesResult, type MediaConverterApi, type MediaConverterResult } from '../../src/media-converter/contract';

type ChangeListener = (event: unknown, payload: unknown) => void;

/** The part of `ipcRenderer` the API uses. */
export interface MediaConverterIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<any>;
  on(channel: string, listener: ChangeListener): unknown;
  removeListener(channel: string, listener: ChangeListener): unknown;
}

/** Electron's `webUtils`: the path behind a dropped `File` ('' when it has none on disk); it throws for anything that is not a `File`. */
export interface MediaConverterFilePaths {
  getPathForFile(file: File): string;
}

const MAX_PATH_CHARS = 32_767;
const invalidRequest = { ok: false, error: { code: 'invalid_request' } } as const;
const nameOf = (file: unknown) => {
  const name = (file as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name.slice(0, 1024) : '—';
};

/** The main process's answer to the paths it got, with what the preload refused or left out itself. */
function withLocalOutcome(result: MediaConverterResult<AddFilesResult>, rejected: AddFilesResult['rejected'], truncated: number): MediaConverterResult<AddFilesResult> {
  if (result?.ok !== true || typeof result.value !== 'object' || result.value === null) return result;
  const value = result.value;
  return {
    ok: true,
    value: {
      ...value,
      rejected: [...(Array.isArray(value.rejected) ? value.rejected : []), ...rejected],
      truncated: (Number.isSafeInteger(value.truncated) ? value.truncated : 0) + truncated,
    },
  };
}

/**
 * `window.mediaConverter` (module-engine design §8): one method per request channel, `supported`,
 * and the change event subscription; events that fail the schema are dropped. No method takes a
 * path from the renderer: a drop hands over its `File`s, whose paths are read here synchronously,
 * before anything awaits (the drop owns them, FK-PIT-0098), and only the first 100 are sent; the
 * dialogs run in the main process.
 */
export function createMediaConverterApi(ipc: MediaConverterIpcRenderer, files: MediaConverterFilePaths, platform: string = process.platform): MediaConverterApi {
  const C = MEDIA_CONVERTER_CHANNELS;
  return Object.freeze({
    supported: platform === 'win32',
    getSnapshot: () => ipc.invoke(C.getSnapshot, {}),
    addDroppedFiles: dropped => {
      if (!Array.isArray(dropped) || dropped.length === 0) return Promise.resolve(invalidRequest);
      const limit = QUEUE_LIMITS.filesPerAdd;
      const paths: string[] = [];
      const rejected: AddFilesResult['rejected'] = [];
      for (const file of dropped.slice(0, limit)) {
        let filePath: unknown;
        try { filePath = files.getPathForFile(file); } catch { filePath = undefined; }
        if (typeof filePath === 'string' && filePath.length > 0 && filePath.length <= MAX_PATH_CHARS && !filePath.includes('\0')) paths.push(filePath);
        else rejected.push({ displayName: nameOf(file), code: 'file_unavailable' });
      }
      const truncated = dropped.length - Math.min(dropped.length, limit);
      if (!paths.length) return Promise.resolve({ ok: true, value: { added: [], duplicates: [], rejected, truncated } });
      return ipc.invoke(C.addDroppedFiles, { paths }).then(result => withLocalOutcome(result, rejected, truncated));
    },
    pickFiles: request => ipc.invoke(C.pickFiles, request),
    pickOutputDirectory: () => ipc.invoke(C.pickOutputDirectory, {}),
    previewPlan: request => ipc.invoke(C.previewPlan, request),
    start: request => ipc.invoke(C.start, request),
    cancel: request => ipc.invoke(C.cancel, request),
    remove: request => ipc.invoke(C.remove, request),
    retry: request => ipc.invoke(C.retry, request),
    clear: request => ipc.invoke(C.clear, request),
    revealOutput: request => ipc.invoke(C.revealOutput, request),
    setOptions: request => ipc.invoke(C.setOptions, request),
    redetectCapabilities: () => ipc.invoke(C.redetectCapabilities, {}),
    onChanged: listener => {
      const handler: ChangeListener = (_event, payload) => {
        const parsed = mediaConverterEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(C.changed, handler);
      return () => {
        ipc.removeListener(C.changed, handler);
      };
    },
  } satisfies MediaConverterApi);
}
